'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const errorHandler = require('../backend/src/middleware/errorHandler');
const {
  buildNpmInvocation,
  canConnect,
  createOutput,
  inspectNgrok,
  inspectStack,
  isWebReady,
  ngrokCommand,
  parseApiHealth,
  parseArgs,
  parseEnvValue,
  readStartupContext,
  renderPreview,
  runDevLauncher,
  sanitizeDiagnostic,
  spawnManagedNgrok,
  startCallbackProxy,
  stopCallbackProxy,
  stopDevelopmentServices,
  stopProcessTree,
  summarizeNgrokLine,
  translateChildLine,
  waitForHttp,
  waitForNgrok,
} = require('./dev-launcher');

function captureOutput() {
  let text = '';
  return {
    output: createOutput({ stream: { write: (value) => { text += value; } }, color: false }),
    read: () => text,
  };
}

test('argument parsing supports preview and redirected output', () => {
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
  for (const redirect of [
    'https://reserved.example.dev/api/qbo/other',
    'http://reserved.example.dev/api/qbo/callback',
    'https://reserved.example.dev/api/qbo/callback?code=fixture',
  ]) {
    assert.equal(readStartupContext({ env: { QBO_REDIRECT_URI: redirect }, readFile: () => '' }).callbackOrigin, '');
  }
});

test('ngrok inspection requires the protected gateway target', async () => {
  const context = { callbackOrigin: 'https://reserved.example.dev', apiPort: 3001, proxyPort: 4567 };
  const result = await inspectNgrok(context, {
    installed: true,
    request: async () => ({
      ok: true,
      body: JSON.stringify({ tunnels: [{ public_url: 'https://reserved.example.dev', config: { addr: 'http://localhost:4567' } }] }),
    }),
  });
  assert.deepEqual(result, { installed: true, configured: true, online: true });
  assert.equal(ngrokCommand(context), 'ngrok http 4567 --url https://reserved.example.dev');
  const unsafe = await inspectNgrok(context, {
    installed: true,
    request: async () => ({ ok: true, body: JSON.stringify({ tunnels: [{ public_url: context.callbackOrigin, config: { addr: 'http://localhost:3001' } }] }) }),
  });
  assert.deepEqual(unsafe, { installed: true, configured: true, online: false, conflict: true });
});

test('a tunnel to the API port cannot be called ready without a protected gateway', async () => {
  const result = await inspectNgrok({ callbackOrigin: 'https://reserved.example.dev', apiPort: 3001 }, {
    installed: true,
    request: async () => ({ ok: true, body: JSON.stringify({ tunnels: [{
      public_url: 'https://reserved.example.dev', config: { addr: 'http://localhost:3001' },
    }] }) }),
  });
  assert.deepEqual(result, { installed: true, configured: true, online: false, conflict: true });
});

test('an orphaned local tunnel target can be recovered without taking over a live service', async () => {
  const context = { callbackOrigin: 'https://reserved.example.dev', apiPort: 3001, webPort: 5173 };
  const request = async () => ({ ok: true, body: JSON.stringify({ tunnels: [{
    public_url: context.callbackOrigin, config: { addr: 'http://localhost:58684' },
  }] }) });
  const stale = await inspectNgrok(context, { installed: true, request, connect: async () => false });
  assert.equal(stale.staleTargetPort, 58684);
  const occupied = await inspectNgrok(context, { installed: true, request, connect: async () => true });
  assert.equal(occupied.unverified, true);
  assert.equal(occupied.staleTargetPort, undefined);
  const ipv6 = await inspectNgrok(context, {
    installed: true,
    request: async () => ({ ok: true, body: JSON.stringify({ tunnels: [{
      public_url: context.callbackOrigin, config: { addr: 'http://[::1]:58684' },
    }] }) }),
    connect: async () => false,
  });
  assert.equal(ipv6.conflict, true);
  assert.equal(ipv6.staleTargetPort, undefined);
});

