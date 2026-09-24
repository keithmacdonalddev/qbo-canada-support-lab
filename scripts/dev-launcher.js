'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const { redactLogSecrets } = require('../backend/src/modules/log-diagnostic');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_API_PORT = 3001;
const DEFAULT_WEB_PORT = 5173;
const API_TIMEOUT_MS = 60_000;
const WEB_TIMEOUT_MS = 30_000;
const NGROK_TIMEOUT_MS = 15_000;
const CALLBACK_PATH = '/api/qbo/callback';
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(value) {
  return String(value || '').replace(ANSI_PATTERN, '');
}

function colorize(code, value, enabled) {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function celebrationText(value, enabled) {
  if (!enabled) return value;
  const stops = [[38, 196, 246], [121, 100, 247], [232, 98, 181]];
  const letters = [...value];
  return letters.map((letter, index) => {
    const position = index * (stops.length - 1) / Math.max(1, letters.length - 1);
    const left = Math.floor(position);
    const right = Math.min(stops.length - 1, left + 1);
    const blend = position - left;
    const rgb = stops[left].map((channel, part) => Math.round(channel * (1 - blend) + stops[right][part] * blend));
    return `\u001b[1;38;2;${rgb.join(';')}m${letter}`;
  }).join('') + '\u001b[0m';
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

function formatLocalTimestamp(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`;
}

function createOutput({ stream = process.stdout, color = true, quiet = false, now = () => Date.now() } = {}) {
  const writeRaw = (value = '') => stream.write(`${value}\n`);
  const write = (value = '') => { if (!quiet) writeRaw(value); };
  const timestamp = () => colorize('90', formatLocalTimestamp(now()), color);
  const prefix = (source) => {
    if (source === 'api') return colorize('36;1', ' API ', color);
    if (source === 'web') return colorize('35;1', ' WEB ', color);
    if (source === 'qbo') return colorize('36;1', ' QBO ', color);
    return colorize('34;1', ' DEV ', color);
  };
  const colors = { error: '31;1', success: '32;1', warning: '33;1', info: '37', muted: '90' };

  return {
    blank: () => write(),
    banner() {
      write(`🚀 ${colorize('1;36', 'Test Data Lab', color)} ${colorize('90', '— development', color)}`);
      write(colorize('90', '   Safe startup · clear status · managed shutdown', color));
      write(colorize('36', '────────────────────────────────────────────────', color));
    },
    heading(value) { write(colorize('1', value, color)); },
    celebrate(value) { write(celebrationText(value, color)); },
    write,
    line(level, value, source = 'dev') {
      if (quiet && !['warning', 'error'].includes(level)) return;
      writeRaw(`${timestamp()} ${prefix(source)} ${colorize(colors[level] || colors.info, value, color)}`);
    },
    service(value, source, streamName) {
      // Keep every child line, including stack traces and multiline objects.
      // The stream label makes interleaved stdout/stderr diagnosable.
      writeRaw(`${timestamp()} ${prefix(source)} [${streamName}] ${redactLogSecrets(value)}`);
    },
    action(value, source = 'dev') {
      writeRaw(`${timestamp()} ${prefix(source)} ${colorize('90', `   Next: ${value}`, color)}`);
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
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s@/]+@/gi, '$1[redacted]@')
    .replace(/:\/\/[^\s:/]+:[^\s@/]+@/g, '://[redacted]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b([a-z0-9_-]*(?:secret|token|password|passwd|pwd|api[-_]?key|authorization))\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,"';]+)/gi, '$1=[redacted]')
    .replace(/([?&](?:code|state|token|key|client_secret|access_token|refresh_token)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]')
    .replace(/\b(?:sk|key)-[a-z0-9_-]{12,}\b/gi, '[redacted key]')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (text || fallback).slice(0, 240);
}

function parseApiHealth(response) {
  try {
    const body = JSON.parse(response?.body || '');
    return {
      isApp: body.app === 'test-data-lab',
      ready: response.status === 200 && body.app === 'test-data-lab'
        && body.status === 'ok' && body.database === 'connected',
    };
  } catch {
    return { isApp: false, ready: false };
  }
}

function isWebReady(response) {
  return response?.status === 200 && /<title>Test Data Lab<\/title>/i.test(response.body || '');
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
    const parsed = redirectUri ? new URL(redirectUri) : null;
    if (parsed?.protocol === 'https:' && parsed.pathname === CALLBACK_PATH
      && !parsed.search && !parsed.hash && !parsed.username && !parsed.password) {
      callbackOrigin = parsed.origin;
    }
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
  const apiHealth = parseApiHealth(apiResponse);
  const webIsApp = isWebReady(webResponse);
  return { apiConnected, webConnected, apiIsApp: apiHealth.isApp, apiReady: apiHealth.ready, webIsApp };
}

async function startCallbackProxy(context) {
  const handler = (request, response) => {
    const target = request.url || '';
    if (request.method !== 'GET' || (target !== CALLBACK_PATH && !target.startsWith(`${CALLBACK_PATH}?`))) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Not found');
      return;
    }

    const upstream = http.request({
      hostname: '127.0.0.1',
      port: context.apiPort,
      method: 'GET',
      path: target,
      headers: { Accept: 'text/html' },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        'Content-Type': upstreamResponse.headers['content-type'] || 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      upstreamResponse.pipe(response);
    });
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Callback unavailable');
    });
    request.once('aborted', () => upstream.destroy());
    upstream.end();
  };
  const bind = (host, port) => new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
  const ipv4 = await bind('127.0.0.1', context.proxyPort || 0);
  const port = ipv4.address().port;
  try {
    const ipv6 = await bind('::1', port);
    return { server: { servers: [ipv4, ipv6] }, port };
  } catch (error) {
    await stopCallbackProxy({ servers: [ipv4] });
    throw error;
  }
}

async function stopCallbackProxy(server) {
  const results = await Promise.all((server.servers || [server]).map((listener) => new Promise((resolve) => {
    listener.close((error) => resolve({ ok: !error, error: error?.message }));
    listener.closeAllConnections?.();
  })));
  return results.find((result) => !result.ok) || { ok: true };
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
    const matching = tunnels.filter((tunnel) => {
      try { return new URL(tunnel.public_url).origin === context.callbackOrigin; } catch { return false; }
    });
    if (matching.length === 0) return { installed, configured: true, online: false };
    const targetMatches = (address) => {
      try {
        const target = new URL(address.includes('://') ? address : `http://${address}`);
        return target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname)
          && Number(target.port) === context.proxyPort && target.pathname === '/';
      } catch { return false; }
    };
    if (!context.proxyPort) {
      const directApi = matching.some((tunnel) => {
        try {
          const target = new URL(tunnel.config?.addr?.includes('://') ? tunnel.config.addr : `http://${tunnel.config?.addr}`);
          return ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
            && Number(target.port) === context.apiPort;
        } catch { return false; }
      });
      if (directApi || matching.length !== 1) {
        return { installed, configured: true, online: false, conflict: true };
      }
      let target;
      try {
        const addr = matching[0].config?.addr || '';
        target = new URL(addr.includes('://') ? addr : `http://${addr}`);
      } catch {
        return { installed, configured: true, online: false, conflict: true };
      }
      const port = Number(target.port);
      const isLocal = target.protocol === 'http:'
        && ['localhost', '127.0.0.1'].includes(target.hostname)
        && target.pathname === '/' && !target.search && !target.hash
        && Number.isInteger(port) && port > 0 && port !== context.webPort;
      if (!isLocal) return { installed, configured: true, online: false, conflict: true };
      const connect = options.connect || canConnect;
      const listening = (await Promise.all([
        connect({ host: '127.0.0.1', port }),
        connect({ host: '::1', port }),
      ])).some(Boolean);
      return listening
        ? { installed, configured: true, online: false, unverified: true }
        : { installed, configured: true, online: false, staleTargetPort: port };
    }
    const online = matching.length === 1 && targetMatches(matching[0].config?.addr || '');
    return { installed, configured: true, online, ...(online ? {} : { conflict: true }) };
  } catch {
    return { installed, configured: true, online: false };
  }
}

