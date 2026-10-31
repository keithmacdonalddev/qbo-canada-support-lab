'use strict';
// The accountant's review session, captured as it happens for the Live panel: what was sent to
// the model, its reasoning and messages, tool calls with their arguments and the results returned
// to it, usage and the outcome. Entries are redacted before they are saved or published, bounded
// per item and per attempt, written in the background in batches, and never slow or break a review.
const { EventEmitter } = require('node:events');

const MAX_ITEM_BYTES = 8 * 1024, MAX_CONTEXT_BYTES = 64 * 1024, MAX_ATTEMPT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000, KEEP_ATTEMPTS = 50, TTL_MS = 7 * 86400000;
const KINDS = new Set(['context', 'reasoning', 'message', 'tool-call', 'tool-result', 'usage', 'outcome']);
const REDACTED = '[redacted]';

// ---------- Redaction ----------
// Key names that hold credentials. QuickBooks SyncToken is a record version, not a secret.
const SECRET_KEY = /(?:api[-_]?key|apikey|secret|password|passwd|authorization|cookie|jwt|bearer|private[-_]?key|credential|client[-_]?id|token)$/i;
const SAFE_KEY = /^(?:sync[-_]?token|.*tokens|max[-_]?tokens|token[-_]?count|tokenEnv)$/i;
const secretKey = key => typeof key === 'string' && SECRET_KEY.test(key.replace(/[^A-Za-z0-9_-]/g, '')) && !SAFE_KEY.test(key);
// Token-shaped strings, wherever they appear in text.
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  // JWT/JWE shapes, including the empty sections of QuickBooks' encrypted access tokens (eyJ…..…).
  [/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){2,4}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ' + REDACTED],
  [/\b(authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi, '$1$2' + REDACTED],
  [/\b(AB11|RT1-)[A-Za-z0-9-]{30,}/g, REDACTED],
  [/\bmongodb(?:\+srv)?:\/\/[^\s"']+/gi, REDACTED],
  [/\b(ghp|gho|github_pat|xox[abp])_[A-Za-z0-9_]{16,}/g, REDACTED],
];
// Literal values of credential-like environment settings (never the names' values themselves logged).
let envSecrets = null;
function environmentSecrets() {
  if (envSecrets) return envSecrets;
  const values = new Set();
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || value.length < 8) continue;
    if (/(KEY|SECRET|TOKEN|PASSWORD|PASS|URI|DSN|CREDENTIAL|PRIVATE|JWT)/i.test(name) && !/^(PATH|PATHEXT|PSModulePath)$/i.test(name)) values.add(value);
  }
  envSecrets = [...values].sort((a, b) => b.length - a.length);
  return envSecrets;
}
function scrubText(text, extra = []) {
  let value = String(text);
  for (const secret of [...extra, ...environmentSecrets()]) if (typeof secret === 'string' && secret.length >= 8 && value.includes(secret)) value = value.split(secret).join(REDACTED);
  for (const [pattern, replacement] of PATTERNS) value = value.replace(pattern, replacement);
  return value;
}
// Deep copy with credential keys replaced and every string scrubbed. Bounded depth and breadth.
function redact(value, extra = [], depth = 0) {
  if (typeof value === 'string') return scrubText(value, extra);
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : typeof value === 'bigint' ? String(value) : value;
  if (depth > 12) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redact(item, extra, depth + 1));
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 500)) out[key] = secretKey(key) && item !== null && item !== undefined && typeof item !== 'object' ? REDACTED : secretKey(key) && typeof item === 'object' && item !== null ? REDACTED : redact(item, extra, depth + 1);
  return out;
}
const cut = (text, max) => { const buffer = Buffer.from(text, 'utf8'); if (buffer.length <= max) return [text, false]; return [buffer.subarray(0, max).toString('utf8').replace(/�+$/, '') + '\n… (truncated)', true]; };
// One stored entry: redacted, sized, with a JSON body kept as pretty text.
function makeEntry(kind, { text = '', data, name = null, callId = null, status = null, provider = null } = {}, extra = []) {
  if (!KINDS.has(kind)) return null;
  const limit = kind === 'context' ? MAX_CONTEXT_BYTES : MAX_ITEM_BYTES;
  const [safeText, textCut] = cut(scrubText(typeof text === 'string' ? text : '', extra), limit);
  let json = '';
  if (data !== undefined) { try { json = JSON.stringify(redact(data, extra), null, 2) ?? ''; } catch { json = '"(unserializable)"'; } }
  const [safeJson, jsonCut] = cut(json, limit);
  const short = (value, max) => typeof value === 'string' ? scrubText(value, extra).replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : null;
  return { kind, provider: short(provider, 20), name: short(name, 80), callId: short(callId, 80), status: short(status, 20), text: safeText, json: safeJson, truncated: textCut || jsonCut };
}

