'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_API_PORT = 3001;
const DEFAULT_WEB_PORT = 5173;
const API_TIMEOUT_MS = 60_000;
const WEB_TIMEOUT_MS = 30_000;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(value) {
  return String(value || '').replace(ANSI_PATTERN, '');
}

function colorize(code, value, enabled) {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function parseArgs(argv = process.argv.slice(2), options = {}) {
  const env = options.env || process.env;
  const interactive = options.stdoutIsTTY === undefined
    ? process.stdout.isTTY === true
    : options.stdoutIsTTY === true;
  return {
    check: argv.includes('--check'),
    color: !argv.includes('--no-color') && !env.NO_COLOR && interactive,
    open: argv.includes('--open'),
    preview: argv.includes('--preview'),
    quiet: argv.includes('--quiet'),
    verbose: argv.includes('--verbose'),
  };
}

function createOutput({ stream = process.stdout, color = true, quiet = false } = {}) {
  const writeRaw = (value = '') => stream.write(`${value}\n`);
  const write = (value = '') => { if (!quiet) writeRaw(value); };
  const prefix = (source) => {
    if (source === 'api') return colorize('36;1', ' API ', color);
    if (source === 'web') return colorize('35;1', ' WEB ', color);
    if (source === 'qbo') return colorize('31;1', ' QBO ', color);
    return colorize('34;1', ' DEV ', color);
  };
  const colors = { error: '31;1', success: '32;1', warning: '33;1', info: '37', muted: '90' };

  return {
    blank: () => write(),
    banner() {
      write(`🚀 ${colorize('1;36', 'Test Data Lab', color)} ${colorize('90', '— development', color)}`);
      write(colorize('90', '   Safe startup · clear status · one-stop shutdown', color));
      write(colorize('36', '────────────────────────────────────────────────', color));
    },
    heading(value) { write(colorize('1', value, color)); },
    write,
    line(level, value, source = 'dev') {
      if (quiet && !['warning', 'error'].includes(level)) return;
      writeRaw(`${prefix(source)} ${colorize(colors[level] || colors.info, value, color)}`);
    },
    action(value, source = 'dev') {
      writeRaw(`${prefix(source)} ${colorize('90', `   Next: ${value}`, color)}`);
    },
    success(value, source) { this.line('success', value, source); },
    warning(value, source) { this.line('warning', value, source); },
    error(value, source) { this.line('error', value, source); },
    info(value, source) { this.line('info', value, source); },
    muted(value, source) { this.line('muted', value, source); },
  };
}

function formatDuration(durationMs) {
  const value = Math.max(0, Number(durationMs) || 0);
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

function sanitizeSingleLine(value, fallback = 'unknown') {
  const line = String(value || '').split(/\r?\n/, 1)[0].trim();
  return line && /^[a-z0-9._\/-]+$/i.test(line) ? line.slice(0, 80) : fallback;
}

function sanitizeDiagnostic(value, fallback = 'check did not pass') {
  const text = String(value || fallback)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/:\/\/[^\s:/]+:[^\s@/]+@/g, '://[redacted]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|secret)\s*[:=]\s*["']?[^\s,"';]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk|key)-[a-z0-9_-]{12,}\b/gi, '[redacted key]')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (text || fallback).slice(0, 240);
}

function getRuntimeIdentity(options = {}) {
  const execFile = options.execFile || execFileSync;
  const runGit = (args) => {
    try {
      return String(execFile('git', args, {
        cwd: options.cwd || REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }) || '');
    } catch {
      return '';
    }
  };
  const branch = sanitizeSingleLine(runGit(['rev-parse', '--abbrev-ref', 'HEAD']), 'unknown-branch');
  return {
    branch: branch === 'HEAD' ? 'detached' : branch,
    commit: sanitizeSingleLine(runGit(['rev-parse', '--short=7', 'HEAD']), 'unknown'),
    dirty: runGit(['status', '--porcelain']).trim().length > 0,
    nodeVersion: sanitizeSingleLine(options.nodeVersion || process.versions.node),
  };
}

function parseEnvValue(contents, key) {
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)\\s*$`);
  for (const rawLine of String(contents || '').split(/\r?\n/)) {
    if (!rawLine || rawLine.trimStart().startsWith('#')) continue;
    const match = rawLine.match(matcher);
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}

function parsePort(value, fallback, label) {
  const text = String(value || fallback).trim();
  const port = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be a number from 1 to 65535.`);
  }
  return port;
}

