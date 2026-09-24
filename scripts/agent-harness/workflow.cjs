'use strict';

// Coding-agent hooks only. No app services, network calls, transcript reads, or logging.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const MAX_INPUT_BYTES = 1024 * 1024;
const CORE_ROLES = ['harness-worker', 'harness-reviewer', 'harness-security-reviewer'];

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
function sensitiveFile(value) {
  const name = String(value || '').replace(/["']/g, '').split(/[\\/:]/).pop().toLowerCase();
  if (/^\.env\.(?:example|sample|template)(?:\.|$)/.test(name)) return false;
  return /^\.env(?:\.|$)/.test(name) || ['.tokens.json', 'id_rsa', 'id_ed25519'].includes(name);
}

// A bounded shell lexer, not a shell interpreter. Keep quoted arguments together so
// searching for a dangerous command in documentation does not execute the policy.
function shellSegments(source) {
  const segments = [];
  let args = [], token = '', started = false, quote = '';
  function flushToken() { if (started) args.push(token); token = ''; started = false; }
  function flushSegment() { flushToken(); if (args.length) segments.push(args); args = []; }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) {
        if (source[i + 1] === quote) { token += quote; i++; }
        else quote = '';
      } else if ((ch === '`' || (ch === '\\' && quote === '"')) && source[i + 1] === quote) {
        token += source[++i];
      } else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === '#' && !started) { while (i < source.length && source[i] !== '\n') i++; flushSegment(); continue; }
    if (/\s/.test(ch)) { if (ch === '\n' || ch === '\r') flushSegment(); else flushToken(); continue; }
    if (';&|(){}'.includes(ch)) { flushSegment(); continue; }
    token += ch; started = true;
  }
  flushSegment();
  return segments;
}

function commandDecision(command, root = ROOT, depth = 0, policy = {}) {
  if (depth > 3) return { warning: 'Nested shell command: inspect the actual action and existing user authorization before proceeding.' };
  let warning = '';
  for (const tokens of shellSegments(command)) {
    const args = tokens.slice();
    let exe = path.win32.basename(args.shift() || '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (['sudo', 'env', 'command'].includes(exe) && args.length) exe = (args.shift() || '').toLowerCase();
    if (['powershell', 'pwsh', 'bash', 'sh', 'cmd'].includes(exe)) {
      const at = args.findIndex(a => /^(-command|-c|\/c)$/i.test(a));
      if (at >= 0) {
        const nested = commandDecision(args.slice(at + 1).join(' '), root, depth + 1, policy);
        if (nested.block) return nested;
        warning ||= nested.warning || '';
      }
    }
    if (exe === 'git') {
      // Skip common Git global options and their values before finding the subcommand.
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) {
        i += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[i]) ? 2 : 1;
      }
      const sub = (args[i] || '').toLowerCase();
      const rest = args.slice(i + 1);
      if (sub === 'reset' && rest.some(a => /^--hard(?:=|$)/.test(a))) return { block: 'Destructive Git reset blocked: preserve concurrent and uncommitted work; use a scoped, reviewable recovery plan.' };
      if (sub === 'clean' && !rest.some(a => a === '--dry-run' || /^-[^-]*n/.test(a)) && rest.some(a => a === '--force' || /^-[^-]*f/.test(a))) return { block: 'Forced Git clean blocked: it can delete untracked work. Inspect the dry-run and remove only explicitly authorized exact paths.' };
      if (sub === 'push' && rest.some(a => a === '-f' || a.startsWith('--force') || a.startsWith('+'))) return { block: 'History-rewriting push blocked. Use an ordinary push or a separately reviewed recovery procedure.' };
      if (sub === 'branch' && rest.some(a => a === '-D' || a === '--force' || a === '-f')) return { block: 'Forced branch deletion/replacement blocked. Preserve branch ownership and use the project recovery procedure.' };
      if (sub === 'add' && rest.some(a => ['.', ':', ':/.', ':/', '*', '--all', '-A'].includes(a))) return { block: 'Broad Git staging blocked: stage exact owned paths or hunks and inspect the staged diff.' };
      if (sub === 'show' && rest.some(sensitiveFile)) return { block: 'Secret-file dump blocked. Inspect setting names or a sanitized example instead of printing credentials.' };
      if (['commit', 'push', 'checkout', 'switch', 'restore', 'reset', 'branch', 'worktree', 'merge', 'rebase'].includes(sub)) {
        warning ||= 'Git boundary: commit and push only when the user requested them. Existing authorization persists; do not ask again. Preserve the project branch/upstream policy and inspect only owned staged changes.';
      }
    }
    if (['cat', 'type', 'more', 'get-content', 'gc', 'head', 'tail', 'bat'].includes(exe) && args.some(sensitiveFile)) {
      return { block: 'Secret-file dump blocked. Use setting names, sanitized examples, or a purpose-built credential interface.' };
    }
    if (['rg', 'grep', 'findstr', 'select-string'].includes(exe) && !args.includes('--files')) {
      // The first ordinary argument is usually the search pattern, not a file.
      const ordinary = args.filter(a => !a.startsWith('-'));
      if (ordinary.slice(1).some(sensitiveFile)) return { block: 'Search output from a secret file is blocked. Inspect a sanitized example or report only missing setting names.' };
    }
    if (['npm', 'pnpm', 'yarn', 'npx', 'node', 'vite', 'nodemon', 'electron', 'just', 'docker', 'docker-compose', 'systemctl', 'stop-process', 'taskkill', 'kill', 'killall', 'pkill', 'start-process'].includes(exe)) {
      const joined = args.join(' ');
      const harmlessPreview = ['npm','pnpm','yarn'].includes(exe) && args.some(a => ['dev:preview','dev:check'].includes(a));
      const configuredEntrypoint = exe === 'node' && (policy.runtime_entrypoints || []).some(entry => args.some(a => a.replace(/\\/g,'/').endsWith(entry))) && !args.some(a => ['--preview','--check'].includes(a));
      if (!harmlessPreview && (configuredEntrypoint || /\b(?:dev(?::[\w-]+)?|start|restart|stop|up|down|relay|tunnel|serve|preview|db:prepare|backup|restore|seed|connect|ar-chain|ap-chain|rate-limits|sales-order|spike:[\w-]+)\b/i.test(joined) || ['stop-process', 'taskkill', 'kill', 'killall', 'pkill', 'nodemon', 'electron', 'start-process'].includes(exe))) {
        warning ||= 'Service/data boundary: confirm the exact target and user authorization already given in this conversation. Reuse that authorization without another approval request. Otherwise do read-only discovery; do not start, stop, replace, or mutate a persistent service or real data. A hook reminder does not grant permission.';
      }
    }
    if (['curl','invoke-restmethod','invoke-webrequest','iwr','irm'].includes(exe) && (policy.external_operation_routes || []).some(route => args.some(a => a.includes(route)))) {
      warning ||= 'Project data boundary: this request reaches a protected application operation. Verify the exact environment/company, side effects, and existing user authorization; code-edit permission does not authorize live data writes. Do not print private responses.';
    }
    if (['rm', 'rmdir', 'rd', 'remove-item', 'del', 'erase'].includes(exe)) {
      const targets = args.filter(a => !a.startsWith('-') && !/^\/[sq]$/i.test(a));
      for (const target of targets) {
        const resolved = path.resolve(root, target);
        const relative = path.relative(resolved, root);
        if (target === '*' || target === '/' || target === '\\' || !relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
          return { block: 'Workspace-root or ancestor deletion blocked. Verify the resolved path and use only exact authorized descendants.' };
        }
      }
      warning ||= 'Deletion boundary: verify the resolved target, existing user authorization, and ownership. Preserve unrelated data and concurrent work.';
    }
  }
  return warning ? { warning } : {};
}