// ---------- Provider event shapes ----------
// Codex `exec --json` events. Tool calls and results are captured where the app executes them
// (the same path as Anthropic), so Codex MCP items are not duplicated here.
function codexEntries(event) {
  if (!event || typeof event !== 'object') return [];
  const item = event.item;
  if (event.type === 'item.completed' && item?.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) return [['reasoning', { text: item.text }]];
  if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return [['message', { text: item.text }]];
  if (event.type === 'item.completed' && item?.type === 'todo_list' && Array.isArray(item.items)) return [['reasoning', { text: 'Plan:\n' + item.items.map(row => (row?.completed ? '[x] ' : '[ ] ') + String(row?.text || '')).join('\n') }]];
  if (event.type === 'turn.completed' && event.usage) return [['usage', { data: { inputTokens: event.usage.input_tokens ?? null, cachedInputTokens: event.usage.cached_input_tokens ?? null, outputTokens: event.usage.output_tokens ?? null } }]];
  if (event.type === 'turn.failed' || event.type === 'error') return [['outcome', { status: 'failed', text: 'The model service reported a failed turn' + (typeof (event.error?.message || event.message) === 'string' ? ': ' + String(event.error?.message || event.message).slice(0, 500) : '.') }]];
  return [];
}
// One Anthropic Messages response: thinking, text and tool_use blocks in order, then usage.
// Tool use blocks are recorded as calls by the engine when it runs them, so only the model's
// thinking and text are taken from the blocks here.
function anthropicEntries(response) {
  const out = [];
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) out.push(['reasoning', { text: block.thinking }]);
    else if (block?.type === 'redacted_thinking') out.push(['reasoning', { text: '(reasoning withheld by the provider)' }]);
    else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) out.push(['message', { text: block.text }]);
  }
  const usage = response?.usage;
  if (usage) out.push(['usage', { data: { inputTokens: usage.input_tokens ?? null, cacheReadTokens: usage.cache_read_input_tokens ?? null, cacheWriteTokens: usage.cache_creation_input_tokens ?? null, outputTokens: usage.output_tokens ?? null, stopReason: typeof response.stop_reason === 'string' ? response.stop_reason : null } }]);
  return out;
}

// ---------- Live hub ----------
// In-process fan-out to open streams, keyed by agent. Listeners never affect the writer.
const hub = new EventEmitter();
hub.setMaxListeners(100);
function publish(agentId, entry) { try { hub.emit('entry:' + agentId, entry); } catch { /* a listener failure never reaches the review */ } }
function subscribe(agentId, listener) { const name = 'entry:' + agentId; hub.on(name, listener); return () => hub.off(name, listener); }

// ---------- Recorder ----------
// write(entries): saves a batch (insertMany). Writes coalesce while one is in flight; failures are
// counted only. flush() waits a bounded time. Past the attempt budget, one notice is kept and the
// rest is dropped (the review continues unaffected).
function createTranscriptRecorder({ agentId, attemptId, passId = null, role = 'accountant', scope = {}, write, publish: emit = publish, now = () => Date.now(), secrets = [], flushMs = 2000 } = {}) {
  let seq = 0, bytes = 0, full = false, queue = [], inflight = null, failures = 0;
  const extra = secrets.filter(value => typeof value === 'string' && value.length >= 8);
  async function pump() {
    while (queue.length) {
      const batch = queue.splice(0, 50);
      try { if (typeof write === 'function') await write(batch); } catch { failures++; }
    }
  }
  const save = () => { if (!inflight) inflight = Promise.resolve().then(pump).finally(() => { inflight = null; if (queue.length) save(); }); };
  function add(kind, fields = {}) {
    try {
      if (full || !agentId || !attemptId) return null;
      const entry = makeEntry(kind, fields, extra);
      if (!entry) return null;
      const size = Buffer.byteLength(entry.text) + Buffer.byteLength(entry.json) + 200;
      if (bytes + size > MAX_ATTEMPT_BYTES || seq >= MAX_ENTRIES) {
        full = true;
        Object.assign(entry, makeEntry('outcome', { status: 'truncated', text: 'This review’s transcript reached its size limit; later items were not kept. The review itself continues normally.' }));
      }
      bytes += size; seq += 1;
      const at = new Date(now());
      const row = { agentId: String(agentId), attemptId: String(attemptId), passId: passId ? String(passId) : null, role: String(role), environment: String(scope.environment || ''), realmId: String(scope.realmId || ''), seq, at, expiresAt: new Date(at.getTime() + TTL_MS), ...entry };
      queue.push(row); save();
      // A failing live listener never drops the saved entry.
      try { emit(String(agentId), publicEntry(row)); } catch { failures++; }
      return row;
    } catch { failures++; return null; }
  }
  // Wall-clock bound so a stuck write never holds the pass.
  async function flush() {
    const deadline = Date.now() + flushMs;
    while (inflight || queue.length) {
      if (!inflight) save();
      const left = deadline - Date.now();
      if (left <= 0) return;
      let timer;
      await Promise.race([inflight, new Promise(resolve => { timer = setTimeout(resolve, left); timer.unref?.(); })]);
      clearTimeout(timer);
    }
  }
  // Per-attempt credentials (the user's AI key, the tool-bridge token) are scrubbed literally as well.
  function secret(value) { if (typeof value === 'string' && value.length >= 8 && !extra.includes(value)) extra.push(value); }
  return { add, flush, secret, attemptId: String(attemptId || ''), failures: () => failures, size: () => ({ seq, bytes, full }) };
}
// What the page receives for one entry.
function publicEntry(row) {
  return { attemptId: row.attemptId, passId: row.passId || null, role: row.role, seq: row.seq, at: new Date(row.at).toISOString(), kind: row.kind, provider: row.provider || null, name: row.name || null, callId: row.callId || null, status: row.status || null, text: row.text || '', json: row.json || '', truncated: Boolean(row.truncated) };
}