function readStartupContext(options = {}) {
  const readFile = options.readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  let contents = '';
  try {
    contents = readFile(path.join(options.root || REPO_ROOT, '.env'));
  } catch {
    // The backend owns the authoritative missing configuration error.
  }
  const qboEnvironment = (options.env?.QBO_ENVIRONMENT
    || parseEnvValue(contents, 'QBO_ENVIRONMENT')
    || 'sandbox').toLowerCase();
  const redirectUri = options.env?.QBO_REDIRECT_URI || parseEnvValue(contents, 'QBO_REDIRECT_URI');
  let callbackOrigin = '';
  try {
    callbackOrigin = redirectUri ? new URL(redirectUri).origin : '';
  } catch {
    callbackOrigin = '';
  }
  return {
    apiPort: parsePort(options.env?.PORT || parseEnvValue(contents, 'PORT'), DEFAULT_API_PORT, 'API port'),
    webPort: DEFAULT_WEB_PORT,
    qboEnvironment,
    callbackOrigin,
  };
}

function requestHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs || 1000;
  return new Promise((resolve) => {
    const request = http.get(url, { headers: { Accept: 'application/json,text/html' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (body.length < 100_000) body += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 400, status: response.statusCode, body }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('request timed out')));
    request.once('error', (error) => resolve({ ok: false, status: 0, body: '', error: error.message }));
  });
}