test('protected callback gateway rejects every other route and method', async (t) => {
  let upstreamHits = 0;
  const upstream = require('node:http').createServer((request, response) => {
    upstreamHits += 1;
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(request.url);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const gateway = await startCallbackProxy({ apiPort: upstream.address().port });
  t.after(async () => { assert.equal((await stopCallbackProxy(gateway.server)).ok, true); });
  const base = `http://127.0.0.1:${gateway.port}`;
  assert.equal((await fetch(`http://[::1]:${gateway.port}/api/auth/dev-access`)).status, 404);
  assert.equal((await fetch(`${base}/api/auth/dev-access`)).status, 404);
  assert.equal((await fetch(`${base}/api/qbo/callback/extra`)).status, 404);
  assert.equal((await fetch(`${base}/api/qbo/callback`, { method: 'POST' })).status, 404);
  assert.equal(upstreamHits, 0);
  const callback = await fetch(`${base}/api/qbo/callback?code=fixture&state=fixture&realmId=fixture`);
  assert.equal(callback.status, 200);
  assert.equal(await callback.text(), '/api/qbo/callback?code=fixture&state=fixture&realmId=fixture');
  assert.equal(upstreamHits, 1);
});

test('preview explains production risk and automatic tunnel startup', () => {
  const capture = captureOutput();
  renderPreview(capture.output, {
    apiPort: 3001,
    webPort: 5173,
    qboEnvironment: 'production',
    callbackOrigin: 'https://reserved.example.dev',
  }, { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' });
  const text = capture.read();
  assert.match(text, /Test Data Lab/);
  assert.match(text, /PRODUCTION · REAL QUICKBOOKS COMPANY/);
  assert.match(text, /Startup preview — no services started or checked/);
  assert.match(text, /Would prepare the QuickBooks sign-in return path/);
  assert.doesNotMatch(text, /MongoDB connected|API ready|App: ready — website/);
  assert.doesNotMatch(text, /must-not-appear/);
});

test('production reads as a celebration and QuickBooks labels do not use error red', () => {
  let rendered = '';
  const output = createOutput({ stream: { write: (value) => { rendered += value; } }, color: true });
  output.celebrate('✨ PRODUCTION · REAL QUICKBOOKS COMPANY');
  output.success('QuickBooks sign-in route is set up', 'qbo');
  assert.match(rendered, /\u001b\[1;38;2;/);
  assert.match(rendered, /\u001b\[36;1m QBO /);
  assert.doesNotMatch(rendered, /\u001b\[31;1m QBO /);
  assert.match(rendered.replace(/\u001b\[[0-9;]*m/g, ''), /PRODUCTION · REAL QUICKBOOKS COMPANY/);
});

test('managed ngrok uses the configured callback origin without a shell', () => {
  let invocation;
  spawnManagedNgrok({ apiPort: 3001, proxyPort: 4567, callbackOrigin: 'https://reserved.example.dev' }, {
    spawnFn: (command, args, options) => { invocation = { command, args, options }; },
  });
  assert.equal(invocation.command, 'ngrok');
  assert.deepEqual(invocation.args, ['http', '4567', '--url', 'https://reserved.example.dev']);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('ngrok diagnostics expose only an error code and safe cause', () => {
  const detail = summarizeNgrokLine('ERROR: authentication failed: authtoken=private-value ERR_NGROK_108');
  assert.equal(detail, 'ERR_NGROK_108 (authentication or account setup)');
  assert.equal(summarizeNgrokLine('session started for company@example.test'), '');
});

test('readiness requires this app and a connected database', () => {
  assert.deepEqual(parseApiHealth({ status: 200, body: '{"status":"ok"}' }), { isApp: false, ready: false });
  assert.deepEqual(parseApiHealth({ status: 503, body: '{"app":"test-data-lab","status":"unavailable","database":"disconnected"}' }), { isApp: true, ready: false });
  assert.deepEqual(parseApiHealth({ status: 200, body: '{"app":"test-data-lab","status":"ok","database":"connected"}' }), { isApp: true, ready: true });
  assert.equal(isWebReady({ status: 200, body: '<title>Another app</title>' }), false);
  assert.equal(isWebReady({ status: 200, body: '<title>Test Data Lab</title>' }), true);
});

test('tunnel readiness waits for the matching tunnel and stops on child failure', async () => {
  const child = { exitCode: null };
  let inspections = 0;
  const ready = await waitForNgrok({ callbackOrigin: 'https://reserved.example.dev' }, child, {
    inspect: async () => ({ online: ++inspections === 2 }),
    pollMs: 0,
  });
  assert.equal(ready.online, true);
  assert.equal(inspections, 2);
  await assert.rejects(waitForNgrok({}, { exitCode: 1 }), /stopped before its tunnel was ready/);
});

test('fresh startup includes an owned tunnel after the API and web are ready', async (t) => {
  const capture = captureOutput();
  const child = () => Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const initialSignals = new Set(process.listeners('SIGINT'));
  const initialTerms = new Set(process.listeners('SIGTERM'));
  const npmScripts = [];
  let tunnelStarts = 0;
  let inspections = 0;
  t.after(() => {
    for (const listener of process.listeners('SIGINT')) if (!initialSignals.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!initialTerms.has(listener)) process.removeListener('SIGTERM', listener);
  });
  const result = await runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false, verbose: true },
    output: capture.output,
    context: { apiPort: 3001, webPort: 5173, qboEnvironment: 'production', callbackOrigin: 'https://reserved.example.dev' },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: false, webConnected: false, apiIsApp: false, webIsApp: false }),
    inspectNgrok: async () => ({ installed: true, configured: true, online: ++inspections > 2 }),
    startCallbackProxy: async () => ({ server: {}, port: 4567 }),
    stopCallbackProxy: async () => ({ ok: true }),
    spawnNpm: (name) => { npmScripts.push(name); return child(); },
    spawnNgrok: () => { tunnelStarts += 1; return child(); },
    waitForHttp: async () => ({ elapsedMs: 1 }),
  });
  assert.deepEqual(npmScripts, ['dev:backend', 'dev:frontend']);
  assert.equal(tunnelStarts, 1);
  assert.equal(result.ngrok.online, true);
  assert.deepEqual(result.children.map((entry) => entry.label), ['API', 'Web app', 'Protected callback gateway', 'ngrok tunnel']);
  assert.match(capture.read(), /QuickBooks sign-in link is ready/);
  result.children[0].child.stdout.write('QBO_CLIENT_SECRET=private-value\n');
  result.children[0].child.stdout.write('Customer Jane Doe opened an invoice\n');
  result.children[0].child.stderr.write('Error: Customer Jane Doe private-value\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(capture.read(), /\[stdout\] Customer Jane Doe opened an invoice/);
  assert.match(capture.read(), /\[stdout\] QBO_CLIENT_SECRET=\[redacted\]/);
  assert.match(capture.read(), /Customer Jane Doe opened an invoice/);
  assert.match(capture.read(), /\[stderr\] Error: Customer Jane Doe private-value/);
  assert.equal((capture.read().match(/Customer Jane Doe private-value/g) || []).length, 1);
  assert.doesNotMatch(capture.read(), /QBO_CLIENT_SECRET=private-value/);
  for (const entry of result.children) {
    entry.child.stdout?.destroy();
    entry.child.stderr?.destroy();
  }
});

test('fresh startup restores a stale protected tunnel without claiming its ngrok process', async (t) => {
  const capture = captureOutput();
  const initialSignals = new Set(process.listeners('SIGINT'));
  const initialTerms = new Set(process.listeners('SIGTERM'));
  const child = () => Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
  });
  let requestedPort;
  let tunnelStarts = 0;
  t.after(() => {
    for (const listener of process.listeners('SIGINT')) if (!initialSignals.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!initialTerms.has(listener)) process.removeListener('SIGTERM', listener);
  });
  const result = await runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false },
    output: capture.output,
    context: { apiPort: 3001, webPort: 5173, qboEnvironment: 'production', callbackOrigin: 'https://reserved.example.dev' },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: false, webConnected: false }),
    inspectNgrok: async (context) => context.proxyPort
      ? { installed: true, configured: true, online: true }
      : { installed: true, configured: true, online: false, staleTargetPort: 58684 },
    startCallbackProxy: async (context) => {
      requestedPort = context.proxyPort;
      return { server: {}, port: context.proxyPort };
    },
    stopCallbackProxy: async () => ({ ok: true }),
    spawnNpm: () => child(),
    spawnNgrok: () => { tunnelStarts += 1; return child(); },
    waitForHttp: async () => ({ elapsedMs: 1 }),
  });
  assert.equal(requestedPort, 58684);
  assert.equal(tunnelStarts, 0);
  assert.equal(result.ngrok.online, true);
  assert.deepEqual(result.children.map((entry) => entry.label), ['API', 'Web app', 'Protected callback gateway']);
  assert.match(capture.read(), /reused QuickBooks sign-in link stays open after Ctrl\+C/);
  for (const entry of result.children) {
    entry.child.stdout?.destroy();
    entry.child.stderr?.destroy();
  }
});

