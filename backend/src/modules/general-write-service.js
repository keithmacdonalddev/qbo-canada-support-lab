'use strict';
// The general governed QuickBooks write (manageQboRecord), contract general-write-v1
// (docs/plans/general-governed-write-tool-2026-10-31.md, rev 3). It composes the pure
// parts: guards over the synced copy, the resource-aware scheduler, the exact transport
// identity and item recovery, and the complete-entity merge.
//
// Dispatch is held unless the server flag GENERAL_WRITE_DISPATCH_ENABLED is on and a
// transport is installed: preparation saves a guarded plan and sends nothing. The live
// transport (through qbo-write-gate.js) and day-close verification of general records are
// separate, reviewed steps; until both exist the flag must stay off, because a record
// written outside the period proof would fail the next close.
const { hash, canonical } = require('./business-calendar');
const { checkGeneralWrite } = require('./general-write-guards');
const { itemOutcomes } = require('./general-write-recovery');
const { isComplete, invalidatedParents } = require('./general-write-merge');
const { REF_TARGETS } = require('./qbo-entity-schema');
const KEY = /^[a-zA-Z0-9_-]{8,100}$/, QBO_ID = /^\d{1,30}$/, MAX_ATTEMPTS = 3;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'GENERAL_WRITE_REFUSED' }); }
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const scopeOf = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: String(scope.connectionId) });
// Keys a proposal (and the records it touches) need from the copy, as [entity, id] pairs.
function wanted(value, out = []) {
  if (Array.isArray(value)) value.forEach(entry => wanted(entry, out));
  else if (plain(value)) for (const [key, entry] of Object.entries(value)) {
    if (/Ref$/.test(key) && plain(entry) && QBO_ID.test(String(entry.value ?? ''))) for (const kind of REF_TARGETS[key] || []) if (kind !== 'self') out.push([kind, String(entry.value)]);
    if (key === 'LinkedTxn' && Array.isArray(entry)) for (const link of entry) if (QBO_ID.test(String(link?.TxnId ?? ''))) out.push([link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType, String(link.TxnId)]);
    wanted(entry, out);
  }
  return out;
}
// A synchronous view of the copy for the pure guards: prefetch every record the proposal
// names, the records those link to, and the accounts and items their lines use.
async function loadCopy(copy, scope, operations, owned, extras = []) {
  const map = new Map(), seen = new Set();
  // Records this write already saved (from their complete responses) count as current.
  for (const { entity, record } of extras) if (record?.Id) { map.set(entity + ':' + String(record.Id), record); seen.add(entity + ':' + String(record.Id)); }
  const fetch = async pairs => { for (const [entity, id] of pairs) { const key = entity + ':' + id; if (seen.has(key)) continue; seen.add(key); const record = await copy.read(scope, entity, id); if (record) map.set(key, record); } };
  await fetch(operations.filter(op => op?.id).map(op => [op.entity, String(op.id)]));
  for (let round = 0; round < 3; round++) await fetch([...operations.map(op => op?.payload), ...map.values()].flatMap(value => wanted(value)));
  for (const code of [...map.values()].filter(record => record.SalesTaxRateList || record.PurchaseTaxRateList)) await fetch([...(code.SalesTaxRateList?.TaxRateDetail || []), ...(code.PurchaseTaxRateList?.TaxRateDetail || [])].map(row => ['TaxRate', String(row.TaxRateRef?.value)]));
  return { get: (entity, id) => map.get(entity + ':' + id) || null, owned: (entity, id) => owned.has(entity + ':' + id), map };
}
// Replace { $ref: name } placeholders with the ids saved by earlier batches. A ref not yet
// saved stays a placeholder: the guards place it after its create, and a batch is only
// built once every placeholder it uses is resolved (checked again before sending).
function resolve(value, saved) {
  if (Array.isArray(value)) return value.map(entry => resolve(entry, saved));
  if (!plain(value)) return value;
  if (value.$ref !== undefined && Object.keys(value).length === 1) return saved[value.$ref] ? { value: saved[value.$ref] } : value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = ['TxnId', 'value'].includes(key) && plain(entry) && entry.$ref !== undefined ? (saved[entry.$ref] || entry) : resolve(entry, saved);
  return out;
}
const unresolved = value => JSON.stringify(value).includes('"$ref"');
// The response saved what was asked: every sent field present and equal (lines by type
// and amount). QuickBooks adds computed fields; those are not compared here.
function matchesRequest(sent, saved) {
  for (const [key, value] of Object.entries(sent)) {
    if (['sparse', 'SyncToken'].includes(key)) continue;
    if (key === 'Line') { const got = (saved.Line || []).filter(line => line.DetailType !== 'SubTotalLineDetail'); if (got.length !== value.length || value.some((line, n) => Math.round(Number(line.Amount || 0) * 100) !== Math.round(Number(got[n]?.Amount || 0) * 100) || (line.DetailType && line.DetailType !== got[n]?.DetailType))) return false; continue; }
    if (plain(value) && 'value' in value) { if (String(saved[key]?.value) !== String(value.value)) return false; continue; }
    if (plain(value) || Array.isArray(value)) continue; // nested blocks are checked at close
    if (typeof value === 'number' ? Math.round(value * 100) !== Math.round(Number(saved[key]) * 100) : String(saved[key]) !== String(value)) return false;
  }
  return true;
}
function createGeneralWriteService({ models, copy, contextFor, transport = null, retain = null, markDirty = null, dispatchEnabled = () => require('../config').features?.generalWriteDispatch === true, now = () => Date.now() }) {
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun');
  async function ownedSet(scope, operations) {
    const keys = operations.filter(op => op?.id).map(op => op.entity + ':' + op.id), owned = new Set();
    for (const key of keys) {
      const [entity, qboId] = key.split(':');
      if (await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, entity, qboId, state: 'verified' }).select('_id').maxTimeMS(3000).lean()) owned.add(key);
      else if (await Runs.findOne({ environment: scope.environment, realmId: scope.realmId, owned: { $elemMatch: { key, op: 'create' } } }).select('_id').maxTimeMS(3000).lean()) owned.add(key);
    }
    return owned;
  }
  async function guard(scope, operations, extras = []) {
    const owned = await ownedSet(scope, operations);
    for (const { entity, record } of extras) if (record?.Id) owned.add(entity + ':' + String(record.Id));
    const local = await loadCopy(copy, scope, operations, owned, extras), context = await contextFor(scope, local);
    return { result: checkGeneralWrite({ proposal: { operations }, local, context }), local, context };
  }
  // Preparation: validate, guard and save the plan. Nothing is sent.
  async function prepare(bound, input) {
    const scope = scopeOf(bound.scope);
    if (!plain(input) || Object.keys(input).some(key => !['decisionKey', 'purpose', 'operations'].includes(key)) || !KEY.test(input.decisionKey || '') || typeof input.purpose !== 'string' || input.purpose.trim().length < 10 || input.purpose.length > 2000 || !Array.isArray(input.operations)) fail('Send { decisionKey (8-100 letters, digits, - or _), purpose (10-2,000 characters), operations: [...] }.', 400);
    const contentHash = hash({ purpose: input.purpose.trim(), operations: input.operations }), _id = hash({ scope, ownerId: String(bound.ownerId), kind: 'general-write', decisionKey: input.decisionKey }).slice(0, 24);
    const existing = await Runs.findOne({ _id, environment: scope.environment, realmId: scope.realmId }).lean();
    if (existing) { if (existing.contentHash !== contentHash) fail('decisionKey ' + input.decisionKey + ' already names different work (' + existing.status + '). Use a new decisionKey for a new decision.'); return { runId: _id, status: existing.status, reused: true, plan: summary(existing.plan) }; }
    const { result, context } = await guard(scope, input.operations);
    if (!result.ok) return { runId: null, status: 'refused', problems: result.problems };
    await Runs.create([{ _id, contract: 'general-write-v1', ...scope, ownerId: bound.ownerId, actorId: bound.actorId, agentAuthority: bound.agentAuthority || null, decisionKey: input.decisionKey, contentHash, purpose: input.purpose.trim(), day: context.day, plan: result.plan, status: 'prepared' }]);
    return { runId: _id, status: 'prepared', reused: false, plan: summary(result.plan) };
  }
  function summary(plan) { return { operations: plan.operations.length, batches: plan.layers.length, reverifyDates: plan.reverifyDates, externalEdits: plan.externalEdits, exposureCents: plan.exposureCents }; }
  async function save(run, changes) {
    const saved = await Runs.findOneAndUpdate({ _id: run._id, revision: run.revision }, { $set: changes, $inc: { revision: 1 } }, { new: true }).lean();
    if (!saved) fail('This write changed concurrently; read it again.');
    return saved;
  }
  // Execution: one batch at a time, each guarded again on the current copy right before it
  // is sent, its exact identity saved first. Returns progress, faults or the unknown items.
  async function execute(bound, runId) {
    const scope = scopeOf(bound.scope);
    let run = await Runs.findOne({ _id: runId, environment: scope.environment, realmId: scope.realmId }).lean();
    if (!run || String(run.connectionId) !== scope.connectionId) fail('This general write is unavailable.', 404);
    if (run.status === 'complete') return report(run);
    if (!dispatchEnabled() || !transport) { if (run.status !== 'held') run = await save(run, { status: 'held', lastError: 'Dispatch of general writes is not enabled on this server yet; the plan is saved and nothing was sent.' }); return report(run); }
    if (run.status === 'needs-correction') return report(run);
    for (let guardRounds = 0; guardRounds < 40; guardRounds++) {
      const saved = Object.fromEntries(Object.entries(run.items).filter(([, item]) => item.outcome === 'saved').map(([ref, item]) => [ref, item.qboId]));
      const done = new Set(Object.entries(run.items).filter(([, item]) => ['saved', 'deleted'].includes(item.outcome)).map(([ref]) => ref));
      // A batch saved but unanswered (lost response) is replayed with the same identity.
      let batch = run.batches.find(row => row.state !== 'answered');
      if (!batch) {
        const remaining = run.plan.operations.filter(op => !done.has(op.ref));
        if (!remaining.length) { run = await save(run, { status: 'complete', lastError: null }); return report(run); }
        const operations = remaining.map(op => ({ ref: op.ref, op: op.op, entity: op.entity, ...(op.id ? { id: op.id } : {}), payload: resolve(op.payload, saved), ...(op.reason ? { reason: op.reason } : {}) }));
        // Earlier saved records count for references; their ids are now real ids.
        const extras = Object.values(run.items).filter(item => item.outcome === 'saved' && item.record).map(item => ({ entity: item.entity, record: item.record }));
        const { result, local, context } = await guard(scope, operations, extras);
        if (context.day !== run.day) { run = await save(run, { status: 'needs-correction', lastError: 'The business day changed since this write was prepared (' + run.day + ' → ' + context.day + '). Prepare it again with a new decisionKey.' }); return report(run); }
        if (!result.ok) { run = await save(run, { status: 'needs-correction', lastError: 'The company changed since preparation: ' + result.problems.map(row => (row.ref ? row.ref + ': ' : '') + row.message).join(' ') }); return report(run, result.problems); }
        const first = new Set(result.plan.layers[0]), attempt = run.batches.length + 1;
        const items = result.plan.operations.filter(op => first.has(op.ref)).map((op, n) => {
          const current = op.id ? local.get(op.entity, op.id) : null, body = op.op === 'create' ? op.payload : op.op === 'update' ? { ...op.payload, Id: op.id, SyncToken: current.SyncToken, sparse: true } : { Id: op.id, SyncToken: current.SyncToken };
          if (unresolved(body)) fail('Operation ' + op.ref + ' still names an unsaved earlier record; nothing was sent.');
          return { bId: String(n + 1), ref: op.ref, op: op.op, entity: op.entity, ...(op.id ? { id: op.id, before: current } : {}), operation: op.op, payload: body };
        });
        batch = { index: run.batches.length, attempt, requestId: hash({ runId: run._id, attempt, refs: items.map(item => item.ref) }).slice(0, 32), items, state: 'sending', savedAt: new Date(now()).toISOString() };
        // Durable dirty-period markers come before any history-changing send.
        const markers = result.plan.reverifyDates.filter(date => !run.dirty.some(row => row.date === date)).map(date => ({ date, reason: 'General write ' + run.decisionKey, runId: run._id, at: new Date(now()).toISOString() }));
        if (markers.length && markDirty) await markDirty(scope, markers);
        run = await save(run, { batches: [...run.batches, batch], dirty: [...run.dirty, ...markers], status: 'sending' });
      }
      // Send (or replay) exactly the saved identity.
      let response;
      try { response = await transport.sendBatch(scope, { requestId: batch.requestId, items: batch.items.map(item => ({ bId: item.bId, operation: item.operation, entity: item.entity, payload: item.payload })) }); }
      catch (error) {
        if (error?.lost !== true) throw error;
        run = await save(run, { batches: run.batches.map(row => row.index === batch.index ? { ...row, state: 'lost' } : row), status: 'unknown', lastError: 'The QuickBooks response was lost; the same request will be replayed with its original identity.' });
        return report(run);
      }
      const outcomes = itemOutcomes(batch, response).items, items = { ...run.items }, owned = [...run.owned];
      for (const outcome of outcomes) {
        const item = batch.items.find(row => row.ref === outcome.ref), entry = { outcome: outcome.outcome, entity: item.entity, op: item.op, attempt: batch.attempt, ...(outcome.fault ? { fault: outcome.fault } : {}), ...(outcome.next ? { next: outcome.next } : {}) };
        if (outcome.outcome === 'saved') {
          const record = outcome.record, complete = isComplete(item.entity, record, item.op === 'create' ? item.payload : null);
          entry.qboId = String(record?.Id ?? ''); entry.version = record?.SyncToken ?? null; entry.record = record || null;
          if (!QBO_ID.test(entry.qboId) || !matchesRequest(item.payload, record || {})) { entry.outcome = 'mismatch'; entry.next = { action: 'unresolved', reason: 'QuickBooks saved values that differ from the request.' }; }
          else {
            entry.complete = complete; entry.parents = invalidatedParents(item.before || null, record);
            if (complete && retain) await retain(scope, item.entity, record, new Date(now()).toISOString());
            owned.push({ key: item.entity + ':' + entry.qboId, ref: item.ref, op: item.op });
          }
        }
        if (outcome.outcome === 'deleted') owned.push({ key: item.entity + ':' + item.id, ref: item.ref, op: 'delete' });
        items[item.ref] = entry;
      }
      const open = Object.values(items).filter(item => !['saved', 'deleted'].includes(item.outcome));
      const status = open.some(item => ['unknown', 'mismatch'].includes(item.outcome)) ? 'unknown' : open.length ? 'needs-correction' : 'sending';
      run = await save(run, { batches: run.batches.map(row => row.index === batch.index ? { ...row, state: 'answered', answeredAt: new Date(now()).toISOString() } : row), items, owned, status, lastError: open.length ? open.map(item => item.entity + ' (' + item.outcome + ')' + (item.fault ? ': ' + item.fault.map(row => row.code + ' ' + row.message).join('; ') : '')).join(' | ') : null });
      if (status !== 'sending') return report(run);
      if (run.batches.length >= MAX_ATTEMPTS * Math.max(1, run.plan.layers.length)) fail('This general write used its attempt budget.');
    }
    return report(run);
  }
  function report(run, problems = null) {
    return { runId: run._id, status: run.status, items: Object.fromEntries(Object.entries(run.items).map(([ref, item]) => [ref, { outcome: item.outcome, entity: item.entity, ...(item.qboId ? { qboId: item.qboId } : {}), ...(item.fault ? { fault: item.fault } : {}), ...(item.next ? { next: item.next } : {}) }])), batches: run.batches.length, ...(run.lastError ? { message: run.lastError } : {}), ...(problems ? { problems } : {}) };
  }
  return { prepare, execute, dispatchEnabled: () => Boolean(dispatchEnabled() && transport) };
}
// The published business context the guards need: open day, protected and verified dates,
// published tax codes and their total percentages (from the copy's TaxCode/TaxRate).
function createGeneralWriteContext({ models, now = () => Date.now() }) {
  return async (scope, local) => {
    const { businessDate } = require('./business-activity-preview'), { shift } = require('./business-calendar');
    const calendar = await models.Calendars.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId }).lean();
    const control = (await models.Policies.findOne({ environment: scope.environment, realmId: scope.realmId }).select('periodControl').lean())?.periodControl;
    const day = businessDate(new Date(now()));
    if (!calendar?.verifiedThrough || shift(calendar.verifiedThrough, 1) !== day) fail('General writes need verified history through yesterday; today (' + day + ') is the open business day.');
    // The published business decides the tax codes (the same authority the fixed
    // workflows use); without it nothing can be guarded.
    const published = await require('./business-authority').readPublishedBusiness({ ...models, scope });
    const mappings = published?.view?.mappings || {};
    const taxCodes = { sales: [mappings.salesTax].filter(Boolean).map(String), purchases: [mappings.purchaseTax].filter(Boolean).map(String) };
    if (!taxCodes.sales.length || !taxCodes.purchases.length) fail('The published business has no sales and purchase tax codes.');
    const taxPercent = {}, rate = row => Number(local.get('TaxRate', String(row.TaxRateRef?.value))?.RateValue) || 0;
    for (const id of taxCodes.sales) taxPercent[id] = (local.get('TaxCode', id)?.SalesTaxRateList?.TaxRateDetail || []).reduce((sum, row) => sum + rate(row), 0);
    for (const id of taxCodes.purchases) taxPercent[id] = Math.max(taxPercent[id] || 0, (local.get('TaxCode', id)?.PurchaseTaxRateList?.TaxRateDetail || []).reduce((sum, row) => sum + rate(row), 0));
    return { day, verifiedThrough: calendar.verifiedThrough, protectedThrough: [control?.closedThrough, control?.reconciledThrough].filter(Boolean).sort().at(-1) || null, taxCodes, taxPercent };
  };
}
// Server composition: the synced copy through the hardened observation store (fresh
// sources only), the published-business context, and NO transport yet (dispatch held).
function createDefaultGeneralWrite({ now = () => Date.now() } = {}) {
  const models = { ...require('./business-runtime').loadModels(), Authorities: require('../models/BusinessAuthority'), Versions: require('../models/BlueprintVersion'), Baselines: require('../models/BusinessBaseline') };
  const observations = require('./business-observation-store').createBusinessObservationStore({ now });
  const copy = { read: async (scope, entity, id) => (await observations.read(scope, entity, id))?.record || null };
  return createGeneralWriteService({ models, copy, contextFor: createGeneralWriteContext({ models, now }), transport: null, now });
}
module.exports = { createGeneralWriteService, createGeneralWriteContext, createDefaultGeneralWrite, loadCopy, resolve, matchesRequest };
