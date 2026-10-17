'use strict';
const { hash, canonical } = require('./business-calendar');
const { freezeWriteRequest, classifyWriteResponse, denied } = require('./qbo-write-contract');
const MAX_BATCH = 30;
function buildPopulationBatch(scope, entries, requestId) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_BATCH || !/^[a-f0-9]{32}$/.test(requestId || '')) throw denied('A population batch needs 1 to 30 exact independent creates.');
  const keys = new Set(), consumed = new Set();
  const items = entries.map((entry, index) => {
    const compiled = entry.compilation, request = require('./business-readback').validateCompilation(compiled);
    if (hash(request.scope) !== hash(scope) || compiled.logicalKey !== entry.logicalKey || compiled.intentHash !== entry.fingerprint || keys.has(entry.logicalKey)) throw denied('The population batch contains changed or duplicate intents.');
    keys.add(entry.logicalKey);
    for (const parent of entry.step.dependencies) {
      if (consumed.has(parent.logicalKey)) throw denied('A batch cannot share a mutable originating transaction.');
      consumed.add(parent.logicalKey);
    }
    const payload = JSON.parse(request.body);
    if (payload.Id !== undefined || payload.SyncToken !== undefined || request.operation !== 'create') throw denied('Population only creates new accounting records.');
    require('./business-accounting-only').assertAccountingOnlyRequest(compiled.entity, payload);
    return { bId: String(index + 1), operation: 'create', [compiled.entity]: payload };
  });
  if ([...keys].some(key => consumed.has(key))) throw denied('Create dependencies belong in separate batches.');
  const request = freezeWriteRequest(scope, 'POST', 'batch?requestid=' + requestId, { BatchItemRequest: items });
  return { version: 1, requestId, request, entries: entries.map((entry, index) => ({ logicalKey: entry.logicalKey, fingerprint: entry.fingerprint, intentHash: entry.intentHash, entity: entry.entity, bId: String(index + 1), compilation: entry.compilation, ...(entry.inputsJson ? { inputsJson: entry.inputsJson, inputsHash: entry.inputsHash } : {}) })), hash: hash({ requestHash: request.requestHash, entries: entries.map(entry => ({ logicalKey: entry.logicalKey, fingerprint: entry.fingerprint, intentHash: entry.intentHash, compilationHash: entry.compilation.compilationHash, inputsHash: entry.inputsHash || null })) }) };
}
function classifyPopulationResponse(batch, response, intuitTid = '') {
  let payload; try { payload = typeof response?.getJson === 'function' ? response.getJson() : response?.json || JSON.parse(response?.body || 'null'); } catch { payload = null; }
  const base = { entity: 'batch', operation: 'create', httpStatus: Number.isInteger(response?.status) ? response.status : null, intuitTid: /^[a-z0-9._-]{1,128}$/i.test(intuitTid) ? intuitTid : null };
  if (!payload || Buffer.byteLength(JSON.stringify(payload)) > 8000000 || !Array.isArray(payload.BatchItemResponse) || payload.BatchItemResponse.length > MAX_BATCH) return { ...base, outcome: 'unknown', responseHash: null, items: [] };
  const responseHash = hash(payload), groups = new Map(); let malformed = false;
  for (const item of payload.BatchItemResponse) {
    if (!item || typeof item.bId !== 'string' || !batch.entries.some(entry => entry.bId === item.bId)) { malformed = true; continue; }
    const group = groups.get(item.bId) || []; group.push(item); groups.set(item.bId, group);
  }
  const ids = new Set();
  const items = batch.entries.map(entry => {
    const group = groups.get(entry.bId) || [];
    if (group.length !== 1) return { bId: entry.bId, logicalKey: entry.logicalKey, outcome: 'unknown' };
    const item = group[0], { bId, ...body } = item;
    const status = item.Fault?.type === 'ValidationFault' ? 400 : response.status;
    const observed = classifyWriteResponse(entry.compilation.request, { status, json: body }, intuitTid);
    if (observed.outcome === 'saved') {
      const key = entry.entity + ':' + observed.qboId;
      if (ids.has(key)) { malformed = true; return { bId, logicalKey: entry.logicalKey, outcome: 'unknown' }; }
      ids.add(key);
    }
    return { bId, logicalKey: entry.logicalKey, requestHash: entry.compilation.request.requestHash, compilationHash: entry.compilation.compilationHash, fingerprint: entry.fingerprint, intentHash: entry.intentHash, ...observed };
  });
  // A duplicate physical identity makes both implicated entries uncertain.
  if (malformed) return { ...base, outcome: 'unknown', responseHash, items: items.map(item => ({ ...item, outcome: 'unknown' })) };
  return { ...base, outcome: items.every(item => ['saved','rejected'].includes(item.outcome)) ? 'saved' : 'unknown', responseHash, items };
}
function readyPopulationFrontier(records, limit = MAX_BATCH, allowRecord = () => true) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new TypeError('Use a bounded population frontier.');
  const byKey = new Map(records.map(record => [record.logicalKey, record])), selected = [], parents = new Set(), stockItems = new Set();
  if (byKey.size !== records.length) throw denied('The population ledger contains duplicate identities.');
  for (const record of [...records].sort((a,b) => a.txnDate.localeCompare(b.txnDate) || a.logicalKey.localeCompare(b.logicalKey))) {
    if (record.state !== 'pending' || record.step.dependencies.some(link => byKey.get(link.logicalKey)?.state !== 'saved' || parents.has(link.logicalKey))) continue;
    if (!allowRecord(record)) continue;
    const stock = ['Bill','SalesReceipt'].includes(record.entity) ? record.step.references.filter(ref => ref.entity === 'Item').map(ref => ref.id) : [];
    if (stock.some(id => stockItems.has(id))) continue;
    selected.push(record); record.step.dependencies.forEach(link => parents.add(link.logicalKey)); stock.forEach(id => stockItems.add(id));
    if (selected.length === limit) break;
  }
  return selected;
}
module.exports = { buildPopulationBatch, classifyPopulationResponse, readyPopulationFrontier, MAX_BATCH };