test('ngrok failure shows raw diagnostic output and a cause while the core app stays ready', async (t) => {
  const capture = captureOutput();
  const initialSignals = new Set(process.listeners('SIGINT'));
  const initialTerms = new Set(process.listeners('SIGTERM'));
  const children = [];
  t.after(() => {
    for (const listener of process.listeners('SIGINT')) if (!initialSignals.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!initialTerms.has(listener)) process.removeListener('SIGTERM', listener);
    for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  });
  const result = await runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false, verbose: false },
    output: capture.output,
    context: { apiPort: 3001, webPort: 5173, qboEnvironment: 'production', callbackOrigin: 'https://reserved.example.dev' },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: false, webConnected: false, apiIsApp: false, webIsApp: false }),
    inspectNgrok: async () => ({ installed: true, configured: true, online: false }),
    startCallbackProxy: async () => ({ server: {}, port: 4567 }),
    stopCallbackProxy: async () => ({ ok: true }),
    spawnNpm: () => {
      const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      return child;
    },
    spawnNgrok: () => {
      const tunnel = Object.assign(new EventEmitter(), { pid: 124, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(tunnel);
      setImmediate(() => {
        tunnel.stderr.write('ERROR: authentication failed: authtoken=private-value ERR_NGROK_108\n');
        tunnel.exitCode = 1;
        tunnel.emit('exit', 1);
      });
      return tunnel;
    },
    stopFn: async () => ({ ok: true }),
    waitForHttp: async () => ({ elapsedMs: 1 }),
  });
  assert.equal(result.mode, 'running');
  assert.deepEqual(result.children.map((entry) => entry.label), ['API', 'Web app', 'Protected callback gateway']);
  assert.match(capture.read(), /Could not start the callback tunnel: ngrok stopped before its tunnel was ready/);
  assert.match(capture.read(), /ngrok reported: ERR_NGROK_108 \(authentication or account setup\)/);
  assert.match(capture.read(), /\[stderr\] ERROR: authentication failed: authtoken=\[redacted\] ERR_NGROK_108/);
  assert.doesNotMatch(capture.read(), /authtoken=private-value/);
  assert.match(capture.read(), /Run: ngrok http 4567 --url https:\/\/reserved\.example\.dev/);
});

