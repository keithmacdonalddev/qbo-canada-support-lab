'use strict';
// Development-only continuation guard. No commands, providers, transcripts or app imports.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..'), UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_BYTES = 65536, MAX_PROOF_BYTES = 2000000, MAX_BLOCKS = 6, MAX_UNCHANGED = 2, MAX_WINDOW_MS = 900000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function inside(root, value) { const rel = path.relative(root, value); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); }
function safePath(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-zA-Z0-9_./-]+$/.test(relative)) throw Error('Invalid guard path');
  const realRoot = fs.realpathSync(root), target = path.resolve(realRoot, relative);
  if (!inside(realRoot, target)) throw Error('Guard path escapes project');
  let current = realRoot;
  for (const part of relative.split('/')) { current = path.join(current, part); try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('Guard paths cannot traverse links'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return target;
}
function statePath(root, sessionId) {
  if (!UUID.test(sessionId || '')) throw Error('An exact session ID is required');
  const directory = safePath(root, 'artifacts/agent-continuation'); fs.mkdirSync(directory, { recursive: true });
  return safePath(root, 'artifacts/agent-continuation/' + sessionId + '.json');
}
function readJson(file) { const stat = fs.statSync(file); if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('Guard state exceeds its bound'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  const body = JSON.stringify(value); if (Buffer.byteLength(body) > MAX_BYTES) throw Error('Guard state exceeds its bound');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function locked(root, sessionId, work) {
  const file = statePath(root, sessionId), lock = file + '.lock'; let descriptor;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); return work(file); }
  finally { if (descriptor !== undefined) { fs.closeSync(descriptor); fs.unlinkSync(lock); } }
}
function validate(state, sessionId) {
  if (!state || state.version !== 1 || state.sessionId !== sessionId || !['active','paused','cancelled'].includes(state.status) || typeof state.objective !== 'string' || !state.objective.trim() || state.objective.length > 2000 || !Number.isFinite(Date.parse(state.startedAt)) || !Number.isFinite(Date.parse(state.deadline)) || Date.parse(state.deadline) <= Date.parse(state.startedAt) || Date.parse(state.deadline) - Date.parse(state.startedAt) > MAX_WINDOW_MS || !Array.isArray(state.requirements) || !state.requirements.length || state.requirements.length > 20 || !Array.isArray(state.nextActions) || state.nextActions.length > 20 || !Number.isInteger(state.blocks) || state.blocks < 0 || !Number.isInteger(state.unchanged) || state.unchanged < 0) throw Error('Invalid continuation contract');
  if (!Array.isArray(state.decisions) || state.decisions.length > 20 || state.decisions.some(value=>typeof value !== 'string' || value.length > 1000)) throw Error('Invalid settled decisions');
  const ids = new Set();
  for (const requirement of state.requirements) { if (!/^[a-z0-9-]{1,80}$/.test(requirement.id || '') || ids.has(requirement.id) || !['pending','verified'].includes(requirement.status)) throw Error('Invalid outcome requirement'); ids.add(requirement.id); }
  for (const action of state.nextActions) if (!/^[a-z0-9-]{1,80}$/.test(action.id || '') || !['ready','blocked','done'].includes(action.status) || !['existing','required'].includes(action.authorization)) throw Error('Invalid continuation action');
  return state;
}
function proofMatches(root, proof) {
  if (!proof || typeof proof.path !== 'string' || /(?:token|secret|credential)/i.test(path.basename(proof.path)) || !/^artifacts[/](?:goal-realization|luna|agent-continuation-evidence)[/][a-zA-Z0-9_-]+[.]json$/.test(proof.path) || !/^[a-f0-9]{64}$/.test(proof.sha256 || '')) return false;
  try { const file = safePath(root, proof.path), stat = fs.statSync(file); return stat.isFile() && stat.size <= MAX_PROOF_BYTES && digest(fs.readFileSync(file)) === proof.sha256; } catch { return false; }
}
function arm(root, sessionId, contract, now = Date.now()) {
  return locked(root, sessionId, file => {
    if (fs.existsSync(file)) throw Error('A session contract already exists; its limits cannot be reset');
    const state = validate({ version: 1, sessionId, objective: contract.objective, status: 'active', decisions: contract.decisions || [], startedAt: new Date(now).toISOString(), deadline: contract.deadline, requirements: contract.requirements, nextActions: contract.nextActions, blocks: 0, unchanged: 0, lastProgress: null, lastTurnId: null, resumedPauseId: null }, sessionId);
    if (Date.parse(state.deadline) <= now) throw Error('Continuation window already expired');
    writeJson(file, state); return state;
  });
}
function update(root, sessionId, change) {
  if (!change || Object.keys(change).some(key=>!['requirements','nextActions'].includes(key))) throw Error('Only outcome evidence and next actions may be updated');
  return locked(root, sessionId, file => {
    const state = validate(readJson(file), sessionId), next = validate({ ...state, ...change }, sessionId);
    if (next.startedAt !== state.startedAt || next.deadline !== state.deadline || next.blocks !== state.blocks || next.unchanged !== state.unchanged || next.sessionId !== state.sessionId || next.version !== state.version || next.objective !== state.objective || next.lastProgress !== state.lastProgress || next.lastTurnId !== state.lastTurnId || JSON.stringify(next.requirements.map(r=>r.id)) !== JSON.stringify(state.requirements.map(r=>r.id))) throw Error('The original contract and consumed limits are immutable');
    if (next.requirements.some(r=>r.status==='verified'&&!proofMatches(root,r.evidence))) throw Error('Verified outcomes need bounded retained evidence');
    writeJson(file, next); return next;
  });
}
function processEvent(mode, input, root = ROOT, now = Date.now()) {
  if (!input || !UUID.test(input.session_id || '')) return { systemMessage: 'Continuation guard received no exact session identity; no completion was certified.' };
  const cwd = typeof input.cwd === 'string' ? fs.realpathSync(input.cwd) : null;
  if (!cwd || !inside(fs.realpathSync(root), cwd)) return {};
  const file = statePath(root,input.session_id), pauseFile = safePath(root,'artifacts/agent-continuation/'+input.session_id+'.paused');
  if (!fs.existsSync(file)) return mode === 'prompt' ? {hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'For an authorized multi-step action task, arm its bounded session continuation contract before substantive work using scripts/agent-harness/continuation.cjs and docs/agent-harness/CONTINUATION_GUARD.md. Do not arm ordinary questions or create new authority. An unarmed session has no completion-stop enforcement.'}} : {}; // No task is inferred or created.
  const text = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const explicitStop = /^(?:[/]?(?:stop|pause|cancel)|stop working|(?:stop|pause|cancel) (?:now|for now|(?:this|the|current) (?:task|work)))[.!]?$/i.test(text);
  const replacement = /^(?:(?:forget|abandon|replace|cancel) (?:this|the|current) (?:task|goal)\b|instead[,]?[ ]|(?:do|work on) .{1,1000} instead[.!]?$)/i.test(text);
  // Cancellation never waits for a Stop lock: the separate atomic marker wins.
  if (mode==='interrupt'||(mode==='prompt'&&(explicitStop||replacement))) {
    writeJson(pauseFile,{id:crypto.randomUUID(),kind:replacement?'direction-changed':/cancel/i.test(text)?'cancelled':'paused'}); return {};
  }
  const resumeMarker = fs.existsSync(pauseFile) ? readJson(pauseFile) : null;
  const initial = validate(readJson(file),input.session_id);
  if (resumeMarker && resumeMarker.id !== initial.resumedPauseId && !(mode==='prompt'&&/^(?:continue|resume)[.!]?$/i.test(text))) return {};
  return locked(root, input.session_id, file => {
    const state = validate(readJson(file), input.session_id);
    const paused = () => fs.existsSync(pauseFile) && readJson(pauseFile).id !== state.resumedPauseId;
    if (mode === 'prompt') {
      if (resumeMarker?.kind==='paused' && /^(?:continue|resume)[.!]?$/i.test(text)) { state.resumedPauseId=resumeMarker.id; writeJson(file,state); }
      if (paused()) return {};
      return state.status === 'active' ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'An armed task remains active. Questions and status requests do not cancel it. Retain settled decisions and continue existing authorized work; the continuation guard grants no permissions.' } } : {};
    }
    if (mode !== 'stop') throw Error('Invalid continuation event');
    if (state.status !== 'active' || paused()) return {};
    const pending = state.requirements.filter(r=>r.status!=='verified'||!proofMatches(root,r.evidence));
    if (!pending.length) return {}; // Hash checks retain bytes; semantic outcome review is still required.
    const ready = state.nextActions.filter(a=>a.status==='ready'&&a.authorization==='existing').length;
    if (!ready) return {systemMessage:'The task remains unfinished, but its contract has no ready existing-authorized work. Respect the retained dependency or permission boundary; no completion or new authority was certified.'};
    const warning = 'The task remains unfinished. The continuation guard has reached its bounded retry/window limit; do not claim completion or renew the same limits. Reassess safe independent work and the existing user budget.';
    if (now >= Date.parse(state.deadline) || state.blocks >= MAX_BLOCKS || state.unchanged >= MAX_UNCHANGED) return { systemMessage: warning };
    if (input.turn_id && state.lastTurnId === input.turn_id) return paused() ? {} : state.lastOutput || {};
    const progress = digest(JSON.stringify(state.requirements.filter(r=>r.status==='verified'&&proofMatches(root,r.evidence)).map(r=>({id:r.id,evidence:r.evidence}))));
    state.unchanged = state.lastProgress === progress ? state.unchanged + 1 : 0;
    state.lastProgress = progress; state.blocks++; state.lastTurnId = input.turn_id || null;
    const reason = 'The armed owner task has unfinished outcomes and ' + ready + ' ready step(s). Continue the next existing authorized step in artifacts/agent-continuation/' + input.session_id + '.json. A passing test, commit, progress summary, known limitation or apology is not completion. Reuse settled decisions; respect all real-data permissions, explicit stops and budgets.';
    state.lastOutput = { decision: 'block', reason }; writeJson(file, state);
    return paused() ? {} : state.lastOutput;
  });
}
async function main() {
  let raw=''; for await (const chunk of process.stdin) { raw+=chunk; if (Buffer.byteLength(raw)>MAX_BYTES) throw Error('Hook input too large'); }
  const result=processEvent(process.argv[2],JSON.parse(raw)); console.log(JSON.stringify(result));
}
module.exports={arm,update,processEvent,proofMatches,MAX_BLOCKS,MAX_UNCHANGED,MAX_WINDOW_MS};
if(require.main===module)main().catch(()=>{console.log(JSON.stringify({systemMessage:'Continuation guard could not inspect its bounded local contract. No completion or permission was certified; check the guard state before claiming enforcement.'}));});
