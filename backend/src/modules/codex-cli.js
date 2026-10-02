'use strict';

// Codex CLI as an AI provider: uses the owner's ChatGPT subscription through
// the locally installed and signed-in `codex` program, so no API key is needed.
//
// Every run is inference-only. Codex's own shell, file, browser, plugin and
// web tools are switched off and user config/rules/project docs are ignored.
// The only tools the model receives are this app's AI tools, served over a
// per-run MCP endpoint (see ai-tool-bridge.js) where the server applies the
// same read/confirm rules as the Anthropic path. Pattern adapted from the
// owner's Alfred app (server/src/lib/codex-app-agent.js and
// library-provider-isolation.js).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const config = require('../config');

const WORK_DIR = path.join(os.tmpdir(), 'test-data-lab-codex');
const STATUS_CACHE_MS = 60 * 1000;

// Codex silently ignores unknown -c keys; re-check these after Codex upgrades.
const SELF_TEXT_ARGS = Object.freeze([
  '-c', 'include_permissions_instructions=false',
  '-c', 'include_environment_context=false',
  '-c', 'include_apps_instructions=false',
  '-c', 'include_collaboration_mode_instructions=false',
  '-c', 'skills.include_instructions=false',
]);

const DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'hooks', 'memories',
  'multi_agent', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
  'image_generation', 'view_image', 'skill_search', 'skill_mcp_dependency_install',
  'code_mode_host', 'sleep_tool', 'tool_suggest', 'goals',
]);

const ISOLATION_ARGS = Object.freeze([
  '--ignore-user-config', '--ignore-rules', '--ephemeral',
  '--sandbox', 'read-only',
  '-c', 'approval_policy="never"',
  '-c', 'web_search="disabled"',
  '-c', 'project_doc_max_bytes=0',
  ...DISABLED_FEATURES.flatMap((name) => ['--disable', name]),
]);

const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

let statusCache = null;

// Launch codex.exe directly on Windows: going through cmd.exe mangles quoted
// -c values.
function resolveExecutable() {
  if (config.ai.codex.cliPath && fs.existsSync(config.ai.codex.cliPath)) return config.ai.codex.cliPath;
  if (process.platform !== 'win32') return 'codex';
  const tail = ['npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
    'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'];
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, ...tail) : '',
    path.join(os.homedir(), 'AppData', 'Roaming', ...tail),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function tomlString(value) {
  return JSON.stringify(String(value).replace(/\\/g, '/'));
}

/**
 * Is the Codex CLI installed and signed in? Cached for a minute.
 * @returns {Promise<{ installed: boolean, loggedIn: boolean, method: string|null, model: string }>}
 */
function getStatus({ refresh = false } = {}) {
  if (!refresh && statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return Promise.resolve(statusCache.value);
  }
  const executable = resolveExecutable();
  const base = { installed: false, loggedIn: false, method: null, model: config.ai.codex.model };
  if (!executable) {
    statusCache = { at: Date.now(), value: base };
    return Promise.resolve(base);
  }
  return new Promise((resolve) => {
    const done = (value) => { statusCache = { at: Date.now(), value }; resolve(value); };
    try {
      execFile(executable, ['login', 'status'], { windowsHide: true, timeout: 15000, env: childEnv() }, (err, stdout, stderr) => {
        const text = `${stdout || ''}\n${stderr || ''}`;
        const loggedIn = !err && /logged in/i.test(text) && !/not logged in/i.test(text);
        const method = /chatgpt/i.test(text) ? 'chatgpt' : /api key/i.test(text) ? 'api-key' : null;
        done({ ...base, installed: !(err && err.code === 'ENOENT'), loggedIn, method: loggedIn ? method : null });
      });
    } catch {
      done(base);
    }
  });
}

// Errors from the model service carry `aiProvider` so routes never mistake
// them for QuickBooks failures (and never answer with an app-level 401).
function providerError(message, status) {
  const err = new Error(message);
  err.status = status;
  err.aiProvider = true;
  return err;
}

// Codex gets only what it needs to run and find its own sign-in. The backend's
// secrets (.env values such as QBO and JWT secrets) are never passed down.
const ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'TEMP', 'TMP', 'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG',
];

function childEnv() {
  const env = {};
  for (const name of ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

// Event item types a Codex run may produce. Anything else (shell commands,
// file changes, web searches) stops the run.
const ALLOWED_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'mcp_tool_call', 'todo_list', 'error']);