test('ngrok spawn failure keeps the protected gateway in shutdown tracking', async (t) => {
  const capture = captureOutput();
  const initialSignals = new Set(process.listeners('SIGINT'));
  const initialTerms = new Set(process.listeners('SIGTERM'));
  const child = () => Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
  });
  let gatewayStops = 0;
  t.after(() => {
    for (const listener of process.listeners('SIGINT')) if (!initialSignals.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!initialTerms.has(listener)) process.removeListener('SIGTERM', listener);
  });
  const result = await runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false, verbose: false },
    output: capture.output,
    context: { apiPort: 3001, webPort: 5173, qboEnvironment: 'production', callbackOrigin: 'https://reserved.example.dev' },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: false, webConnected: false, apiIsApp: false, apiReady: false, webIsApp: false }),
    inspectNgrok: async () => ({ installed: true, configured: true, online: false }),
    startCallbackProxy: async () => ({ server: {}, port: 4567 }),
    stopCallbackProxy: async () => { gatewayStops += 1; return { ok: true }; },
    spawnNpm: child,
    spawnNgrok: () => { const error = new Error('private path'); error.code = 'ENOENT'; throw error; },
    waitForHttp: async () => ({ elapsedMs: 1 }),
  });
  assert.deepEqual(result.children.map((entry) => entry.label), ['API', 'Web app', 'Protected callback gateway']);
  assert.match(capture.read(), /Could not start the callback tunnel: ngrok executable was not found/);
  assert.doesNotMatch(capture.read(), /private path/);
  await stopDevelopmentServices(result.children, capture.output, { stopFn: async () => ({ ok: true }) });
  assert.equal(gatewayStops, 1);
  for (const entry of result.children) {
    entry.child.stdout?.destroy();
    entry.child.stderr?.destroy();
  }
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

