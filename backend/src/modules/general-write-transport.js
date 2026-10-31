'use strict';
// Live batch transport of general governed writes through the company write gate
// (general-write-v1, design rev 3). One general batch is one coordinated gate request:
//   preflight   protected-period evidence for every item (the same per-record contract
//               ordinary writes use; linked historical sources stay read-only);
//   admit       inside the gate's admission transaction: the exact saved batch of an
//               active run, the standing agent grant, and the company writer (free, or
//               held unresolved by this same batch after a lost response);
//   receipt     the batch's run, index, requestid and per-item identity, before sending;
//   classify    per-item outcomes from the batch response (unknown when ambiguous);
//   settle      inside the gate's result transaction: item outcomes saved on the run.
// QuickBooks dedupes a batch by requestid, so a replay after a lost response reuses the
// same requestid and bIds under a new transport attempt (a new receipt and dispatch key).
const { hash, canonical } = require('./business-calendar');
const { denied, freezeWriteRequest, classifyWriteResponse, responsePayload } = require('./qbo-write-contract');
const { readWritePeriodEvidence, assertWritePeriod } = require('./qbo-write-period');
const MAX_BATCH = 30, ID = /^[a-f0-9]{24}$/i, REQUEST = /^[a-f0-9]{32}$/;
// The single-record request an item is equivalent to (period contract and classification).
function itemRequest(scope, item) {
  const entity = item.entity.toLowerCase();
  if (item.operation === 'create') return freezeWriteRequest(scope, 'POST', entity, item.payload);
  if (item.operation === 'update') return freezeWriteRequest(scope, 'POST', entity, item.payload);
  if (item.operation === 'delete') return freezeWriteRequest(scope, 'POST', entity + '?operation=delete', item.payload);
  throw denied('Batch ' + item.operation + ' is not enabled for general writes until it is confirmed against the QuickBooks batch reference.');
}
// The exact batch wire body for a saved general batch.
function buildGeneralBatch(scope, batch) {
  if (!REQUEST.test(batch?.requestId || '') || !Array.isArray(batch.items) || !batch.items.length || batch.items.length > MAX_BATCH) throw denied('A general batch needs a saved requestid and 1 to 30 items.');
  const items = batch.items.map(item => { itemRequest(scope, item); return { bId: item.bId, operation: item.operation, [item.entity]: item.payload }; });
  if (new Set(items.map(item => item.bId)).size !== items.length) throw denied('General batch item identities are duplicated.');
  return freezeWriteRequest(scope, 'POST', 'batch?requestid=' + batch.requestId, { BatchItemRequest: items });
}
function classifyGeneralResponse(scope, batch, response, intuitTid = '') {
  const payload = responsePayload(response), base = { entity: 'batch', operation: 'create', httpStatus: Number.isInteger(response?.status) ? response.status : null, intuitTid: /^[a-z0-9._-]{1,128}$/i.test(intuitTid) ? intuitTid : null };
  if (!payload || !Array.isArray(payload.BatchItemResponse) || payload.BatchItemResponse.length > MAX_BATCH || Buffer.byteLength(JSON.stringify(payload)) > 8000000) return { ...base, outcome: 'unknown', responseHash: null, items: [] };
  const responseHash = hash(payload), groups = new Map();
  for (const row of payload.BatchItemResponse) { if (!row || typeof row.bId !== 'string') continue; groups.set(row.bId, [...(groups.get(row.bId) || []), row]); }
  const items = batch.items.map(item => {
    const group = groups.get(item.bId) || [];
    if (group.length !== 1) return { bId: item.bId, ref: item.ref, outcome: 'unknown' };
    const { bId, ...body } = group[0], status = body.Fault?.type === 'ValidationFault' ? 400 : response.status;
    return { bId, ref: item.ref, ...classifyWriteResponse(itemRequest(scope, item), { status, json: body }, intuitTid) };
  });
  return { ...base, outcome: items.every(item => ['saved', 'rejected'].includes(item.outcome)) ? 'saved' : 'unknown', responseHash, items };
}
// models: { GeneralWriteRuns, Agents }. runId / batchIndex name the saved batch.
function createGeneralGateTransport({ models, scope, runId, batchIndex, now = () => Date.now() }) {
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun');
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function saved(session) {
    const run = await read(Runs, { _id: runId, environment: scope.environment, realmId: scope.realmId }, session), batch = run?.batches?.find(row => row.index === batchIndex);
    if (!run || String(run.connectionId) !== String(scope.connectionId) || !batch) throw denied('The saved general batch is unavailable.');
    return { run, batch };
  }
  // The batch read at preflight; the gate asserts its period proof synchronously.
  let preflighted = null;
  return {
    async receiptEvidence({ request, session }) {
      const { run, batch } = await saved(session);
      if (buildGeneralBatch(scope, batch).requestHash !== request.requestHash) throw denied('The general batch request differs from its saved identity.');
      return { version: 1, contract: 'general-write-v1', runId, batchIndex, requestId: batch.requestId, sends: batch.sends || 1, decisionKey: run.decisionKey, items: batch.items.map(item => ({ bId: item.bId, ref: item.ref, entity: item.entity, operation: item.operation, ...(item.id ? { id: item.id, targetVersion: item.before?.SyncToken ?? null, beforeHash: hash(item.before || null) } : {}), requestHash: itemRequest(scope, item).requestHash })) };
    },
    async preflight({ request, client, coordination }) {
      const { batch } = await saved();
      if (buildGeneralBatch(scope, batch).requestHash !== request.requestHash) throw denied('The general batch request differs from its saved identity.');
      // Linked records shared by several items are read once.
      const memo = new Map(), memoClient = { read: (entity, id) => { const key = entity + ':' + id; if (!memo.has(key)) memo.set(key, client.read(entity, id)); return memo.get(key); }, query: text => { if (!memo.has(text)) memo.set(text, client.query(text)); return memo.get(text); } };
      preflighted = batch;
      const proofs = [];
      for (const item of batch.items) proofs.push(await readWritePeriodEvidence(itemRequest(scope, item), memoClient, now, coordination));
      return { version: 1, kind: 'general-period-evidence', coordination, scope, requestHash: request.requestHash, runId, batchIndex, proofs };
    },
    assertPeriod({ request, evidence, controls, ownerId, clock }) {
      const batch = preflighted;
      if (!batch || evidence?.kind !== 'general-period-evidence' || evidence.runId !== runId || evidence.batchIndex !== batchIndex || evidence.requestHash !== request.requestHash || !Array.isArray(evidence.proofs) || evidence.proofs.length !== batch.items.length) throw denied('General protected-period evidence is incomplete.');
      const proofs = evidence.proofs.map((proof, n) => assertWritePeriod(itemRequest(scope, batch.items[n]), proof, controls, clock, ownerId));
      return { version: 1, kind: 'general-period-proof', runId, batchIndex, proofs, protectedThrough: proofs.map(row => row.protectedThrough).filter(Boolean).sort().at(-1) || null, evidenceHash: hash({ requestHash: request.requestHash, proofs }) };
    },
    async savedBatch(session) { return (await saved(session)).batch; },
    async admit({ request, receiptId, dispatchKey, writer, ownerId, actorId, session }) {
      const { run, batch } = await saved(session);
      if (!['sending', 'unknown'].includes(run.status) || run.contract !== 'general-write-v1' || String(run.ownerId) !== String(ownerId) || String(run.actorId) !== String(actorId) || buildGeneralBatch(scope, batch).requestHash !== request.requestHash || batch.state === 'answered') throw denied('The exact saved general batch is not ready to send.');
      if (run.day !== require('./business-activity-preview').businessDate(new Date(now()))) throw denied('The business day changed since this general write was prepared. Nothing was sent.');
      // The standing grant still covers this agent, owner and published business.
      if (run.agentAuthority) await require('./business-agent-authority').fenceAgentAuthority({ authority: run.agentAuthority, scope, ownerId: String(ownerId), actorId: String(actorId), Agents: models.Agents, session });
      // The company writer: free, or held unresolved by this same batch (a lost response).
      const replay = writer.unresolved?.kind === 'general-write' && writer.unresolved.runId === runId && writer.unresolved.batchIndex === batchIndex && writer.unresolved.requestId === batch.requestId;
      if (writer.operationId !== null || writer.planHash !== null || (writer.unresolved !== null && !replay)) throw denied('Another operation or unresolved request owns this company. Nothing was sent.');
      return { version: 1, kind: 'general-write', key: dispatchKey, runId, batchIndex, requestId: batch.requestId, requestHash: request.requestHash, actorId, transportConsumed: { receiptId, consumedAt: new Date(now()).toISOString() } };
    },
    async classify({ request, response, intuitTid }) {
      const { batch } = await saved();
      if (buildGeneralBatch(scope, batch).requestHash !== request.requestHash) throw denied('The general batch response needs recovery.', true);
      return classifyGeneralResponse(scope, batch, response, intuitTid);
    },
    async settle({ stored, observed, observedAt, session }) {
      const { run, batch } = await saved(session);
      if (stored.general?.runId !== runId || stored.general.batchIndex !== batchIndex || stored.general.requestId !== batch.requestId) throw denied('The general batch response differs from its admitted batch.', true);
      const updated = await Runs.findOneAndUpdate({ _id: runId, revision: run.revision }, { $set: { batches: run.batches.map(row => row.index === batchIndex ? { ...row, transport: { receiptId: stored._id, outcome: observed.outcome, items: (observed.items || []).map(item => ({ bId: item.bId, outcome: item.outcome, ...(item.qboId ? { qboId: item.qboId } : {}), ...(item.faultCodes ? { faultCodes: item.faultCodes } : {}) })), observedAt: observedAt.toISOString() } } : row) }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!updated) throw denied('The general write changed while its response was saved.', true);
    },
  };
}
// Send one saved batch through a coordinated client and gate. Returns the BatchItemResponse
// list; a transport failure or an unproven outcome throws { lost: true } (the receipt and the
// writer barrier remain, and the next execution replays the same requestid).
async function sendGeneralBatch({ client, gate, scope, runId, batch }) {
  const { withWriteWorkflow } = require('./qbo-write-workflow');
  const request = buildGeneralBatch(scope, batch), body = JSON.parse(request.body);
  const workflow = { version: 1, kind: 'general-write', runId, batchIndex: batch.index, sends: batch.sends || 1 };
  const previous = client.writeGate;
  client.writeGate = gate;
  let response;
  try { response = await withWriteWorkflow(workflow, async () => {}, () => client.apiCall('POST', 'batch?requestid=' + batch.requestId, body)); }
  catch (error) { if (error?.qboStage === 'write_admission' && !error.outcomeUnknown) throw error; throw Object.assign(new Error('The QuickBooks batch outcome is not proven; it will be replayed with the same requestid.'), { lost: true, cause: error }); }
  finally { client.writeGate = previous; }
  const items = response?.BatchItemResponse || response?.json?.BatchItemResponse;
  if (!Array.isArray(items)) throw Object.assign(new Error('The QuickBooks batch response was incomplete.'), { lost: true });
  return items;
}
// The live transport for general-write-service: the company's scoped QuickBooks client and a
// coordinated gate with this batch's runtime. Installed only when dispatch is enabled.
function createGeneralLiveTransport({ access, models = {}, now = () => Date.now() }) {
  return {
    async sendBatch(scope, { runId, batch }) {
      const client = await access.resolveClient(scope), { QBOClient } = require('./qbo-client');
      if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall) throw denied('General writes require the original scoped QuickBooks transport.');
      const gate = require('./qbo-write-gate').createCoordinatedGate({ generalTransport: createGeneralGateTransport({ models, scope, runId, batchIndex: batch.index, now }), now });
      return sendGeneralBatch({ client, gate, scope, runId, batch });
    },
  };
}
module.exports = { createGeneralGateTransport, createGeneralLiveTransport, sendGeneralBatch, buildGeneralBatch, classifyGeneralResponse, itemRequest };