const STALE_FILE_MS = 60 * 60 * 1000;
let lastSweep = 0;

// Remove leftovers from runs interrupted by a crash or restart.
function sweepStaleFiles(now = Date.now()) {
  if (now - lastSweep < STALE_FILE_MS) return;
  lastSweep = now;
  let names = [];
  try { names = fs.readdirSync(WORK_DIR); } catch { return; }
  for (const name of names) {
    if (!name.startsWith('instructions-') && !name.startsWith('run-')) continue;
    const target = path.join(WORK_DIR, name);
    try {
      if (now - fs.statSync(target).mtimeMs > STALE_FILE_MS) fs.rmSync(target, { recursive: true, force: true });
    } catch { /* in use or already removed */ }
  }
}

function writeInstructionsFile(systemPrompt) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const file = path.join(WORK_DIR, `instructions-${crypto.randomUUID()}.md`);
  fs.writeFileSync(file, String(systemPrompt || '').trim() || 'Answer the request.', { flag: 'wx', mode: 0o600 });
  return file;
}

// Codex's model catalog marks some models (e.g. gpt-6.1-sol) as reaching
// tools only through its "code mode" host, which is disabled here, so those
// models would see no tools at all. Like Alfred, use a copy of the installed
// Codex's own catalog with only the coding-tool fields removed. Built once per
// installed binary (about a second; `codex debug models` refreshes the model
// list from OpenAI and sends no prompt or company data).
let catalogCache = null;

function stripCodingCatalogFields(catalog) {
  for (const model of catalog?.models || []) {
    delete model.multi_agent_version;
    delete model.apply_patch_tool_type;
    if (model.tool_mode === 'code_mode_only') delete model.tool_mode;
    if (model.model_messages) delete model.model_messages.multi_agent;
    model.experimental_supported_tools = [];
  }
  return catalog;
}

function modelCatalogFile(executable) {
  let stat;
  try { stat = fs.statSync(executable); } catch { return Promise.resolve(null); }
  const key = `${executable}|${stat.size}|${stat.mtimeMs}`;
  if (catalogCache?.key === key && (catalogCache.file === null || fs.existsSync(catalogCache.file))) {
    return Promise.resolve(catalogCache.file);
  }
  return new Promise((resolve) => {
    const onResult = (err, stdout) => {
      try {
        if (err) throw err;
        const catalog = stripCodingCatalogFields(JSON.parse(stdout));
        if (!Array.isArray(catalog?.models) || catalog.models.length === 0) throw new Error('empty model list');
        fs.mkdirSync(WORK_DIR, { recursive: true });
        const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
        const file = path.join(WORK_DIR, `model-catalog-${hash}.json`);
        fs.writeFileSync(file, JSON.stringify(catalog));
        catalogCache = { key, file };
        resolve(file);
      } catch (catalogErr) {
        console.warn('[codex-cli] model catalog unavailable; tools may not reach code-mode-only models:', catalogErr.code || catalogErr.message);
        catalogCache = { key, file: null };
        resolve(null);
      }
    };
    try {
      execFile(executable, ['debug', 'models'], { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024, env: childEnv() }, onResult);
    } catch (err) {
      onResult(err);
    }
  });
}

function bridgeArgs(bridge, timeoutMs) {
  const id = bridge.serverName;
  return [
    '-c', `mcp_servers.${id}.url=${tomlString(bridge.url)}`,
    '-c', `mcp_servers.${id}.bearer_token_env_var=${tomlString(bridge.tokenEnv)}`,
    '-c', `mcp_servers.${id}.default_tools_approval_mode="approve"`,
    '-c', `mcp_servers.${id}.startup_timeout_sec=20`,
    '-c', `mcp_servers.${id}.tool_timeout_sec=${Math.max(30, Math.ceil(timeoutMs / 1000))}`,
  ];
}

function errorPreview(stdout, stderr) {
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const message = event?.error?.message || (String(event?.type || '').includes('error') ? event?.message : null);
      if (typeof message === 'string' && message) return message.slice(0, 400);
    } catch { /* non-JSON line */ }
  }
  return String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
}

/**
 * Run one Codex turn and return the model's final text.
 * @param {Object} options
 * @param {string} options.system - replaces Codex's coding-agent prompt
 * @param {string} options.prompt - user content, sent on stdin (never argv)
 * @param {Object|null} [options.bridge] - { serverName, url, token, tokenEnv }
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number }, toolCalls: number }>}
 */