test('multiline API failures show one safe context instead of repeated generic lines', () => {
  const state = {};
  const first = translateChildLine('api', '[company/health] live probe failed {', state, 'stderr');
  assert.deepEqual(first, { level: 'error', text: 'Company connection check failed; details hidden for privacy.' });
  assert.equal(translateChildLine('api', '  message: "private company detail",', state, 'stderr').skip, true);
  assert.equal(translateChildLine('api', '  at Function.run (private-file.js:12)', state, 'stderr').skip, true);
  assert.equal(translateChildLine('api', '}', state, 'stderr').skip, true);
  assert.equal(translateChildLine('api', '[company/health] live probe failed {', state, 'stderr').skip, true);
  const other = translateChildLine('api', '[company/snapshot] failed {', state, 'stderr');
  assert.deepEqual(other, { level: 'error', text: 'Company snapshot failed; details hidden for privacy.' });
  assert.equal(translateChildLine('api', 'private continuation without a trigger word', state, 'stderr').skip, true);
});

test('unhandled API failures expose a safe area, HTTP status, and reference', () => {
  const state = {};
  const result = translateChildLine('api', '[api/unhandled] area=company status=500 type=TypeError ref=fixture-123', state, 'stderr');
  assert.deepEqual(result, {
    level: 'error', text: 'Unexpected company request failed (HTTP 500, TypeError); reference fixture-123. Check the affected screen.',
  });
  assert.equal(translateChildLine('api', '[api/unhandled] area=company status=500 type=TypeError ref=fixture-456', state, 'stderr').text.includes('fixture-456'), true);
  assert.equal(translateChildLine('api', '[api/unhandled] area=company status=500 type=TypeError ref=fixture-123', state, 'stderr').skip, true);
  assert.deepEqual(translateChildLine('api', '[auth/login] Unauthorized', {}, 'stderr'), {
    level: 'error', text: 'Sign-in request failed; details hidden for privacy.',
  });
  assert.equal(translateChildLine('api', '[issuepacks/runs] timeout', {}, 'stderr').text,
    'Issue pack run list failed; details hidden for privacy.');
  assert.equal(translateChildLine('api', '[explore/timeline] timeout', {}, 'stderr').text,
    'Recent activity failed; details hidden for privacy.');
  assert.equal(translateChildLine('api', '[explore/read] timeout', {}, 'stderr').text,
    'Entity Explorer request failed; details hidden for privacy.');
  const privateResult = translateChildLine('api', 'Error: Customer Jane Doe token=private', {}, 'stderr');
  assert.match(privateResult.text, /Unclassified service error/);
  assert.doesNotMatch(privateResult.text, /Jane Doe|private/);
  assert.match(translateChildLine('api', 'TypeError: private customer detail', {}, 'stderr').text, /Unclassified service error/);
});

test('unhandled backend errors log their stack by default while redacting credentials', () => {
  const logged = [];
  const originalConsoleError = console.error;
  const originalRawFlag = process.env.TEST_DATA_LAB_RAW_ERRORS;
  let status;
  let body;
  delete process.env.TEST_DATA_LAB_RAW_ERRORS;
  console.error = (...parts) => { logged.push(parts.join(' ')); };
  try {
    errorHandler(
      Object.assign(new Error('Customer Jane Doe token=private'), { statusCode: 500 }),
      { originalUrl: '/api/company/secret?token=private', context: { requestId: 'fixture-123' } },
      { status(value) { status = value; return this; }, json(value) { body = value; } },
    );
  } finally {
    console.error = originalConsoleError;
    if (originalRawFlag === undefined) delete process.env.TEST_DATA_LAB_RAW_ERRORS;
    else process.env.TEST_DATA_LAB_RAW_ERRORS = originalRawFlag;
  }
  assert.equal(status, 500);
  assert.equal(body.requestId, 'fixture-123');
  assert.equal(logged.length, 2);
  assert.equal(logged[0], '[api/unhandled] area=company status=500 type=Error ref=fixture-123');
  assert.match(logged[1], /Customer Jane Doe/);
  assert.match(logged[1], /token=\[redacted\]/);
  assert.doesNotMatch(logged[1], /token=private/);
});

