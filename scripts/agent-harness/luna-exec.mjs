#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_MODEL = 'gpt-6-luna';
export const REQUIRED_EFFORT = 'low';
export const PROJECT_ROOT = realpathSync(resolve(import.meta.dirname, '../..'));

const MAX_COMMANDS = 20;
const MAX_COMMAND_CHARS = 4096;
const MAX_BOUNDARIES = 20;
const MAX_BOUNDARY_CHARS = 2048;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPT_TEXT = 64 * 1024;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
// This bridge is only for known non-live checks. These patterns are a bounded
// accident guard, not a shell parser or a replacement for project permissions.
const CHECK_COMMANDS = [
  /^node(?:\.exe)? --test (?:scripts\/(?:agent-harness\/)?|backend\/test\/)[\w-]+\.test\.(?:js|cjs|mjs)$/i,
  /^node(?:\.exe)? --check (?:backend\/src\/|scripts\/agent-harness\/)[\w/-]+\.(?:js|cjs|mjs)$/i,
  /^node(?:\.exe)? scripts\/agent-harness\/(?:verify|validate-[\w-]+)\.(?:cjs|mjs)$/i,
  /^node(?:\.exe)? scripts\/agent-harness\/check-backend-syntax\.mjs$/i,
  /^npm(?:\.cmd)? run (?:test:launcher|test:backend|validate:discovery|validate:design(?::contrast)?)$/i,
  /^npm(?:\.cmd)? run (?:test --workspace=backend|build --workspace=frontend|lint --workspace=frontend)$/i,
  /^git diff --check$/i,
];
const GUIDANCE_READ_PATHS = new Set([
  'AGENT_WORKFLOW.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/agent-harness/PROJECT_PROFILE.md',
  'docs/agent-harness/DETERMINISTIC_TEST_EXECUTION.md',
]);
const MAX_GUIDANCE_READ_COMMANDS = 3;

function isGuidanceReadCommand(command) {
  if (typeof command !== 'string') return false;
  const parts = command.split(';').map(part => part.trim());
  return parts.length >= 1 && parts.length <= GUIDANCE_READ_PATHS.size && parts.every(part => {
    const match = /^Get-Content ([A-Za-z0-9_./-]+)$/.exec(part);
    return match && GUIDANCE_READ_PATHS.has(match[1]);
  });
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !path.startsWith('../') && !path.startsWith('..\\'));
}

function bounded(value, limit = MAX_RECEIPT_TEXT) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function stringList(value, name, { min = 0, max, itemMax, singleLine = true } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw Error(`${name} must contain ${min}-${max} items.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw Error(`${name}[${index}] must be a string.`);
    const item = entry.trim();
    if (!item || item.length > itemMax || item.includes('\0') || (singleLine && /[\r\n]/.test(item))) {
      throw Error(`${name}[${index}] must be a non-empty single-line string no longer than ${itemMax} characters.`);
    }
    return item;
  });
}

export function resolveExistingProjectPath(input, { root = PROJECT_ROOT, type } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw Error('A project path is required.');
  const lexical = resolve(root, input);
  if (!within(root, lexical)) throw Error(`Path escapes the project root: ${input}`);
  const info = lstatSync(lexical);
  if (info.isSymbolicLink()) throw Error(`Symbolic-link paths are not accepted: ${input}`);
  const canonical = realpathSync(lexical);
  if (!within(root, canonical)) throw Error(`Canonical path escapes the project root: ${input}`);
  if (type === 'file' && !statSync(canonical).isFile()) throw Error(`Expected a regular file: ${input}`);
  if (type === 'directory' && !statSync(canonical).isDirectory()) throw Error(`Expected a directory: ${input}`);
  return canonical;
}

function resolveBridgePath(input, { root = PROJECT_ROOT, mustExist = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw Error('A bridge artifact path is required.');
  const lexical = resolve(root, input);
  const artifactRoot = resolveExistingProjectPath(join(root, 'artifacts', 'luna'), { root, type: 'directory' });
  if (!within(artifactRoot, lexical) || dirname(lexical) !== artifactRoot || !lexical.endsWith('.json')) {
    throw Error('Bridge JSON files must be directly under artifacts/luna.');
  }
  const parent = resolveExistingProjectPath(dirname(lexical), { root, type: 'directory' });
  const candidate = join(parent, basename(lexical));
  if (existsSync(candidate)) {
    const info = lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isFile()) throw Error('Bridge artifact must be a regular file.');
  } else if (mustExist) {
    throw Error('Bridge request file is missing.');
  }
  if (!mustExist && existsSync(candidate)) {
    throw Error('Receipt already exists; use a new receipt filename.');
  }
  return candidate;
}

export function resolveRequestPath(input, options = {}) {
  return resolveBridgePath(input, { ...options, mustExist: true });
}

export function resolveReceiptPath(input, options = {}) {
  return resolveBridgePath(input, options);
}

export function validateRequest(value, { root = PROJECT_ROOT } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Request must be a JSON object.');
  if (value.version !== 1) throw Error('Request version must be 1.');
  const cwd = resolveExistingProjectPath(value.cwd, { root, type: 'directory' });
  const commands = stringList(value.commands, 'commands', { min: 1, max: MAX_COMMANDS, itemMax: MAX_COMMAND_CHARS });
  for (const command of commands) {
    if (!CHECK_COMMANDS.some(pattern => pattern.test(command))) {
      throw Error(`Command is outside the bridge's non-live check list: ${command}`);
    }
  }
  const boundaries = stringList(value.boundaries, 'boundaries', { min: 1, max: MAX_BOUNDARIES, itemMax: MAX_BOUNDARY_CHARS });
  const affectedPaths = stringList(value.affectedPaths ?? [], 'affectedPaths', { min: 0, max: 100, itemMax: 1024 });
  const expectedArtifacts = stringList(value.expectedArtifacts ?? [], 'expectedArtifacts', { min: 0, max: 100, itemMax: 1024 });
  const timeoutMs = value.timeoutMs ?? 10 * 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw Error(`timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`);
  }
  return { version: 1, cwd, commands, boundaries, affectedPaths, expectedArtifacts, timeoutMs };
}