function ngrokCommand(context) {
  return context.callbackOrigin && context.proxyPort
    ? `ngrok http ${context.proxyPort} --url ${context.callbackOrigin}` : '';
}

function renderQboReadiness(output, context, ngrok, options = {}) {
  output.blank();
  if (context.qboEnvironment === 'production') {
    output.celebrate('✨ PRODUCTION · REAL QUICKBOOKS COMPANY');
    output.info('Changes you approve will affect your real QuickBooks company.', 'qbo');
  } else {
    output.heading(`QuickBooks environment: ${context.qboEnvironment.toUpperCase()}`);
  }

  if (!ngrok.configured) {
    output.warning('QuickBooks sign-in cannot return to this app yet. Connect/Reconnect needs setup.', 'qbo');
    output.action(`Set QBO_REDIRECT_URI to the registered HTTPS URL ending in ${CALLBACK_PATH}.`, 'qbo');
    return;
  }
  if (ngrok.online) {
    output.success('✅ QuickBooks sign-in return path is set up. Connect/Reconnect is ready to try.', 'qbo');
    output.muted('The first sign-in will confirm that QuickBooks can return to this app.', 'qbo');
    return;
  }

  if (ngrok.conflict) {
    output.warning('QuickBooks sign-in is pointing to the wrong place. Connect/Reconnect may fail.', 'qbo');
    output.action('Close or correct the existing ngrok tunnel before connecting QuickBooks.', 'qbo');
    return;
  }
  if (ngrok.unverified) {
    output.warning('QuickBooks sign-in is open, but this check cannot confirm where it leads.', 'qbo');
    output.action('Check the running npm run dev window before connecting QuickBooks.', 'qbo');
    return;
  }
  if (ngrok.staleTargetPort) {
    output.warning(`QuickBooks sign-in leads to a closed app port (${ngrok.staleTargetPort}, ERR_NGROK_8012).`, 'qbo');
    output.action('Stop the existing stack, then run npm run dev to restore its protected gateway.', 'qbo');
    return;
  }

  output.warning('QuickBooks sign-in is unavailable right now. The app still works, but Connect/Reconnect will fail (ERR_NGROK_3200).', 'qbo');
  if (!ngrok.installed) output.warning('ngrok is not available on PATH.', 'qbo');
  if (context.proxyPort) {
    output.action(`Run: ${ngrokCommand(context)}`, 'qbo');
  } else output.action('Run npm run dev from a fresh stop to create the protected callback gateway.', 'qbo');
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

function spawnManagedNgrok(context, options = {}) {
  if (!context.proxyPort) throw new Error('Protected callback gateway is not running.');
  return (options.spawnFn || spawn)('ngrok', ['http', String(context.proxyPort), '--url', context.callbackOrigin], {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function summarizeNgrokLine(rawLine) {
  const line = stripAnsi(rawLine);
  const code = line.match(/\bERR_NGROK_\d+\b/i)?.[0]?.toUpperCase();
  let reason = '';
  if (/authentication failed|failed to authenticate|unauthorized|not authenticated|(?:invalid|missing).*authtoken|authtoken.*(?:invalid|missing|error)/i.test(line)) reason = 'authentication or account setup';
  else if (/already (?:online|in use)|domain.*(?:not reserved|not available|already.*in use)|reserved.*(?:another|different)/i.test(line)) reason = 'callback domain is unavailable';
  else if (/limit.*(?:tunnel|endpoint)|(?:tunnel|endpoint).*limit/i.test(line)) reason = 'account tunnel limit reached';
  else if (/connection refused|failed to connect to localhost|failed to connect to 127\.0\.0\.1/i.test(line)) reason = 'local API connection failed';
  return code || reason ? `${code || 'ngrok error'}${reason ? ` (${reason})` : ''}` : '';
}

function captureNgrokDiagnostics(child) {
  const diagnostics = { detail: '' };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    readline.createInterface({ input: stream }).on('line', (line) => {
      const detail = summarizeNgrokLine(line);
      if (detail) diagnostics.detail = detail;
    });
  }
  return diagnostics;
}

function summarizeServiceFailure(line) {
  if (line.startsWith('[api/unhandled]')) {
    const area = /^\[api\/unhandled\] area=(auth|qbo|company|seed|audit|generate|checkpoint|explore|issuepacks|ai|health|context|other)\b/.exec(line)?.[1] || 'other';
    const status = /\bstatus=(\d{3})\b/.exec(line)?.[1];
    const type = /\btype=(Error|TypeError|ReferenceError|SyntaxError|RangeError|ValidationError|CastError|MongoServerSelectionError|MongoNetworkError|OAuthError)\b/.exec(line)?.[1];
    const reference = /\bref=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\b/.exec(line)?.[1];
    return `Unexpected ${area === 'other' ? 'API' : area} request failed${status || type ? ` (${[status && `HTTP ${status}`, type].filter(Boolean).join(', ')})` : ''}${reference ? `; reference ${reference}` : ''}. Check the affected screen.`;
  }
  const tag = line.match(/^\[([a-z][a-z0-9/-]*)\]/i)?.[1]?.toLowerCase();
  const areaNames = {
    auth: 'Account', company: 'Company', qbo: 'QuickBooks connection',
    checkpoint: 'Checkpoint', issuepacks: 'Issue pack', seed: 'Seed',
    generate: 'Generation', audit: 'Audit', explore: 'Entity Explorer', ai: 'AI Assistant',
  };
  const context = ({
    'auth/register': 'Account creation',
    'auth/login': 'Sign-in request',
    'auth/me': 'Session check',
    'company/get': 'Company details',
    'company/health': 'Company connection check',
    'company/snapshot': 'Company snapshot',
    'checkpoint/list': 'Checkpoint list',
    'issuepacks/list': 'Issue pack list',
    'issuepacks/runs': 'Issue pack run list',
    'seed/history': 'Seed history',
    'generate/history': 'Generation history',
    'audit/list': 'Audit list',
    'explore/timeline': 'Recent activity',
    'qbo/status': 'QuickBooks connection status',
    'qbo-client': 'QuickBooks API request',
  }[tag]) || (areaNames[tag?.split('/')[0]] && `${areaNames[tag.split('/')[0]]} request`);
  let reason = '';
  if (/EADDRINUSE/i.test(line)) reason = 'port is already in use';
  else if (/MongoDB connection error|MongooseServerSelectionError/i.test(line)) reason = 'MongoDB connection failed';
  else if (/ENOTFOUND|EAI_AGAIN/i.test(line)) reason = 'DNS lookup failed';
  else if (/ECONNREFUSED/i.test(line)) reason = 'dependent service refused the connection';
  else if (/MODULE_NOT_FOUND/i.test(line)) reason = 'a required module is missing';
  else if (/SyntaxError/i.test(line)) reason = 'JavaScript syntax error';
  if (context) return `${context} failed${reason ? `: ${reason}` : '; details hidden for privacy'}.`;
  return reason ? `Service error: ${reason}.` : 'Unclassified service error; the safe log cannot identify its cause. Check the affected screen.';
}

function isErrorDetailLine(line) {
  return /^(?:at\s+|[{}\[\],]\s*$|[a-z_$][\w$-]*\s*:)/i.test(line)
    && !/^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError)\s*:/i.test(line);
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
  if (isErrorDetailLine(line)) return { skip: true };
  const errorSignal = /\b(error|failed|exception)\b/i.test(line)
    || /^(?:[A-Za-z]*Error|Exception)(?::|\s|\[)/.test(line)
    || /\bERR_[A-Z0-9_]+\b/.test(line)
    || line.startsWith('[api/unhandled]')
    || (source === 'api' && stream === 'stderr' && /^\[(?:auth|company|qbo|qbo-client|checkpoint|issuepacks|seed|generate|audit|explore|ai)(?:\/[a-z0-9/-]+)?\]/i.test(line));
  if (errorSignal) {
    const text = summarizeServiceFailure(line);
    const now = Date.now();
    // Distinct request references must remain visible for UI-to-terminal tracing.
    const key = `${source}:${text}`;
    state.errorTimes ||= new Map();
    if (now - (state.errorTimes.get(key) || 0) < 10_000) return { skip: true };
    state.errorTimes.set(key, now);
    return { level: 'error', text };
  }
  return { skip: true };
}

function attachChildOutput(child, source, output, state, options = {}) {
  const attach = (stream, streamName) => {
    if (!stream) return;
    const reader = readline.createInterface({ input: stream });
    reader.on('line', (line) => {
      output.service(line, source, streamName);
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
    if (response.ok) {
      if (!options.isReady || options.isReady(response)) return { elapsedMs: Date.now() - startedAt, response };
      throw new Error(`${options.label} port answered, but it is not a ready Test Data Lab service.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${options.label} did not become ready within ${formatDuration(timeoutMs)}.`);
}

async function waitForNgrok(context, child, options = {}) {
  const startedAt = Date.now();
  const inspect = options.inspect || inspectNgrok;
  const timeoutMs = options.timeoutMs ?? NGROK_TIMEOUT_MS;
  while (Date.now() - startedAt < timeoutMs) {
    if (options.isFailed?.() || child.exitCode !== null) throw new Error('ngrok stopped before its tunnel was ready.');
    const status = await inspect(context, { installed: true });
    if (status.online) return status;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
  throw new Error(`ngrok did not become ready within ${formatDuration(timeoutMs)}.`);
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

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function stopProcessTree(child, options = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0
    || child.exitCode != null || child.signalCode != null) return { ok: true, alreadyStopped: true };
  if ((options.platform || process.platform) === 'win32') {
    const running = options.isPidRunning || isPidRunning;
    if (!running(child.pid)) return { ok: true, alreadyStopped: true };
    const result = await new Promise((resolve) => {
      let killer;
      try {
        killer = (options.spawnFn || spawn)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      let detail = '';
      const capture = (chunk) => { detail = (detail + String(chunk)).slice(0, 1024); };
      killer.stdout?.on('data', capture);
      killer.stderr?.on('data', capture);
      killer.once('error', (error) => resolve({ ok: false, error: error.message }));
      killer.once('close', (code) => {
        resolve({ ok: code === 0, error: code === 0 ? null
          : `taskkill exited ${code}${detail.trim() ? `: ${sanitizeDiagnostic(detail)}` : ''}` });
      });
    });
    if (result.ok) return result;
    // Ctrl+C may stop npm before taskkill reaches its PID. Verify the process
    // rather than reporting a failed shutdown for an already-exited child.
    if (running(child.pid)) await new Promise((resolve) => setTimeout(resolve, 150));
    if (!running(child.pid)) return { ok: true, alreadyStopped: true };
    return result;
  }
  child.kill('SIGTERM');
  return { ok: true };
}

async function isPortListening(port, connect = canConnect) {
  const results = await Promise.all([
    connect({ host: '127.0.0.1', port }),
    connect({ host: '::1', port }),
  ]);
  return results.some(Boolean);
}

async function stopDevelopmentServices(children, output, options = {}) {
  let ok = true;
  for (const entry of [...children].reverse()) {
    let result;
    try {
      result = await (entry.stop || options.stopFn || stopProcessTree)(entry.child);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    let portOpen = false;
    let portCheckError;
    if (entry.port) {
      const attempts = options.portCheckAttempts ?? 6;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          portOpen = await (options.isPortListening || isPortListening)(entry.port);
        } catch (error) {
          portCheckError = error;
          break;
        }
        if (!portOpen) break;
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, options.portCheckDelayMs ?? 150));
      }
    }
    if (result.ok && !portOpen && !portCheckError) {
      output.success(`✅ ${entry.label} ${result.alreadyStopped ? 'was already stopped' : 'stopped'}`, entry.source);
    } else {
      ok = false;
      if (!result.ok) output.error(`❌ Could not stop ${entry.label}: ${sanitizeDiagnostic(result.error)}`, entry.source);
      if (portCheckError) output.warning(`Could not verify ${entry.label} port ${entry.port}: ${sanitizeDiagnostic(portCheckError.message)}`, entry.source);
      if (portOpen) output.warning(`${entry.label} port ${entry.port} remains occupied. Check its owner before restarting.`, entry.source);
      else if (entry.port && !result.ok && !portCheckError) output.info(`${entry.label} port ${entry.port} is closed, but its process may still be running.`, entry.source);
    }
  }
  if (ok) output.success('✅ Development environment closed cleanly');
  else output.warning('⚠️  Shutdown incomplete — review the service messages above.');
  return { ok };
}

function renderPreview(output, context, identity) {
  output.banner();
  output.blank();
  output.heading('🧪 Startup preview — no services started or checked');
  output.info(`${identity.branch} · commit ${identity.commit}${identity.dirty ? ' · local changes' : ''} · Node ${identity.nodeVersion}`);
  output.write(`   Would check API port ${context.apiPort} and web port ${context.webPort}.`);
  output.write('   Would start the API, verify MongoDB health, then start the web app.');
  if (context.callbackOrigin) output.write('   Would prepare the QuickBooks sign-in return path.');
  else output.write('   QuickBooks callback URL is not configured.');
  if (context.qboEnvironment === 'production') {
    output.celebrate('✨ PRODUCTION · REAL QUICKBOOKS COMPANY');
    output.info('Changes you approve will affect your real QuickBooks company.', 'qbo');
  }
  output.write('   Run npm run dev for observed readiness and shutdown controls.');
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
    const description = existing.apiReady ? 'is already serving Test Data Lab'
      : existing.apiIsApp ? 'has Test Data Lab, but its database is unavailable'
        : 'is occupied by another process';
    (existing.apiReady ? output.success : output.error).call(output,
      `${existing.apiReady ? '✅' : '❌'} API port ${context.apiPort} ${description}`);
  } else output.success(`✅ API port ${context.apiPort} is available`);
  if (existing.webConnected) {
    (existing.webIsApp ? output.success : output.error).call(output,
      `${existing.webIsApp ? '✅' : '❌'} Web port ${context.webPort} ${existing.webIsApp ? 'is already serving Test Data Lab' : 'is occupied by another process'}`);
  } else output.success(`✅ Web port ${context.webPort} is available`);

  let ngrok = await (options.inspectNgrok || inspectNgrok)(context);
  if (parsed.check) {
    renderQboReadiness(output, context, ngrok);
    output.write('   Status check only — no processes were started or stopped.');
    return { mode: 'check', existing, ngrok };
  }
  if (existing.apiReady && existing.webIsApp) {
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
  let serviceFailed = false;
  let shutdownPromise;
  let pendingGateway;
  const ensureStarting = () => {
    if (!shuttingDown) return;
    const error = new Error('Startup stopped during shutdown.');
    error.code = 'DEV_START_INTERRUPTED';
    throw error;
  };
  const shutdown = (reason) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      output.blank();
      output.info(`🛑 ${reason === 'SIGINT' ? 'Stopping development services' : 'Cleaning up development services'}…`);
      if (pendingGateway) await pendingGateway.catch(() => {});
      return stopDevelopmentServices(children, output, {
        stopFn: options.stopFn,
        isPortListening: options.isPortListening,
      });
    })();
    return shutdownPromise;
  };
  const onSignal = (signal) => { void shutdown(signal).then((result) => (options.exitProcess || process.exit)(result.ok && !serviceFailed ? 0 : 1)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const unexpectedExit = (label) => (code, signal) => {
    if (shuttingDown) return;
    serviceFailed = true;
    output.error(`❌ ${label} stopped unexpectedly (${signal || `exit code ${code}`}).`);
    void shutdown(`${label} failure`).then(() => { process.exitCode = code || 1; });
  };

  try {
    output.blank();
    output.heading('⚙️ Starting services');
    output.info('⏳ Starting API and connecting to MongoDB…', 'api');
    const api = (options.spawnNpm || spawnManagedNpm)('dev:backend', { env: process.env });
    api.once('error', (error) => { state.apiSpawnError = error; });
    children.push({ child: api, label: 'API', source: 'api', port: context.apiPort });
    api.once('exit', unexpectedExit('API'));
    attachChildOutput(api, 'api', output, state, { verbose: parsed.verbose });
    const apiReady = await (options.waitForHttp || waitForHttp)(`http://127.0.0.1:${context.apiPort}/api/health`, {
      child: api,
      isFailed: () => Boolean(state.apiSpawnError),
      isReady: (response) => parseApiHealth(response).ready,
      label: 'API',
      timeoutMs: API_TIMEOUT_MS,
    });
    ensureStarting();
    output.success(`✅ API ready at http://127.0.0.1:${context.apiPort} (${formatDuration(apiReady.elapsedMs)})`, 'api');

    output.info('⏳ Starting the web app…', 'web');
    const web = (options.spawnNpm || spawnManagedNpm)('dev:frontend', { env: process.env });
    web.once('error', (error) => { state.webSpawnError = error; });
    children.push({ child: web, label: 'Web app', source: 'web', port: context.webPort });
    web.once('exit', unexpectedExit('Web app'));
    attachChildOutput(web, 'web', output, state, { verbose: parsed.verbose });
    const webReady = await (options.waitForHttp || waitForHttp)(`http://localhost:${context.webPort}/`, {
      child: web,
      isFailed: () => Boolean(state.webSpawnError) || api.exitCode !== null,
      isReady: isWebReady,
      label: 'Web app',
      timeoutMs: WEB_TIMEOUT_MS,
    });
    ensureStarting();
    output.success(`✅ Web app ready at http://localhost:${context.webPort} (${formatDuration(webReady.elapsedMs)})`, 'web');

    if (ngrok.configured) {
      try {
        const desiredPort = ngrok.staleTargetPort;
        pendingGateway = Promise.resolve().then(() => (options.startCallbackProxy || startCallbackProxy)({
          ...context, proxyPort: desiredPort,
        })).then((created) => {
          children.push({ child: created.server, label: 'Protected callback gateway', source: 'qbo', stop: options.stopCallbackProxy || stopCallbackProxy });
          return created;
        });
        const gateway = await pendingGateway;
        ensureStarting();
        context.proxyPort = gateway.port;
        output.success('✅ QuickBooks sign-in return route is ready', 'qbo');
        if (desiredPort) output.info('Reused the sign-in link from an earlier launch.', 'qbo');
      } catch (error) {
        if (shuttingDown) ensureStarting();
        output.warning(`Could not start the protected callback gateway: ${sanitizeDiagnostic(error.message)}`, 'qbo');
      }
      // Re-check after the gateway starts; an existing tunnel may use this domain.
      ngrok = await (options.inspectNgrok || inspectNgrok)(context);
      ensureStarting();
    }
    if (ngrok.configured && ngrok.installed && context.proxyPort && !ngrok.online && !ngrok.conflict) {
      output.info('⏳ Preparing QuickBooks sign-in…', 'qbo');
      let tunnelDiagnostics = { detail: '' };
      let tunnel;
      let tunnelError;
      try {
        tunnel = (options.spawnNgrok || spawnManagedNgrok)(context);
        children.push({ child: tunnel, label: 'ngrok tunnel', source: 'qbo' });
        attachChildOutput(tunnel, 'qbo', output);
        tunnelDiagnostics = captureNgrokDiagnostics(tunnel);
        tunnel.once('error', (error) => { tunnelError = error; });
        ngrok = await waitForNgrok(context, tunnel, {
          inspect: options.inspectNgrok || inspectNgrok,
          isFailed: () => Boolean(tunnelError),
          timeoutMs: options.ngrokTimeoutMs ?? NGROK_TIMEOUT_MS,
        });
        ensureStarting();
        output.success('✅ QuickBooks sign-in link is ready', 'qbo');
        tunnel.once('exit', (code) => {
          if (!shuttingDown) output.warning(`Callback tunnel stopped (exit code ${code})${tunnelDiagnostics.detail ? `; ${tunnelDiagnostics.detail}` : ''}; connect/reconnect needs ngrok.`, 'qbo');
        });
      } catch (error) {
        if (shuttingDown) ensureStarting();
        const spawnCode = tunnelError?.code || (!tunnel && error.code);
        const cause = spawnCode === 'ENOENT' ? 'ngrok executable was not found'
          : spawnCode === 'EACCES' ? 'ngrok could not be executed'
            : spawnCode ? 'ngrok process could not launch'
              : sanitizeDiagnostic(error.message);
        output.warning(`Could not start the callback tunnel: ${cause}`, 'qbo');
        if (tunnelDiagnostics.detail) output.warning(`ngrok reported: ${tunnelDiagnostics.detail}`, 'qbo');
        if (tunnel) {
          const stopped = await (options.stopFn || stopProcessTree)(tunnel);
          if (stopped.ok) children.pop();
        }
      }
    }

    ensureStarting();
    output.blank();
    output.heading(`✨ Test Data Lab is ready in ${formatDuration(Date.now() - startedAt)}`);
    output.write(`   Open the app: http://localhost:${context.webPort}`);
    output.write(`   Local data service: http://127.0.0.1:${context.apiPort}`);
    output.write('   Tester credentials are shown on the sign-in page.');
    output.write('   When finished, press Ctrl+C once to stop this launch.');
    output.write('   Logs below have timestamps. Common secrets are masked; keep company details private.');
    if (ngrok.online && !children.some((entry) => entry.label === 'ngrok tunnel')) {
      output.write('   The reused QuickBooks sign-in link stays open after Ctrl+C.');
    }
    if (parsed.open) openBrowser(`http://localhost:${context.webPort}`);
    renderQboReadiness(output, context, ngrok);
    output.blank();
    output.heading('✅ At a glance');
    output.success('✅ App ready: website and data service are running');
    if (ngrok.online) output.success('✅ QuickBooks sign-in ready to try: Connect/Reconnect', 'qbo');
    else output.warning(`QuickBooks sign-in: ${ngrok.conflict ? 'fix the existing link before Connect/Reconnect' : 'needs setup only for Connect/Reconnect'}`, 'qbo');

    return { mode: 'running', children, ngrok };
  } catch (error) {
    if (shuttingDown) {
      await shutdown('startup failure');
      return { mode: 'stopped', children, ngrok };
    }
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
  isWebReady,
  ngrokCommand,
  parseApiHealth,
  parseArgs,
  parseEnvValue,
  readStartupContext,
  renderPreview,
  renderQboReadiness,
  requestHttp,
  runDevLauncher,
  sanitizeDiagnostic,
  summarizeNgrokLine,
  spawnManagedNgrok,
  startCallbackProxy,
  stopCallbackProxy,
  stopDevelopmentServices,
  stopProcessTree,
  stripAnsi,
  translateChildLine,
  waitForHttp,
  waitForNgrok,
};