test('unhandled error detail is visible without a diagnostic flag', () => {
  const logged = [];
  const originalConsoleError = console.error;
  const error = new Error('specific detail');
  console.error = (...parts) => { logged.push(parts); };
  try {
    errorHandler(error, { originalUrl: '/api/company', context: {} }, {
      status() { return this; }, json() {},
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logged.length, 2);
  assert.match(logged[1][0], /specific detail/);
});

test('status entries include the local date and time', () => {
  let text = '';
  const output = createOutput({
    stream: { write: (value) => { text += value; } },
    color: false,
    now: () => new Date(2026, 8, 24, 5, 11, 17),
  });
  output.error('Unexpected company request failed (HTTP 500).', 'api');
  output.action('Check the affected screen.', 'api');
  assert.equal((text.match(/\[2026-09-24 05:11:17\]/g) || []).length, 2);
});

test('diagnostics redact credential-shaped values', () => {
  assert.equal(sanitizeDiagnostic('Authorization=secret-value'), 'Authorization=[redacted]');
  assert.equal(sanitizeDiagnostic('https://name:password@example.test/path'), 'https://[redacted]@example.test/path');
  assert.equal(sanitizeDiagnostic('account owner@example.test failed'), 'account [redacted email] failed');
  assert.equal(sanitizeDiagnostic('QBO_CLIENT_SECRET="secret value"'), 'QBO_CLIENT_SECRET=[redacted]');
  assert.equal(sanitizeDiagnostic('https://example.test/callback?code=private&state=private'), 'https://example.test/callback?code=[redacted]&state=[redacted]');
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

test('readiness rejects a different service even when it returns HTTP 200', async () => {
  await assert.rejects(
    waitForHttp('http://127.0.0.1:1/api/health', {
      request: async () => ({ ok: true, status: 200, body: '{"status":"ok"}' }),
      isReady: (response) => parseApiHealth(response).ready,
      label: 'API',
    }),
    /not a ready Test Data Lab service/
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
      status: 200,
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

test('Windows shutdown accepts taskkill 128 only when the child has already exited', async () => {
  let checks = 0;
  const stopped = await stopProcessTree({ pid: 1234, exitCode: null }, {
    platform: 'win32',
    isPidRunning: () => ++checks === 1,
    spawnFn: (command, args) => {
      assert.equal(command, 'taskkill.exe');
      assert.deepEqual(args, ['/PID', '1234', '/T', '/F']);
      const killer = new EventEmitter();
      killer.stderr = new EventEmitter();
      setImmediate(() => {
        killer.stderr.emit('data', 'ERROR: process no longer exists');
        killer.emit('close', 128);
      });
      return killer;
    },
  });
  assert.deepEqual(stopped, { ok: true, alreadyStopped: true });

  const stillRunning = await stopProcessTree({ pid: 1234, exitCode: null }, {
    platform: 'win32',
    isPidRunning: () => true,
    spawnFn: () => {
      const killer = new EventEmitter();
      killer.stderr = new EventEmitter();
      setImmediate(() => {
        killer.stderr.emit('data', 'ERROR: Access is denied.');
        killer.emit('close', 128);
      });
      return killer;
    },
  });
  assert.equal(stillRunning.ok, false);
  assert.match(stillRunning.error, /taskkill exited 128: ERROR: Access is denied/);
});

test('shutdown checks that a managed port closed before reporting success', async () => {
  const capture = captureOutput();
  const result = await stopDevelopmentServices([
    { child: { pid: 1234, exitCode: null }, label: 'Web app', source: 'web', port: 5173 },
  ], capture.output, {
    stopFn: async () => ({ ok: true }),
    isPortListening: async () => true,
    portCheckAttempts: 1,
  });
  assert.equal(result.ok, false);
  assert.match(capture.read(), /Web app port 5173 remains occupied/);
  assert.match(capture.read(), /⚠️  Shutdown incomplete/);
});

test('shutdown reports both Windows stop failures and occupied ports', async () => {
  const capture = captureOutput();
  const result = await stopDevelopmentServices([
    { child: { pid: 1234, exitCode: null }, label: 'Web app', source: 'web', port: 5173 },
  ], capture.output, {
    stopFn: async () => ({ ok: false, error: 'taskkill exited 128: Access is denied.' }),
    isPortListening: async () => true,
    portCheckAttempts: 1,
  });
  assert.equal(result.ok, false);
  assert.match(capture.read(), /Could not stop Web app: taskkill exited 128: Access is denied/);
  assert.match(capture.read(), /Web app port 5173 remains occupied/);
});

test('shutdown continues when one service stop or port check throws', async () => {
  const capture = captureOutput();
  const attempted = [];
  const result = await stopDevelopmentServices([
    { child: { pid: 1 }, label: 'API', source: 'api', port: 3001 },
    { child: { pid: 2 }, label: 'Web app', source: 'web', port: 5173 },
  ], capture.output, {
    stopFn: async (child) => {
      attempted.push(child.pid);
      if (child.pid === 2) throw new Error('stop failed');
      return { ok: true };
    },
    isPortListening: async (port) => {
      if (port === 5173) throw new Error('port check failed');
      return false;
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(attempted, [2, 1]);
  assert.match(capture.read(), /Could not stop Web app: stop failed/);
  assert.match(capture.read(), /Could not verify Web app port 5173: port check failed/);
  assert.match(capture.read(), /API stopped/);
});

test('a child exit and Ctrl+C share one shutdown before the launcher exits', async (t) => {
  const capture = captureOutput();
  const initialSignals = new Set(process.listeners('SIGINT'));
  const initialTerms = new Set(process.listeners('SIGTERM'));
  const previousExitCode = process.exitCode;
  const children = [];
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const exitCodes = [];
  let stopCalls = 0;
  t.after(() => {
    process.exitCode = previousExitCode;
    for (const listener of process.listeners('SIGINT')) if (!initialSignals.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!initialTerms.has(listener)) process.removeListener('SIGTERM', listener);
    for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  });
  const result = await runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false },
    output: capture.output,
    context: { apiPort: 3001, webPort: 5173, qboEnvironment: 'sandbox', callbackOrigin: '' },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: false, webConnected: false }),
    inspectNgrok: async () => ({ configured: false, online: false }),
    spawnNpm: () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 1234, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      });
      children.push(child);
      return child;
    },
    waitForHttp: async () => ({ elapsedMs: 1 }),
    stopFn: async () => { stopCalls += 1; await stopGate; return { ok: true }; },
    isPortListening: async () => false,
    exitProcess: (code) => { exitCodes.push(code); },
  });
  result.children[0].child.emit('exit', 1);
  const signal = process.listeners('SIGINT').find((listener) => !initialSignals.has(listener));
  assert.ok(signal);
  signal('SIGINT');
  assert.deepEqual(exitCodes, []);
  releaseStop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCalls, 2);
  assert.deepEqual(exitCodes, [1]);
  assert.match(capture.read(), /closed cleanly/);
});

test('Ctrl+C during API readiness cannot start an untracked web process', async (t) => {
  const capture = captureOutput();
  const initialSignals = new Set(process.listeners('SIGINT'));
  const initialTerms = new Set(process.listeners('SIGTERM'));
  const children = [];
  const scripts = [];
  const exitCodes = [];
  let resolveReady;
  let releaseStop;
  let apiSpawned;
  const readyGate = new Promise((resolve) => { resolveReady = resolve; });
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const spawned = new Promise((resolve) => { apiSpawned = resolve; });
  t.after(() => {
    for (const listener of process.listeners('SIGINT')) if (!initialSignals.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!initialTerms.has(listener)) process.removeListener('SIGTERM', listener);
    for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  });
  const launching = runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false },
    output: capture.output,
    context: { apiPort: 3001, webPort: 5173, qboEnvironment: 'sandbox', callbackOrigin: '' },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: false, webConnected: false }),
    inspectNgrok: async () => ({ configured: false, online: false }),
    spawnNpm: (name) => {
      scripts.push(name);
      const child = Object.assign(new EventEmitter(), {
        pid: 1234, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      });
      children.push(child);
      apiSpawned();
      return child;
    },
    waitForHttp: async () => readyGate,
    stopFn: async () => { await stopGate; return { ok: true }; },
    isPortListening: async () => false,
    exitProcess: (code) => { exitCodes.push(code); },
  });
  await spawned;
  const signal = process.listeners('SIGINT').find((listener) => !initialSignals.has(listener));
  assert.ok(signal);
  signal('SIGINT');
  resolveReady({ elapsedMs: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scripts, ['dev:backend']);
  assert.deepEqual(exitCodes, []);
  releaseStop();
  const result = await launching;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.mode, 'stopped');
  assert.deepEqual(scripts, ['dev:backend']);
  assert.deepEqual(exitCodes, [0]);
});