async function run({ system, prompt, bridge = null, timeoutMs = config.ai.codex.timeoutMs }) {
  const executable = resolveExecutable();
  if (!executable) {
    throw providerError('Codex CLI is not installed. Install it with `npm install -g @openai/codex`, then run `codex login`.', 503);
  }

  // Without the stripped catalog the model may be offered Codex's own coding
  // tools, so refuse rather than run with weaker isolation.
  const catalogFile = await modelCatalogFile(executable);
  if (!catalogFile) {
    throw providerError('Codex CLI could not load its model list, so the assistant was not started. Check that `codex` works in a terminal, then try again.', 503);
  }

  sweepStaleFiles();
  const effort = ALLOWED_EFFORTS.has(config.ai.codex.effort) ? config.ai.codex.effort : 'medium';
  const instructionsFile = writeInstructionsFile(system);
  let cwd = null;
  const cleanup = () => {
    try { fs.unlinkSync(instructionsFile); } catch { /* already gone */ }
    if (cwd) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } }
  };

  let child;
  try {
    cwd = fs.mkdtempSync(path.join(WORK_DIR, 'run-'));
    const args = [
      'exec', '--json',
      '--model', config.ai.codex.model,
      '--skip-git-repo-check',
      '--cd', cwd,
      ...ISOLATION_ARGS,
      '-c', `model_reasoning_effort="${effort}"`,
      '-c', `model_instructions_file=${tomlString(instructionsFile)}`,
      '-c', `model_catalog_json=${tomlString(catalogFile)}`,
      ...SELF_TEXT_ARGS,
      ...(bridge ? bridgeArgs(bridge, timeoutMs) : []),
      '-',
    ];
    const env = childEnv();
    if (bridge) env[bridge.tokenEnv] = bridge.token; // token in env, never argv
    child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    cleanup();
    throw providerError(`Codex CLI could not start: ${err.message}`, 503);
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let buffer = '';
    const messages = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let toolCalls = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn(value);
    };

    const handleLine = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const item = event.item;
      // Fail closed if Codex ever runs anything other than talking and this
      // app's tools (e.g. a shell command or file change after an upgrade).
      if (item?.type && !ALLOWED_ITEM_TYPES.has(item.type)) {
        child.kill();
        finish(reject, providerError(`Codex tried to use a tool this app does not allow (${item.type}). The run was stopped and nothing was changed.`, 502));
        return;
      }
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
        messages.push(item.text);
      }
      if (event.type === 'item.completed' && item?.type === 'mcp_tool_call') toolCalls += 1;
      if (event.type === 'turn.completed' && event.usage) {
        usage.inputTokens += event.usage.input_tokens || 0;
        usage.outputTokens += event.usage.output_tokens || 0;
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.filter(Boolean).forEach(handleLine);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, providerError(`Codex did not finish within ${Math.round(timeoutMs / 1000)} seconds.`, 504));
    }, timeoutMs);

    child.on('error', (err) => finish(reject, providerError(`Codex CLI could not start: ${err.message}`, 503)));

    child.on('close', (code) => {
      if (buffer.trim()) handleLine(buffer.trim());
      if (settled) return;
      if (code !== 0) {
        const preview = errorPreview(stdout, stderr);
        const notSignedIn = /not logged in|log ?in required|codex login|401|unauthorized/i.test(preview);
        if (notSignedIn) statusCache = null;
        finish(reject, providerError(notSignedIn
          ? 'Codex CLI is not signed in. Run `codex login` in a terminal, then try again.'
          : `Codex CLI failed (exit ${code})${preview ? `: ${preview}` : ''}`, notSignedIn ? 503 : 502));
        return;
      }
      const text = messages.join('\n\n').trim();
      if (!text) {
        finish(reject, providerError('Codex finished without a reply. Try again.', 502));
        return;
      }
      finish(resolve, { text, usage, toolCalls });
    });

    // Codex can exit before reading stdin (e.g. a rejected flag); without a
    // listener that EPIPE would crash the backend.
    child.stdin.on('error', () => {});
    child.stdin.end(String(prompt || ''));
  });
}

module.exports = { getStatus, run, resolveExecutable, childEnv, ISOLATION_ARGS, ALLOWED_ITEM_TYPES };