function preToolUse(input, root = ROOT) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string') return deny('Harness input is invalid; the command was not inspected. Retry with the normal client tool interface.');
  const tool = input.tool_name;
  const args = input.tool_input || {};
  if (/(?:^|__)(?:read|read_file)$/i.test(tool) && sensitiveFile(args.file_path || args.path)) return deny('Secret-file read blocked. Use sanitized examples or inspect setting names without revealing values.');
  if (!/(?:bash|powershell|exec_command|run_shell|shell_command)$/i.test(tool)) return null;
  const command = args.command ?? args.cmd;
  if (typeof command !== 'string') return deny('Harness shell input has no command string; the action was not inspected.');
  const policyFile = path.join(root, 'scripts/agent-harness/project-policy.json');
  const policy = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : {};
  const decision = commandDecision(command, root, 0, policy);
  if (decision.block) return deny(decision.block);
  return decision.warning ? context('PreToolUse', decision.warning) : null;
}

function promptText(root = ROOT) {
  const common = fs.readFileSync(path.join(root, 'docs/agent-harness/PROMPT_REMINDER.md'), 'utf8').trim();
  const local = path.join(root, 'docs/agent-harness/PROMPT_ADDENDUM.md');
  return common + (fs.existsSync(local) ? '\n\n' + fs.readFileSync(local, 'utf8').trim() : '');
}
function sessionStart(root = ROOT) {
  const required = ['AGENTS.md', 'CLAUDE.md', 'AGENT_WORKFLOW.md', 'AGENT_HARNESS.md', 'docs/agent-harness/PROJECT_PROFILE.md', 'docs/agent-harness/PROMPT_REMINDER.md'];
  for (const role of CORE_ROLES) required.push(`.codex/agents/${role}.toml`, `.claude/agents/${role}.md`);
  const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
  return context('SessionStart', missing.length
    ? 'Coding harness files missing: ' + missing.join(', ') + '. Report the missing capability; do not claim the full harness is available.'
    : 'Shared coding harness files are present. Read AGENT_WORKFLOW.md and relevant project rules. Core roles: ' + CORE_ROLES.join(', ') + '. File presence is not role-discovery or permission proof. Commit and push only when requested.');
}

async function main(mode = process.argv[2], root = ROOT) {
  if (mode === 'prompt') { console.log(JSON.stringify(context('UserPromptSubmit', promptText(root)))); return; }
  if (mode === 'session-start') { console.log(JSON.stringify(sessionStart(root))); return; }
  if (mode !== 'pre-tool-use') throw new Error('Unknown coding harness mode.');
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) { console.log(JSON.stringify(deny('Harness input exceeds its bounded inspection limit. Split the tool call into smaller scoped operations.'))); return; }
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { console.log(JSON.stringify(deny('Harness received malformed JSON. No command was inspected; use the normal client tool interface.'))); return; }
  const result = preToolUse(parsed, root);
  if (result) console.log(JSON.stringify(result));
}
module.exports = { CORE_ROLES, sensitiveFile, shellSegments, commandDecision, preToolUse, promptText, sessionStart, main };
if (require.main === module) main().catch(() => {
  if (process.argv[2] === 'pre-tool-use') console.log(JSON.stringify(deny('Coding harness inspection failed. Investigate the hook before retrying this action.')));
  else { console.error('Coding harness configuration could not be read.'); process.exitCode = 1; }
});