test('API exit during callback inspection cannot report the app ready', async (t) => {
  const capture = captureOutput();
  const initialSignals = new Set(process.listeners('SIGINT'));
  const initialTerms = new Set(process.listeners('SIGTERM'));
  const previousExitCode = process.exitCode;
  const children = [];
  let releaseInspection;
  let inspectionStarted;
  const inspectionGate = new Promise((resolve) => { releaseInspection = resolve; });
  const inspecting = new Promise((resolve) => { inspectionStarted = resolve; });
  let inspections = 0;
  let stops = 0;
  t.after(() => {
    process.exitCode = previousExitCode;
    for (const listener of process.listeners('SIGINT')) if (!initialSignals.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!initialTerms.has(listener)) process.removeListener('SIGTERM', listener);
    for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  });
  const launching = runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false },
    output: capture.output,
    context: { apiPort: 3001, webPort: 5173, qboEnvironment: 'sandbox', callbackOrigin: 'https://reserved.example.dev' },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: false, webConnected: false }),
    inspectNgrok: async () => {
      inspections += 1;
      if (inspections === 2) { inspectionStarted(); await inspectionGate; }
      return { configured: true, installed: true, online: true };
    },
    spawnNpm: () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 1234, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      });
      children.push(child);
      return child;
    },
    waitForHttp: async () => ({ elapsedMs: 1 }),
    startCallbackProxy: async () => ({ port: 4567, server: {} }),
    stopCallbackProxy: async () => ({ ok: true }),
    stopFn: async () => { stops += 1; return { ok: true }; },
    isPortListening: async () => false,
  });
  await inspecting;
  children[0].emit('exit', 1);
  releaseInspection();
  const result = await launching;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.mode, 'stopped');
  assert.equal(stops, 2);
  assert.match(capture.read(), /API stopped unexpectedly/);
  assert.doesNotMatch(capture.read(), /Test Data Lab is ready/);
});