function canConnect({ host = '127.0.0.1', port, timeoutMs = 400, socketFactory = () => new net.Socket() }) {
  return new Promise((resolve) => {
    const socket = socketFactory();
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function inspectStack(context, options = {}) {
  const connect = options.connect || canConnect;
  const request = options.request || requestHttp;
  const loopbackIsListening = async (port) => {
    const results = await Promise.all([
      connect({ host: '127.0.0.1', port }),
      connect({ host: '::1', port }),
    ]);
    return results.some(Boolean);
  };
  const [apiConnected, webConnected] = await Promise.all([
    loopbackIsListening(context.apiPort),
    loopbackIsListening(context.webPort),
  ]);
  const [apiResponse, webResponse] = await Promise.all([
    apiConnected ? request(`http://localhost:${context.apiPort}/api/health`) : null,
    webConnected ? request(`http://localhost:${context.webPort}/`) : null,
  ]);
  let apiIsApp = false;
  try { apiIsApp = apiResponse?.ok && JSON.parse(apiResponse.body).status === 'ok'; } catch { /* not this API */ }
  const webIsApp = Boolean(webResponse?.ok && /<title>Test Data Lab<\/title>/i.test(webResponse.body));
  return { apiConnected, webConnected, apiIsApp, webIsApp };
}

function isCommandAvailable(command, options = {}) {
  try {
    (options.execFile || execFileSync)(command, ['version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function inspectNgrok(context, options = {}) {
  const installed = options.installed === undefined
    ? isCommandAvailable('ngrok', options)
    : options.installed;
  if (!context.callbackOrigin) return { installed, configured: false, online: false };
  const response = await (options.request || requestHttp)('http://127.0.0.1:4040/api/tunnels', { timeoutMs: 700 });
  if (!response.ok) return { installed, configured: true, online: false };
  try {
    const tunnels = JSON.parse(response.body).tunnels || [];
    const online = tunnels.some((tunnel) => {
      try { return new URL(tunnel.public_url).origin === context.callbackOrigin; } catch { return false; }
    });
    return { installed, configured: true, online };
  } catch {
    return { installed, configured: true, online: false };
  }
}

function ngrokCommand(context) {
  return context.callbackOrigin ? `ngrok http ${context.apiPort} --url ${context.callbackOrigin}` : '';
}

function renderQboReadiness(output, context, ngrok) {
  output.blank();
  output.heading('🔐 Production connection readiness');
  if (context.qboEnvironment === 'production') {
    output.warning('PRODUCTION mode — approved write actions affect the real connected company.', 'qbo');
  } else {
    output.info(`QuickBooks environment: ${context.qboEnvironment.toUpperCase()}`, 'qbo');
  }

  if (!ngrok.configured) {
    output.warning('OAuth callback URL is not configured; connect/reconnect cannot finish.', 'qbo');
    output.action('Set QBO_REDIRECT_URI to the registered HTTPS callback URL.', 'qbo');
    return;
  }
  if (ngrok.online) {
    output.success(`OAuth callback tunnel is online at ${context.callbackOrigin}`, 'qbo');
    output.muted('The tunnel is needed only while connecting or reconnecting QuickBooks.', 'qbo');
    return;
  }

  output.warning('OAuth callback tunnel is offline. The app still runs, but connect/reconnect will fail with ERR_NGROK_3200.', 'qbo');
  if (!ngrok.installed) output.warning('ngrok is not available on PATH.', 'qbo');
  output.action(`Open a separate PowerShell window and run: ${ngrokCommand(context)}`, 'qbo');
  output.muted('Leave that window open, close the failed authorization popup, then click Connect again.', 'qbo');
  output.muted('Normal app use does not need ngrok after the connection is established.', 'qbo');
}

function buildNpmInvocation(scriptName, options = {}) {
  if (!/^[a-z0-9:_-]+$/i.test(scriptName)) throw new Error('Invalid npm script name.');
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const exists = options.existsSync || fs.existsSync;
  if (env.npm_execpath && exists(env.npm_execpath)) {
    return { command: execPath, args: [env.npm_execpath, 'run', scriptName] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', scriptName] };
}

function spawnManagedNpm(scriptName, options = {}) {
  const invocation = buildNpmInvocation(scriptName, options);
  return (options.spawnFn || spawn)(invocation.command, invocation.args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    shell: false,
    windowsHide: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
}

function translateChildLine(source, rawLine, state = {}, stream = 'stdout') {
  const line = stripAnsi(rawLine).trim();
  if (!line || line.startsWith('> ') || /^\[(nodemon|vite)\] to restart/i.test(line)) return { skip: true };
  if (/\[nodemon\] (\d+\.\d+\.\d+|watching|starting)/i.test(line)) return { skip: true };
  if (/\[nodemon\] restarting due to changes/i.test(line)) {
    state.apiRestarting = true;
    return { level: 'info', text: 'Server code changed — restarting the API safely…' };
  }
  if (/MongoDB DNS override/i.test(line)) return { level: 'info', text: 'MongoDB DNS fallback configured' };
  if (/MongoDB connected/i.test(line)) {
    state.databaseReady = true;
    return { level: 'success', text: 'MongoDB connected' };
  }
  const packs = line.match(/\[issuepack-seeder\]\s+(\d+) built-in packs seeded/i);
  if (packs) return { level: 'success', text: `${packs[1]} legacy issue-pack definitions ready` };
  const recovered = line.match(/\[startup\]\s+Recovered\s+(\d+) stale/i);
  if (recovered) return { level: 'warning', text: `Recovered ${recovered[1]} interrupted background job(s) as failed` };
  if (/Server running on port/i.test(line)) {
    const wasRestarting = state.apiRestarting;
    state.apiRestarting = false;
    return wasRestarting ? { level: 'success', text: 'API restart complete' } : { skip: true };
  }
  if (/ready in \d+\s*ms/i.test(line) || /Local:\s+http/i.test(line) || /Network:\s+use --host/i.test(line)) return { skip: true };
  if (/hmr update/i.test(line)) return { level: 'info', text: 'Browser assets updated' };
  if (stream === 'stderr' || /\b(error|failed|exception)\b/i.test(line)) {
    return { level: 'error', text: sanitizeDiagnostic(line) };
  }
  return { skip: true };
}

function attachChildOutput(child, source, output, state, options = {}) {
  const attach = (stream, streamName) => {
    const reader = readline.createInterface({ input: stream });
    reader.on('line', (line) => {
      if (options.verbose) {
        output.info(stripAnsi(line), source);
        return;
      }
      const translated = translateChildLine(source, line, state, streamName);
      if (!translated.skip) output[translated.level || 'info'](translated.text, source);
    });
  };
  attach(child.stdout, 'stdout');
  attach(child.stderr, 'stderr');
}

async function waitForHttp(url, options = {}) {
  const startedAt = Date.now();
  const request = options.request || requestHttp;
  const timeoutMs = options.timeoutMs || 30_000;
  while (Date.now() - startedAt < timeoutMs) {
    if (options.isFailed?.() || (options.child && options.child.exitCode !== null)) {
      throw new Error(`${options.label} stopped before becoming ready.`);
    }
    const response = await request(url, { timeoutMs: 750 });
    if (response.ok) return { elapsedMs: Date.now() - startedAt, response };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${options.label} did not become ready within ${formatDuration(timeoutMs)}.`);
}

function buildOpenInvocation(url, platform = process.platform) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs can be opened.');
  if (platform === 'win32') return { command: 'explorer.exe', args: [parsed.href] };
  if (platform === 'darwin') return { command: 'open', args: [parsed.href] };
  return { command: 'xdg-open', args: [parsed.href] };
}

function openBrowser(url, options = {}) {
  const invocation = buildOpenInvocation(url, options.platform || process.platform);
  const child = (options.spawnFn || spawn)(invocation.command, invocation.args, {
    stdio: 'ignore', shell: false, windowsHide: true, detached: process.platform !== 'win32',
  });
  child.unref?.();
}

function stopProcessTree(child, options = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null) return Promise.resolve({ ok: true });
  if ((options.platform || process.platform) === 'win32') {
    return new Promise((resolve) => {
      const killer = (options.spawnFn || spawn)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, shell: false,
      });
      killer.once('error', (error) => resolve({ ok: false, error: error.message }));
      killer.once('exit', (code) => resolve({ ok: code === 0, error: code === 0 ? null : `taskkill exited ${code}` }));
    });
  }
  child.kill('SIGTERM');
  return Promise.resolve({ ok: true });
}

async function stopDevelopmentServices(children, output, options = {}) {
  let ok = true;
  for (const entry of [...children].reverse()) {
    const result = await (options.stopFn || stopProcessTree)(entry.child);
    if (result.ok) output.success(`✅ ${entry.label} stopped`, entry.source);
    else {
      ok = false;
      output.error(`❌ Could not stop ${entry.label}: ${sanitizeDiagnostic(result.error)}`, entry.source);
    }
  }
  if (ok) output.success('✅ Development environment closed cleanly');
  else output.warning('⚠️ Shutdown incomplete — review the service messages above.');
  return { ok };
}

function renderPreview(output, context, identity) {
  output.banner();
  output.blank();
  output.heading('🔎 Preflight');
  output.muted('Preview only — no ports, processes, network services, or databases were checked.');
  output.info(`${identity.branch} · commit ${identity.commit}${identity.dirty ? ' · local changes' : ''} · Node ${identity.nodeVersion}`);
  output.success(`✅ API port ${context.apiPort} is available`);
  output.success(`✅ Web port ${context.webPort} is available`);
  output.blank();
  output.heading('⚙️ Starting services');
  output.info('⏳ Starting API and connecting to MongoDB…', 'api');
  output.success('✅ MongoDB connected', 'api');
  output.success('✅ API ready at http://127.0.0.1:3001 (1.4s)', 'api');
  output.info('⏳ Starting the web app…', 'web');
  output.success('✅ Web app ready at http://localhost:5173 (0.6s)', 'web');
  output.blank();
  output.heading('✨ Core app ready in 2.0s');
  output.write('   App: http://localhost:5173');
  output.write('   API: http://127.0.0.1:3001');
  output.write('   Press Ctrl+C once to stop both services.');
  renderQboReadiness(output, context, { installed: true, configured: Boolean(context.callbackOrigin), online: false });
  output.blank();
  output.heading('✅ Startup summary');
  output.write('   Core services: 2 ready');
  output.write('   OAuth callback: action needed only before connect/reconnect');
}

async function runDevLauncher(options = {}) {
  const parsed = options.parsed || parseArgs();
  const output = options.output || createOutput({ color: parsed.color, quiet: parsed.quiet });
  const context = options.context || readStartupContext({ env: process.env });
  const identity = options.identity || getRuntimeIdentity();
  const startedAt = Date.now();

  if (parsed.preview) {
    renderPreview(output, context, identity);
    return { mode: 'preview' };
  }

  output.banner();
  output.blank();
  output.heading('🔎 Preflight');
  output.info(`${identity.branch} · commit ${identity.commit}${identity.dirty ? ' · local changes' : ''} · Node ${identity.nodeVersion}`);

  const existing = await (options.inspectStack || inspectStack)(context);
  if (existing.apiConnected) {
    (existing.apiIsApp ? output.success : output.error).call(output,
      `${existing.apiIsApp ? '✅' : '❌'} API port ${context.apiPort} ${existing.apiIsApp ? 'is already serving Test Data Lab' : 'is occupied by another process'}`);
  } else output.success(`✅ API port ${context.apiPort} is available`);
  if (existing.webConnected) {
    (existing.webIsApp ? output.success : output.error).call(output,
      `${existing.webIsApp ? '✅' : '❌'} Web port ${context.webPort} ${existing.webIsApp ? 'is already serving Test Data Lab' : 'is occupied by another process'}`);
  } else output.success(`✅ Web port ${context.webPort} is available`);

  const ngrok = await (options.inspectNgrok || inspectNgrok)(context);
  if (parsed.check) {
    renderQboReadiness(output, context, ngrok);
    output.write('   Status check only — no processes were started or stopped.');
    return { mode: 'check', existing, ngrok };
  }
  if (existing.apiIsApp && existing.webIsApp) {
    output.info('This development stack is already running; no duplicate processes were started.');
    output.write(`   App: http://localhost:${context.webPort}`);
    output.write(`   API: http://127.0.0.1:${context.apiPort}`);
    if (parsed.open) openBrowser(`http://localhost:${context.webPort}`);
    renderQboReadiness(output, context, ngrok);
    return { mode: 'already-running', existing, ngrok };
  }
  if (existing.apiConnected || existing.webConnected) {
    output.action('Inspect the port owner before stopping anything, then run npm run dev again.');
    const port = existing.apiConnected ? context.apiPort : context.webPort;
    output.write(`   Windows check: Get-NetTCPConnection -State Listen -LocalPort ${port}`);
    const error = new Error('Startup stopped safely because a required port is occupied.');
    error.code = 'DEV_PORT_IN_USE';
    throw error;
  }

  const children = [];
  const state = {};
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return { ok: false };
    shuttingDown = true;
    output.blank();
    output.info(`🛑 ${reason === 'SIGINT' ? 'Stopping development services' : 'Cleaning up development services'}…`);
    return stopDevelopmentServices(children, output);
  };
  const onSignal = (signal) => { void shutdown(signal).then((result) => process.exit(result.ok ? 0 : 1)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    output.blank();
    output.heading('⚙️ Starting services');
    output.info('⏳ Starting API and connecting to MongoDB…', 'api');
    const api = (options.spawnNpm || spawnManagedNpm)('dev:backend', { env: process.env });
    api.once('error', (error) => { state.apiSpawnError = error; });
    children.push({ child: api, label: 'API', source: 'api' });
    attachChildOutput(api, 'api', output, state, { verbose: parsed.verbose });
    const apiReady = await waitForHttp(`http://127.0.0.1:${context.apiPort}/api/health`, {
      child: api,
      isFailed: () => Boolean(state.apiSpawnError),
      label: 'API',
      timeoutMs: API_TIMEOUT_MS,
    });
    output.success(`✅ API ready at http://127.0.0.1:${context.apiPort} (${formatDuration(apiReady.elapsedMs)})`, 'api');

    output.info('⏳ Starting the web app…', 'web');
    const web = (options.spawnNpm || spawnManagedNpm)('dev:frontend', { env: process.env });
    web.once('error', (error) => { state.webSpawnError = error; });
    children.push({ child: web, label: 'Web app', source: 'web' });
    attachChildOutput(web, 'web', output, state, { verbose: parsed.verbose });
    const webReady = await waitForHttp(`http://localhost:${context.webPort}/`, {
      child: web,
      isFailed: () => Boolean(state.webSpawnError) || api.exitCode !== null,
      label: 'Web app',
      timeoutMs: WEB_TIMEOUT_MS,
    });
    output.success(`✅ Web app ready at http://localhost:${context.webPort} (${formatDuration(webReady.elapsedMs)})`, 'web');

    output.blank();
    output.heading(`✨ Core app ready in ${formatDuration(Date.now() - startedAt)}`);
    output.write(`   App: http://localhost:${context.webPort}`);
    output.write(`   API: http://127.0.0.1:${context.apiPort}`);
    output.write('   Tester credentials are shown on the sign-in page.');
    output.write('   Press Ctrl+C once to stop both services.');
    if (!parsed.verbose) output.write('   Need raw service logs? Run: npm run dev -- --verbose');
    if (parsed.open) openBrowser(`http://localhost:${context.webPort}`);
    renderQboReadiness(output, context, ngrok);
    output.blank();
    output.heading('✅ Startup summary');
    output.write('   Core services: 2 ready');
    output.write(`   OAuth callback: ${ngrok.online ? 'ready' : 'action needed only before connect/reconnect'}`);

    const unexpectedExit = (label) => (code, signal) => {
      if (shuttingDown) return;
      output.error(`❌ ${label} stopped unexpectedly (${signal || `exit code ${code}`}).`);
      void shutdown(`${label} failure`).then(() => { process.exitCode = code || 1; });
    };
    api.once('exit', unexpectedExit('API'));
    web.once('exit', unexpectedExit('Web app'));
    return { mode: 'running', children, ngrok };
  } catch (error) {
    output.error(`❌ ${sanitizeDiagnostic(error.message)}`);
    await shutdown('startup failure');
    throw error;
  }
}

if (require.main === module) {
  runDevLauncher().catch((error) => {
    if (error.code !== 'DEV_PORT_IN_USE') console.error(`Details: ${sanitizeDiagnostic(error.message)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildNpmInvocation,
  buildOpenInvocation,
  canConnect,
  createOutput,
  formatDuration,
  inspectNgrok,
  inspectStack,
  ngrokCommand,
  parseArgs,
  parseEnvValue,
  readStartupContext,
  renderPreview,
  renderQboReadiness,
  requestHttp,
  runDevLauncher,
  sanitizeDiagnostic,
  stopDevelopmentServices,
  stripAnsi,
  translateChildLine,
  waitForHttp,
};