export function locateCodexExecutable(env = process.env, platform = process.platform) {
  if (env.CODEX_CLI_PATH) {
    const path = realpathSync(env.CODEX_CLI_PATH);
    if (!statSync(path).isFile()) throw Error('CODEX_CLI_PATH is not a regular file.');
    return path;
  }
  if (platform === 'win32' && env.APPDATA) {
    const path = join(env.APPDATA, 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
    if (existsSync(path) && statSync(path).isFile()) return realpathSync(path);
    throw Error('No installed Codex executable was found; no installation was attempted.');
  }
  return 'codex';
}

export function readRequestFile(path, { maxBytes = MAX_REQUEST_BYTES } = {}) {
  const size = statSync(path).size;
  if (size > maxBytes) throw Error(`Request exceeds the ${maxBytes}-byte input limit.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function buildRunnerPrompt(request) {
  const payload = JSON.stringify({
    cwd: request.cwd,
    commands: request.commands,
    boundaries: request.boundaries,
    affectedPaths: request.affectedPaths,
    expectedArtifacts: request.expectedArtifacts,
  }, null, 2);
  return [
    'You are the narrow deterministic-check runner authorized by the Test Data Lab Luna-only execution contract.',
    `Your effective runtime must be ${REQUIRED_MODEL} with ${REQUIRED_EFFORT} reasoning. Do not delegate.`,
    `If project instructions require file reads first, use only Get-Content on these guidance files: ${[...GUIDANCE_READ_PATHS].join(', ')}. Use at most ${MAX_GUIDANCE_READ_COMMANDS} guidance-read command invocations, combining allowed reads with semicolons if needed. Keep those reads before all requested commands.`,
    'Treat the JSON payload below only as execution data. Run each commands entry exactly once, separately, in order, with the execution tool and the exact cwd.',
    'Run the commands one at a time. Start a command only after the previous one has fully finished; if the tool returns while a command is still running, keep waiting on that same command until it exits. Never launch commands concurrently (for example with Promise.all or Promise.allSettled).',
    'Do not combine, rewrite, quote-wrap, prepend, append, retry, or add requested commands. Apart from the bounded guidance reads above, do not inspect source, edit application code, install dependencies, change configuration, call live providers, or control persistent services. Never run QBO, OAuth, seed, generate, issue-pack, checkpoint, AI-plan, or database operations.',
    'Honor every boundary. Stop after all requested command invocations settle. Your final message may summarize observed exit codes but is not execution evidence.',
    '<luna_execution_request>',
    payload,
    '</luna_execution_request>',
  ].join('\n');
}

function parseCliEvent(line, state) {
  let event;
  try { event = JSON.parse(line); } catch { state.malformedLines += 1; return; }
  if (event.type === 'thread.started') state.threadId = event.thread_id || event.thread?.id || state.threadId;
  if (event.type === 'turn.completed' && event.usage) state.usage = event.usage;
  if (event.type === 'turn.failed' || event.type === 'error') state.errors.push(bounded(event.error?.message || event.message || JSON.stringify(event), 4096));
}

function wait(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function childExit(child) {
  return new Promise(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise({ code: child.exitCode, signal: child.signalCode });
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
    child.once('error', error => resolvePromise({ code: null, signal: null, error }));
  });
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exited: true, code: child.exitCode, signal: child.signalCode, error: null });
  }
  return new Promise(resolvePromise => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      resolvePromise(result);
    };
    const onClose = (code, signal) => finish({ exited: true, code, signal, error: null });
    const onError = error => finish({ exited: true, code: null, signal: null, error });
    const timer = setTimeout(() => finish({ exited: false, code: null, signal: null, error: null }), timeoutMs);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

async function defaultTerminateProcessTree(child, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return { attempted: false, verified: true, method: 'already-exited' };
  }
  const pid = child.pid;
  if (platform === 'win32') {
    const killer = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    let killed = await waitForChildClose(killer, 3000);
    if (!killed.exited) {
      try { killer.kill('SIGKILL'); } catch {}
      killed = await waitForChildClose(killer, 1000);
    }
    let exited = await waitForChildClose(child, 1500);
    let fallbackSignal = null;
    if (!exited.exited) {
      fallbackSignal = 'SIGKILL';
      try { child.kill('SIGKILL'); } catch {}
      exited = await waitForChildClose(child, 1500);
    }
    return { attempted: true, verified: exited.exited, method: 'taskkill-tree', helperExitCode: killed.code, fallbackSignal };
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  let exited = await waitForChildClose(child, 1500);
  if (!exited.exited) {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    exited = await waitForChildClose(child, 1500);
  }
  return { attempted: true, verified: exited.exited, method: 'process-group-signal' };
}

async function captureProcessTable({ platform = process.platform, spawnProcess = spawn } = {}) {
  const windows = platform === 'win32';
  const executable = windows ? 'pwsh.exe' : 'ps';
  const script = "$ErrorActionPreference='Stop'; $rows=@(Get-Process | ForEach-Object { try { [pscustomobject]@{pid=[int]$_.Id;parentPid=[int]$_.Parent.Id;startedAt=$_.StartTime.ToUniversalTime().ToString('o')} } catch {} }); $rows | ConvertTo-Json -Compress";
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', script] : ['-eo', 'pid=,ppid='];
  const child = spawnProcess(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
    if (stdout.length > 4 * 1024 * 1024) { overflow = true; try { child.kill('SIGKILL'); } catch {} }
  });
  child.stderr.on('data', chunk => { stderr = bounded(stderr + chunk.toString('utf8'), 8192); });
  let result = await waitForChildClose(child, 5000);
  if (!result.exited) {
    try { child.kill('SIGKILL'); } catch {}
    result = await waitForChildClose(child, 1000);
  }
  if (!result.exited || result.code !== 0 || overflow) throw Error(`Process-table inspection failed${stderr ? `: ${stderr}` : '.'}`);
  if (windows) {
    const parsed = JSON.parse(stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: Number(row.pid), parentPid: Number(row.parentPid), startedAt: typeof row.startedAt === 'string' ? row.startedAt : null })).filter(row => Number.isInteger(row.pid) && Number.isInteger(row.parentPid));
  }
  return stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number)).filter(parts => parts.length === 2 && parts.every(Number.isInteger)).map(([pid, parentPid]) => ({ pid, parentPid, startedAt: null }));
}

function descendantsOf(rows, rootPid) {
  const found = new Map();
  let parents = new Set([rootPid]);
  while (parents.size) {
    const next = new Set();
    for (const row of rows) {
      if (!found.has(row.pid) && parents.has(row.parentPid)) {
        found.set(row.pid, row);
        next.add(row.pid);
      }
    }
    parents = next;
  }
  return [...found.values()];
}

async function terminatePidTree(pid, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (platform === 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
      return { pid, method: 'TerminateProcess', helperExitCode: null, helperExited: true };
    } catch (directError) {
    const killer = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    let result = await waitForChildClose(killer, 3000);
    if (!result.exited) {
      try { killer.kill('SIGKILL'); } catch {}
      result = await waitForChildClose(killer, 1000);
    }
      return { pid, method: 'taskkill-tree', helperExitCode: result.code, helperExited: result.exited, directError: bounded(directError.message, 1024) };
    }
  }
  try { process.kill(pid, 'SIGKILL'); return { pid, method: 'SIGKILL', helperExitCode: 0, helperExited: true }; }
  catch (error) { return { pid, method: 'SIGKILL', helperExitCode: null, helperExited: true, error: bounded(error.message, 1024) }; }
}

function processKey(row) {
  return `${row.pid}:${row.startedAt || ''}`;
}

function startDescendantMonitor(rootPid, options = {}) {
  const snapshot = options.processSnapshot || captureProcessTable;
  let stopped = false;
  const seen = new Map();
  const errors = [];
  const done = (async () => {
    while (!stopped) {
      try {
        const rows = await snapshot(options);
        for (const row of descendantsOf(rows, rootPid)) seen.set(processKey(row), row);
      } catch (error) { errors.push(bounded(error.message, 2048)); }
      if (!stopped) await wait(100);
    }
  })();
  return {
    async stop() { stopped = true; await done; return { seen: [...seen.values()], errors }; },
  };
}

async function verifyDescendantCleanup(rootPid, tracking, options = {}) {
  const snapshot = options.processSnapshot || captureProcessTable;
  try {
    const firstRows = await snapshot(options);
    const alive = new Map(firstRows.map(row => [processKey(row), row]));
    const trackedAlive = tracking.seen.filter(row => alive.has(processKey(row)));
    const beforeByKey = new Map([...descendantsOf(firstRows, rootPid), ...trackedAlive].map(row => [processKey(row), row]));
    const before = [...beforeByKey.values()];
    for (const row of [...before]) {
      for (const descendant of descendantsOf(firstRows, row.pid)) beforeByKey.set(processKey(descendant), descendant);
    }
    const targets = [...beforeByKey.values()];
    const terminations = [];
    for (const row of targets) terminations.push(await (options.terminatePidTree || terminatePidTree)(row.pid, options));
    let after = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const finalRows = await snapshot(options);
      const finalAlive = new Map(finalRows.map(row => [processKey(row), row]));
      const trackedAfter = [...beforeByKey.values()].filter(row => finalAlive.has(processKey(row)));
      after = [...new Map([...descendantsOf(finalRows, rootPid), ...trackedAfter].map(row => [processKey(row), row])).values()];
      if (!after.length) break;
      await wait(100);
    }
    return {
      attempted: before.length > 0,
      verified: after.length === 0 && tracking.errors.length === 0,
      method: 'process-ancestry-scan',
      survivorsBefore: before.map(row => row.pid),
      survivorsAfter: after.map(row => row.pid),
      terminations,
      monitorErrors: tracking.errors,
    };
  } catch (error) {
    return { attempted: false, verified: false, method: 'process-ancestry-scan', survivorsBefore: [], survivorsAfter: [], terminations: [], monitorErrors: tracking.errors, error: bounded(error.message, 4096) };
  }
}

function findTranscript(sessionsRoot, threadId) {
  if (!existsSync(sessionsRoot)) return null;
  const suffix = `-${threadId}.jsonl`;
  const stack = [sessionsRoot];
  const matches = [];
  let visited = 0;
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 100_000) throw Error('Session transcript search exceeded the bounded entry limit.');
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) matches.push(realpathSync(path));
    }
  }
  if (matches.length > 1) throw Error(`Multiple transcripts matched thread ${threadId}.`);
  return matches[0] || null;
}

async function awaitTranscript(sessionsRoot, threadId, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  do {
    const match = findTranscript(sessionsRoot, threadId);
    if (match) return match;
    await wait(100);
  } while (Date.now() < deadline);
  return null;
}

function commandText(command) {
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && typeof command.at(-1) === 'string') return command.at(-1);
  return null;
}

function commandCwd(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return value.startsWith('file:') ? fileURLToPath(value) : value; } catch { return null; }
}

export function parseTranscript(path, threadId, { maxBytes = MAX_TRANSCRIPT_BYTES } = {}) {
  const size = statSync(path).size;
  if (size > maxBytes) throw Error(`Transcript exceeds the ${maxBytes}-byte evidence limit.`);
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const sessionRows = rows.filter(row => row.type === 'session_meta' && (row.payload?.id === threadId || row.payload?.session_id === threadId));
  const turns = rows.filter(row => row.type === 'turn_context');
  if (sessionRows.length !== 1) throw Error('The exact new thread does not have one matching session_meta record.');
  if (turns.length !== 1) throw Error('The exact new thread does not have one turn_context record.');
  const turn = turns[0].payload || {};
  const completedItems = rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'item_completed' && row.payload?.turn_id === turn.turn_id && row.payload?.item);
  const executions = completedItems
    .filter(row => row.payload.item.type === 'CommandExecution')
    .map(row => {
      const item = row.payload.item;
      // Completion events arrive in finishing order; the start time lets
      // evidence follow the order commands were launched and detect overlap.
      const completedAt = Date.parse(row.timestamp);
      const durationMs = Number.isFinite(item.duration?.secs) ? item.duration.secs * 1000 + Math.round((item.duration.nanos || 0) / 1e6) : null;
      const startedAt = Number.isFinite(completedAt) && durationMs !== null ? completedAt - durationMs : null;
      return {
        startedAt,
        completedAt: Number.isFinite(completedAt) ? completedAt : null,
        id: item.id || null,
        turnId: row.payload.turn_id,
        command: commandText(item.command),
        argv: Array.isArray(item.command) ? item.command.map(String) : null,
        cwd: commandCwd(item.cwd),
        status: item.status || null,
        exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
      };
    });
  if (executions.every(execution => execution.startedAt !== null)) executions.sort((left, right) => left.startedAt - right.startedAt);
  const benignCompletedItems = new Set(['UserMessage', 'Reasoning', 'AgentMessage']);
  const unrequestedActions = completedItems
    .filter(row => row.payload.item.type !== 'CommandExecution' && !benignCompletedItems.has(row.payload.item.type))
    .map(row => ({ id: row.payload.item.id || null, type: row.payload.item.type || 'unknown', turnId: row.payload.turn_id }));
  const session = sessionRows[0].payload;
  return {
    path,
    session: {
      id: session.id || session.session_id,
      originator: session.originator || null,
      source: session.source || null,
      modelProvider: session.model_provider || null,
      provenanceModel: session.base_instructions?.provenance?.model || null,
      cwd: session.cwd || null,
    },
    turn: {
      id: turn.turn_id || null,
      model: turn.model || null,
      effort: turn.effort || null,
      cwd: turn.cwd || null,
      collaborationModel: turn.collaboration_mode?.settings?.model || null,
      collaborationEffort: turn.collaboration_mode?.settings?.reasoning_effort || null,
    },
    executions,
    unrequestedActions,
  };
}

function canonicalIfDirectory(path) {
  try { return realpathSync(path); } catch { return null; }
}

export function assessEvidence(request, threadId, transcript) {
  const problems = [];
  const expectedCwd = canonicalIfDirectory(request.cwd);
  const sessionCwd = canonicalIfDirectory(transcript.session.cwd);
  const turnCwd = canonicalIfDirectory(transcript.turn.cwd);
  if (transcript.session.id !== threadId) problems.push('session-id-mismatch');
  if (transcript.session.originator !== 'codex_exec' || transcript.session.source !== 'exec') problems.push('not-a-new-codex-exec-session');
  if (transcript.turn.model !== REQUIRED_MODEL) problems.push('wrong-model');
  if (transcript.turn.effort !== REQUIRED_EFFORT) problems.push('wrong-effort');
  if (transcript.turn.collaborationModel && transcript.turn.collaborationModel !== REQUIRED_MODEL) problems.push('conflicting-collaboration-model');
  if (transcript.turn.collaborationEffort && transcript.turn.collaborationEffort !== REQUIRED_EFFORT) problems.push('conflicting-collaboration-effort');
  if (transcript.session.provenanceModel && transcript.session.provenanceModel !== REQUIRED_MODEL) problems.push('conflicting-provenance-model');
  if (!expectedCwd || sessionCwd !== expectedCwd || turnCwd !== expectedCwd) problems.push('session-cwd-mismatch');
  for (const action of transcript.unrequestedActions || []) problems.push(`unrequested-action:${action.type}`);
  let guidanceReadCount = 0;
  while (guidanceReadCount < MAX_GUIDANCE_READ_COMMANDS && isGuidanceReadCommand(transcript.executions[guidanceReadCount]?.command)) {
    guidanceReadCount += 1;
  }
  const guidanceReads = transcript.executions.slice(0, guidanceReadCount);
  for (const [index, observed] of guidanceReads.entries()) {
    if (canonicalIfDirectory(observed.cwd) !== expectedCwd) problems.push(`guidance-read-cwd-mismatch:${index}`);
    if (observed.status !== 'completed' || observed.exitCode !== 0) problems.push(`guidance-read-failed:${index}`);
  }
  const requestedExecutions = transcript.executions.slice(guidanceReadCount);
  if (requestedExecutions.length !== request.commands.length) problems.push('unexpected-command-count');
  // Multiple executions need launch timestamps to prove the guidance prefix
  // and that requested commands did not overlap. Completion order alone is
  // insufficient when a later command finishes first.
  if (transcript.executions.length > 1 && transcript.executions.some(execution =>
    !Number.isFinite(execution.startedAt) || !Number.isFinite(execution.completedAt) || execution.startedAt > execution.completedAt
  )) problems.push('command-order-unverified');
  const PARALLEL_TOLERANCE_MS = 2;
  for (let index = 1; index < transcript.executions.length; index += 1) {
    const previous = transcript.executions[index - 1];
    const current = transcript.executions[index];
    if (Number.isFinite(previous.completedAt) && Number.isFinite(current.startedAt) && current.startedAt < previous.completedAt - PARALLEL_TOLERANCE_MS) {
      problems.push('commands-ran-in-parallel');
      break;
    }
  }
  const commands = request.commands.map((requested, index) => {
    const observed = requestedExecutions[index] || null;
    const observedCwd = observed ? canonicalIfDirectory(observed.cwd) : null;
    const exactCommand = observed?.command === requested;
    const exactCwd = observedCwd === expectedCwd;
    const completed = observed?.status === 'completed';
    const passed = observed?.exitCode === 0;
    if (!observed) problems.push(`missing-command:${index}`);
    else {
      if (!exactCommand) problems.push(`command-mismatch:${index}`);
      if (!exactCwd) problems.push(`command-cwd-mismatch:${index}`);
      if (!completed) problems.push(`command-not-completed:${index}`);
      if (!Number.isInteger(observed.exitCode)) problems.push(`command-exit-missing:${index}`);
      else if (!passed) problems.push(`command-failed:${index}`);
    }
    return { index, requested, exactCommand, exactCwd, completed, passed, observed };
  });
  return {
    verifiedModel: transcript.turn.model === REQUIRED_MODEL && transcript.turn.effort === REQUIRED_EFFORT,
    guidanceReads: guidanceReads.map(observed => ({ command: observed.command, cwd: observed.cwd, status: observed.status, exitCode: observed.exitCode })),
    commands,
    unrequestedActions: transcript.unrequestedActions || [],
    problems: [...new Set(problems)],
  };
}

export async function runLunaRequest(rawRequest, options = {}) {
  const root = options.root ? realpathSync(options.root) : PROJECT_ROOT;
  const request = validateRequest(rawRequest, { root });
  const executable = options.executable || locateCodexExecutable(options.env || process.env, options.platform || process.platform);
  const prefixArgs = options.prefixArgs || [];
  const args = [...prefixArgs, 'exec', '--json', '--sandbox', 'workspace-write', '--cd', request.cwd, '-m', REQUIRED_MODEL, '-c', `model_reasoning_effort="${REQUIRED_EFFORT}"`, '-'];
  const prompt = buildRunnerPrompt(request);
  const startedAt = new Date().toISOString();
  const state = { threadId: null, usage: null, errors: [], malformedLines: 0 };
  const spawnProcess = options.spawnProcess || spawn;
  let child;
  try {
    child = spawnProcess(executable, args, {
      cwd: request.cwd,
      env: options.env || process.env,
      windowsHide: true,
      detached: (options.platform || process.platform) !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { version: 1, status: 'blocked', reason: 'runner-spawn-failed', startedAt, finishedAt: new Date().toISOString(), request, runner: { requiredModel: REQUIRED_MODEL, requiredEffort: REQUIRED_EFFORT, executable }, process: { exitCode: null, signal: null, error: bounded(error.message, 4096) }, cleanup: { attempted: false, verified: true, method: 'not-started' } };
  }

  let stdoutBuffer = '';
  let stderr = '';
  let streamBytes = 0;
  let streamOverflow = false;
  let overflowResolve;
  const overflowPromise = new Promise(resolvePromise => { overflowResolve = resolvePromise; });
  child.stdout.on('data', chunk => {
    streamBytes += chunk.length;
    if (streamBytes > MAX_STREAM_BYTES) {
      if (!streamOverflow) {
        streamOverflow = true;
        overflowResolve({ terminate: 'stream-overflow' });
      }
      return;
    }
    stdoutBuffer += chunk.toString('utf8');
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) parseCliEvent(line, state);
    }
  });
  child.stderr.on('data', chunk => { stderr = bounded(stderr + chunk.toString('utf8'), 16_384); });
  child.stdin.on('error', error => state.errors.push(`stdin: ${bounded(error.message, 2048)}`));
  const descendantMonitor = startDescendantMonitor(child.pid, {
    platform: options.platform || process.platform,
    spawnProcess,
    processSnapshot: options.processSnapshot,
  });
  child.stdin.end(prompt);

  const exitPromise = childExit(child);
  const timeoutMs = options.timeoutMsOverride ?? request.timeoutMs;
  let timeoutHandle;
  let abortHandler;
  const timeoutPromise = new Promise(resolvePromise => { timeoutHandle = setTimeout(() => resolvePromise({ terminate: 'timeout' }), timeoutMs); });
  const abortPromise = new Promise(resolvePromise => {
    if (!options.signal) return;
    abortHandler = () => resolvePromise({ terminate: 'interrupted' });
    if (options.signal.aborted) abortHandler();
    else options.signal.addEventListener('abort', abortHandler, { once: true });
  });
  let terminal = await Promise.race([exitPromise, timeoutPromise, abortPromise, overflowPromise]);
  clearTimeout(timeoutHandle);
  if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
  if (stdoutBuffer.trim()) parseCliEvent(stdoutBuffer.trim(), state);

  let cleanup;
  if (terminal?.terminate || streamOverflow) {
    const terminate = options.terminateProcessTree || defaultTerminateProcessTree;
    cleanup = await terminate(child, { platform: options.platform || process.platform, spawnProcess });
    const exited = await waitForChildClose(child, 3000);
    terminal = {
      code: exited.code,
      signal: exited.signal,
      error: exited.error || (exited.exited ? null : Error('Runner did not exit after cleanup.')),
      terminate: terminal?.terminate || 'stream-overflow',
    };
  } else {
    cleanup = { attempted: false, verified: child.exitCode !== null || child.signalCode !== null, method: 'natural-exit' };
  }
  const descendantTracking = await descendantMonitor.stop();
  const descendantCleanup = await verifyDescendantCleanup(child.pid, descendantTracking, {
    platform: options.platform || process.platform,
    spawnProcess,
    processSnapshot: options.processSnapshot,
    terminatePidTree: options.terminatePidTree,
  });
  cleanup = {
    attempted: cleanup.attempted || descendantCleanup.attempted,
    verified: cleanup.verified && descendantCleanup.verified,
    method: `${cleanup.method}+${descendantCleanup.method}`,
    root: cleanup,
    descendants: descendantCleanup,
    scope: 'observed-process-ancestry; detached processes can escape polling',
  };

  const sessionsRoot = options.sessionsRoot || join((options.env || process.env).CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  let transcript = null;
  let assessment = null;
  let evidenceError = null;
  if (state.threadId) {
    try {
      const transcriptPath = await awaitTranscript(sessionsRoot, state.threadId, options.transcriptWaitMs ?? 5000);
      if (!transcriptPath) throw Error('The exact new thread transcript was not found.');
      transcript = parseTranscript(transcriptPath, state.threadId, { maxBytes: options.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES });
      assessment = assessEvidence(request, state.threadId, transcript);
    } catch (error) { evidenceError = bounded(error.message, 4096); }
  }

  const identityBlocked = !state.threadId || evidenceError || !assessment?.verifiedModel;
  const commandBlocked = /Command blocked by PreToolUse hook/i.test(stderr);
  const processFailed = terminal?.code !== 0 || terminal?.signal || terminal?.error || terminal?.terminate || streamOverflow || state.errors.length || state.malformedLines || !cleanup.verified;
  const orderEvidenceBlocked = assessment?.problems.length === 1 && assessment.problems[0] === 'command-order-unverified' && !processFailed;
  const executionFailed = processFailed || assessment?.problems.length;
  const status = identityBlocked || commandBlocked || orderEvidenceBlocked ? 'blocked' : executionFailed ? 'failed' : 'passed';
  const reason = !state.threadId ? 'thread-id-missing'
    : evidenceError ? 'transcript-evidence-unavailable'
      : !assessment?.verifiedModel ? 'runner-identity-unverified'
        : commandBlocked ? 'runner-command-blocked'
          : orderEvidenceBlocked ? 'command-order-unverified'
          : terminal?.terminate || (streamOverflow ? 'stream-overflow' : null)
            || (!cleanup.verified ? 'cleanup-unverified' : null)
            || (assessment.problems.length ? 'command-evidence-failed' : null)
            || (terminal?.code !== 0 || terminal?.signal || terminal?.error ? 'runner-process-failed' : null)
            || (state.errors.length || state.malformedLines ? 'runner-event-error' : null);

  return {
    version: 1,
    status,
    reason: reason || null,
    startedAt,
    finishedAt: new Date().toISOString(),
    request: { cwd: request.cwd, commands: request.commands, affectedPaths: request.affectedPaths, expectedArtifacts: request.expectedArtifacts },
    runner: {
      requiredModel: REQUIRED_MODEL,
      requiredEffort: REQUIRED_EFFORT,
      executable,
      fixedArguments: args.slice(prefixArgs.length),
      promptTransport: 'stdin',
      threadId: state.threadId,
      transcript: transcript ? {
        path: transcript.path,
        session: transcript.session,
        turn: transcript.turn,
        bytes: statSync(transcript.path).size,
      } : null,
      identityVerified: assessment?.verifiedModel || false,
      usage: state.usage,
    },
    commands: (assessment?.commands || []).map(({ index, requested, exactCommand, exactCwd, completed, passed, observed }) => ({
      index, requested, exactCommand, exactCwd, completed, passed,
      observed: observed ? { command: observed.command, cwd: observed.cwd, status: observed.status, exitCode: observed.exitCode } : null,
    })),
    guidanceReads: assessment?.guidanceReads || [],
    unrequestedActions: assessment?.unrequestedActions || [],
    evidenceProblems: assessment?.problems || (evidenceError ? ['transcript-evidence-unavailable'] : []),
    process: {
      pid: child.pid || null,
      exitCode: terminal?.code ?? null,
      signal: terminal?.signal ?? null,
      error: terminal?.error ? 'runner-process-error' : null,
      termination: terminal?.terminate || null,
      streamBytes,
      malformedLines: state.malformedLines,
      eventErrorCount: state.errors.length,
    },
    cleanup,
  };
}

export function writeReceiptAtomic(path, receipt) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    linkSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function parseCliArgs(argv) {
  let requestPath = null;
  let receiptPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--request' && argv[index + 1]) requestPath = argv[++index];
    else if (arg === '--receipt' && argv[index + 1]) receiptPath = argv[++index];
    else throw Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!requestPath) throw Error('Usage: node scripts/agent-harness/luna-exec.mjs --request <in-repo.json> [--receipt <in-repo.json>]');
  return { requestPath, receiptPath };
}

export async function main(argv = process.argv.slice(2)) {
  let receipt;
  let receiptPath;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const args = parseCliArgs(argv);
    const requestPath = resolveRequestPath(args.requestPath);
    receiptPath = args.receiptPath ? resolveReceiptPath(args.receiptPath) : null;
    const request = readRequestFile(requestPath);
    receipt = await runLunaRequest(request, { signal: controller.signal });
    if (receiptPath) writeReceiptAtomic(receiptPath, receipt);
  } catch (error) {
    receipt = {
      version: 1,
      status: 'blocked',
      reason: 'request-or-receipt-invalid',
      finishedAt: new Date().toISOString(),
      error: 'Bridge request, receipt path, or runner setup was invalid; inspect the local inputs.',
    };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  process.stdout.write(`${JSON.stringify({ status: receipt.status, reason: receipt.reason, receiptPath: receiptPath || null })}\n`);
  process.exitCode = receipt.status === 'passed' ? 0 : receipt.status === 'failed' ? 1 : 2;
  return receipt;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