test('Ctrl+C waits for an in-flight gateway and reports a failed close', async (t) => {
  const capture = captureOutput();
  const initialSignals = new Set(process.listeners('SIGINT'));
  const initialTerms = new Set(process.listeners('SIGTERM'));
  const children = [];
  const exitCodes = [];
  let releaseGateway;
  let gatewayStarted;
  const gatewayGate = new Promise((resolve) => { releaseGateway = resolve; });
  const startingGateway = new Promise((resolve) => { gatewayStarted = resolve; });
  t.after(() => {
    for (const listener of process.listeners('SIGINT')) if (!initialSignals.has(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!initialTerms.has(listener)) process.removeListener('SIGTERM', listener);
    for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  });
  const launching = runDevLauncher({
    parsed: { check: false, color: false, open: false, preview: false, quiet: false },
    output: capture.output,
    context: { apiPort: 3001, webPort: 5173, qboEnvironment: 'sandbox', callbackOrigin: 'https://reserved.example.dev' },
    identity: { branch: 'main', commit: '1234567', dirty: false, nodeVersion: '25.5.0' },
    inspectStack: async () => ({ apiConnected: false, webConnected: false }),
    inspectNgrok: async () => ({ configured: true, installed: true, online: false }),
    spawnNpm: () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 1234, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      });
      children.push(child);
      return child;
    },
    waitForHttp: async () => ({ elapsedMs: 1 }),
    startCallbackProxy: async () => { gatewayStarted(); await gatewayGate; return { port: 4567, server: {} }; },
    stopCallbackProxy: async () => ({ ok: false, error: 'close failed' }),
    stopFn: async () => ({ ok: true }),
    isPortListening: async () => false,
    exitProcess: (code) => { exitCodes.push(code); },
  });
  await startingGateway;
  const signal = process.listeners('SIGINT').find((listener) => !initialSignals.has(listener));
  assert.ok(signal);
  signal('SIGINT');
  assert.deepEqual(exitCodes, []);
  releaseGateway();
  const result = await launching;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.mode, 'stopped');
  assert.deepEqual(exitCodes, [1]);
  assert.match(capture.read(), /Could not stop Protected callback gateway: close failed/);
  assert.match(capture.read(), /Shutdown incomplete/);
  assert.doesNotMatch(capture.read(), /Test Data Lab is ready/);
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
    inspectStack: async () => ({ apiConnected: true, webConnected: true, apiIsApp: true, apiReady: true, webIsApp: true }),
    inspectNgrok: async () => ({ installed: true, configured: true, online: true }),
    spawnNpm: () => { spawnCalled = true; },
  });
  assert.equal(result.mode, 'already-running');
  assert.equal(spawnCalled, false);
  assert.match(capture.read(), /no duplicate processes were started/i);
});