// ---------- Saved transcripts ----------
// Bounded reads and writes over the BusinessAgentTranscript model (models.Transcripts).
function createTranscriptStore({ Transcripts }) {
  let indexed = null;
  // The model does not auto-create indexes; the TTL and uniqueness indexes are ensured once per process.
  const ensure = () => (indexed ||= Transcripts.createIndexes().catch(() => { indexed = null; }));
  async function save(rows) { await ensure(); await Transcripts.insertMany(rows, { ordered: false }); }
  // Keep the newest attempts only; older entries go (the TTL index removes anything past seven days).
  async function prune(agentId, keep = KEEP_ATTEMPTS) {
    const cutoff = await Transcripts.find({ agentId, kind: 'context' }).sort({ at: -1 }).skip(keep).limit(1).select('at').maxTimeMS(2000).lean();
    if (cutoff[0]) await Transcripts.deleteMany({ agentId, at: { $lte: cutoff[0].at } }).maxTimeMS(5000);
  }
  async function attempts(agentId, limit = 20) {
    const starts = await Transcripts.find({ agentId, kind: 'context' }).sort({ at: -1 }).limit(limit).select('attemptId passId role provider at').maxTimeMS(2000).lean();
    if (!starts.length) return [];
    const ends = await Transcripts.find({ agentId, kind: 'outcome', attemptId: { $in: starts.map(row => row.attemptId) } }).select('attemptId status at text').limit(limit * 3).maxTimeMS(2000).lean();
    const last = new Map(); for (const row of ends) if (!last.has(row.attemptId) || last.get(row.attemptId).at < row.at) last.set(row.attemptId, row);
    return starts.map(row => ({ attemptId: row.attemptId, passId: row.passId || null, role: row.role, provider: row.provider || null, startedAt: new Date(row.at).toISOString(), outcome: last.get(row.attemptId)?.status || null, endedAt: last.get(row.attemptId) ? new Date(last.get(row.attemptId).at).toISOString() : null }));
  }
  async function entries(agentId, attemptId, after = 0, limit = 500) {
    const rows = await Transcripts.find({ agentId, attemptId, seq: { $gt: after } }).sort({ seq: 1 }).limit(limit).maxTimeMS(3000).lean();
    return rows.map(publicEntry);
  }
  async function latest(agentId) { const row = await Transcripts.findOne({ agentId, kind: 'context' }).sort({ at: -1 }).select('attemptId').maxTimeMS(2000).lean(); return row?.attemptId || null; }
  return { save, prune, attempts, entries, latest };
}
// SSE cursor "attemptId:seq" from a Last-Event-ID header; null when absent or malformed.
function parseCursor(value) {
  const match = /^([A-Za-z0-9-]{8,64}):(\d{1,6})$/.exec(typeof value === 'string' ? value.trim() : '');
  return match ? { attemptId: match[1], seq: Number(match[2]) } : null;
}

module.exports = { createTranscriptRecorder, createTranscriptStore, makeEntry, redact, scrubText, codexEntries, anthropicEntries, publish, subscribe, publicEntry, parseCursor, MAX_ITEM_BYTES, MAX_CONTEXT_BYTES, MAX_ATTEMPT_BYTES, KEEP_ATTEMPTS, TTL_MS, REDACTED };
