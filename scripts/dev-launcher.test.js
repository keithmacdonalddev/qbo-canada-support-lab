'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const {
  buildNpmInvocation,
  canConnect,
  createOutput,
  inspectNgrok,
  inspectStack,
  ngrokCommand,
  parseArgs,
  parseEnvValue,
  readStartupContext,
  renderPreview,
  runDevLauncher,
  sanitizeDiagnostic,
  stopDevelopmentServices,
  translateChildLine,
  waitForHttp,
} = require('./dev-launcher');

function captureOutput() {
  let text = '';
  return {
    output: createOutput({ stream: { write: (value) => { text += value; } }, color: false }),
    read: () => text,
  };
}

test('argument parsing supports preview and privacy-safe redirected output', () => {
  const parsed = parseArgs(['--preview', '--open'], { env: {}, stdoutIsTTY: false });
  assert.equal(parsed.preview, true);
  assert.equal(parsed.open, true);
  assert.equal(parsed.color, false);
});

test('startup context reads only operational values and derives the callback origin', () => {
  const context = readStartupContext({
    env: {},
    readFile: () => [
      'PORT=3001',
      'QBO_ENVIRONMENT=production',
      'QBO_REDIRECT_URI=https://reserved.example.dev/api/qbo/callback',
      'QBO_CLIENT_SECRET=must-not-appear',
    ].join('\n'),
  });
  assert.deepEqual(context, {
    apiPort: 3001,
    webPort: 5173,
    qboEnvironment: 'production',
    callbackOrigin: 'https://reserved.example.dev',
  });
  assert.equal(parseEnvValue('TOKEN=private\nPORT=3001', 'PORT'), '3001');
});

test('ngrok inspection matches the configured reserved origin', async () => {
  const context = { callbackOrigin: 'https://reserved.example.dev', apiPort: 3001 };
  const result = await inspectNgrok(context, {
    installed: true,
    request: async () => ({
      ok: true,
      body: JSON.stringify({ tunnels: [{ public_url: 'https://reserved.example.dev' }] }),
    }),
  });
  assert.deepEqual(result, { installed: true, configured: true, online: true });
  assert.equal(ngrokCommand(context), 'ngrok http 3001 --url https://reserved.example.dev');
});

test('preview explains production risk and the exact offline tunnel action', () => {
  const capture = captureOutput();
  renderPreview(capture.output, {
    apiPort: 3001,
    webPort: 5173,
    qboEnvironment: 'production',
    callbackOrigin: 'https://reserved.example.dev',
  }, { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' });
  const text = capture.read();
  assert.match(text, /Test Data Lab/);
  assert.match(text, /PRODUCTION mode/);
  assert.match(text, /ERR_NGROK_3200/);
  assert.match(text, /ngrok http 3001 --url https:\/\/reserved\.example\.dev/);
  assert.match(text, /close the failed authorization popup/);
  assert.doesNotMatch(text, /must-not-appear/);
});

test('child output translates meaningful milestones and hides framework noise', () => {
  const state = {};
  assert.deepEqual(translateChildLine('api', 'MongoDB connected: cluster.example'), {
    level: 'success', text: 'MongoDB connected',
  });
  assert.match(translateChildLine('api', '[issuepack-seeder] 5 built-in packs seeded').text, /5 legacy/);
  assert.equal(translateChildLine('web', 'VITE v8.0.7 ready in 293 ms').skip, true);
  assert.match(translateChildLine('api', '[nodemon] restarting due to changes...', state).text, /restarting/);
  assert.match(translateChildLine('api', 'Server running on port 3001', state).text, /restart complete/i);
});

test('diagnostics redact credential-shaped values', () => {
  assert.equal(sanitizeDiagnostic('Authorization=secret-value'), 'Authorization=[redacted]');
  assert.equal(sanitizeDiagnostic('https://name:password@example.test/path'), 'https://[redacted]@example.test/path');
  assert.equal(sanitizeDiagnostic('account owner@example.test failed'), 'account [redacted email] failed');
});

test('readiness stops immediately when a managed service fails', async () => {
  await assert.rejects(
    waitForHttp('http://127.0.0.1:1/api/health', {
      isFailed: () => true,
      label: 'API',
      timeoutMs: 10_000,
    }),
    /API stopped before becoming ready/
  );
});

test('managed npm scripts use the current npm CLI without a shell', () => {
  const invocation = buildNpmInvocation('dev:backend', {
    env: { npm_execpath: 'C:\\npm\\npm-cli.js' },
    execPath: 'C:\\node\\node.exe',
    existsSync: () => true,
  });
  assert.deepEqual(invocation, {
    command: 'C:\\node\\node.exe',
    args: ['C:\\npm\\npm-cli.js', 'run', 'dev:backend'],
  });
  assert.throws(() => buildNpmInvocation('dev:backend & whoami'), /Invalid npm script/);
});

test('TCP preflight detects an existing listener without changing it', async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(await canConnect({ host: '127.0.0.1', port: server.address().port }), true);
});

test('stack inspection accepts an IPv6-only localhost web listener', async () => {
  const context = { apiPort: 3001, webPort: 5173 };
  const result = await inspectStack(context, {
    connect: async ({ host, port }) => port === 5173 && host === '::1',
    request: async (url) => ({
      ok: true,
      body: url.endsWith('/') ? '<title>Test Data Lab</title>' : '{"status":"ok"}',
    }),
  });
  assert.equal(result.webConnected, true);
  assert.equal(result.webIsApp, true);
  assert.equal(result.apiConnected, false);
});

test('shutdown reports only launcher-owned service entries', async () => {
  const capture = captureOutput();
  const children = [
    { child: { pid: 10, exitCode: null }, label: 'API', source: 'api' },
    { child: { pid: 11, exitCode: null }, label: 'Web app', source: 'web' },
  ];
  const result = await stopDevelopmentServices(children, capture.output, {
    stopFn: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.ok(capture.read().indexOf('Web app stopped') < capture.read().indexOf('API stopped'));
  assert.match(capture.read(), /closed cleanly/);
});

test('a healthy existing stack is reused without spawning duplicate services', async () => {
  const capture = captureOutput();
  let spawnCalled = false;
  const result = await runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false, verbose: false },
    output: capture.output,
    context: {
      apiPort: 3001,
      webPort: 5173,
      qboEnvironment: 'production',
      callbackOrigin: 'https://reserved.example.dev',
    },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: true, webConnected: true, apiIsApp: true, webIsApp: true }),
    inspectNgrok: async () => ({ installed: true, configured: true, online: true }),
    spawnNpm: () => { spawnCalled = true; },
  });
  assert.equal(result.mode, 'already-running');
  assert.equal(spawnCalled, false);
  assert.match(capture.read(), /no duplicate processes were started/i);
});
