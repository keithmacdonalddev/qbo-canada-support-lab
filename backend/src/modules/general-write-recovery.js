'use strict';
// Item-level outcomes and recovery of general-write-v1 batches (design rev 3, R1-6 and
// the R2 note on unresolved outcomes). Pure.
//
// A saved batch carries its requestid and each item's bId BEFORE it is sent. Outcomes:
//   lost response      -> replay the unchanged batch with the SAME requestid and bIds;
//   item saved         -> verify from the (complete) response;
//   item fault (5010)  -> refresh that record and make a NEW attempt for that item only,
//                         rerunning its guards; successful siblings are kept;
//   other item fault   -> back to the model to correct (a corrected item is a new attempt);
//   item absent        -> unknown: resolve by correlated read-back, never by resending
//                         under a new identity; without a reliable correlation the item
//                         stays UNRESOLVED and blocks everything that shares its resources.
const STALE = '5010';
const { preservesBillableState } = require('./billable-charge-links');
// A response must prove the void, not merely echo the target id or a user-entered note.
function voidedRecord(record) {
  return Boolean(record && (record.status === 'Voided' || /^Voided(?:$|[\s:])/.test(record.PrivateNote || '')) && record.TotalAmt === 0
    && ['Balance', 'UnappliedAmt', 'HomeBalance', 'HomeTotalAmt'].every(key => record[key] === undefined || record[key] === 0)
    && (record.TxnTaxDetail?.TotalTax === undefined || record.TxnTaxDetail.TotalTax === 0)
    && (record.TxnTaxDetail?.TaxLine || []).every(line => line.Amount === 0)
    && (record.Line || []).every(line => line.Amount === 0 && (line[line.DetailType]?.Qty === undefined || line[line.DetailType].Qty === 0)));
}
function matchesVoid(item, record) {
  const version = item.before?.SyncToken ?? item.targetVersion ?? item.payload?.SyncToken;
  return voidedRecord(record) && String(record.Id) === String(item.id || item.payload?.Id)
    && /^(0|[1-9]\d{0,63})$/.test(record.SyncToken || '') && /^(0|[1-9]\d{0,63})$/.test(version || '') && BigInt(record.SyncToken) > BigInt(version);
}
// Compare every requested nested field, including line account/item/tax and links.
// QuickBooks may add computed fields and reference display names.
function matchesRequest(sent, saved, entity) { return require('./qbo-semantic-compare').matchesQboRequest(sent, saved, { entity }); }
// Sparse readback must preserve native billable history omitted from the payload.
function matchesSavedRequest(item, record) {
  return matchesRequest(item.payload || {}, record, item.entity) && preservesBillableState(item.before, record, item.entity) && require('./general-write-currency').preservesCurrency(item.before, record, item.payload, item.entity);
}
// Correlation available for an item whose outcome is unknown.
function correlation(item) {
  if (item.op === 'create' && ['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'Class', 'Department', 'Term', 'PaymentMethod'].includes(item.entity)) return item.payload?.DisplayName || item.payload?.Name ? 'unique-name' : null;
  if (item.op === 'create' && item.payload?.PrivateNote && String(item.payload.PrivateNote).includes(item.marker || '\u0000')) return 'private-note-marker';
  if (item.op === 'create' && item.payload?.DocNumber) return 'doc-number';
  // An update or void is observable as a newer version carrying the requested values;
  // a delete cannot be told apart from an external delete.
  if (['update', 'void'].includes(item.op) && item.targetVersion != null) return 'version-and-values';
  return null;
}
// batch: { requestId, items: [{ bId, ref, op, entity, payload, targetVersion?, marker? }] };
// response: the BatchItemResponse list, or null when the response was lost.
function itemOutcomes(batch, response) {
  if (response === null || response === undefined) return { lost: true, next: { action: 'replay', requestId: batch.requestId, bIds: batch.items.map(item => item.bId) }, items: batch.items.map(item => ({ ref: item.ref, bId: item.bId, outcome: 'pending' })) };
  const byId = new Map();
  for (const row of Array.isArray(response) ? response : []) { const key = String(row?.bId); byId.set(key, byId.has(key) ? null : row); }
  const items = batch.items.map(item => {
    const row = byId.get(String(item.bId));
    if (!row) return { ref: item.ref, bId: item.bId, outcome: 'unknown', next: correlation(item) ? { action: 'read-back', by: correlation(item) } : { action: 'unresolved', reason: 'No reliable correlation; the barrier holds until the record is attributed.' } };
    const errors = row.Fault?.Error || [];
    if (row.Fault && (row.Fault.type !== 'ValidationFault' || !errors.length)) return { ref: item.ref, bId: item.bId, outcome: 'unknown', next: { action: 'unresolved', reason: 'The response does not prove a validation refusal.' } };
    if (errors.length) {
      const stale = errors.some(error => String(error?.code) === STALE);
      return { ref: item.ref, bId: item.bId, outcome: 'fault', fault: errors.map(error => ({ code: String(error?.code ?? ''), message: String(error?.Message ?? error?.message ?? ''), detail: String(error?.Detail ?? '') })), next: stale ? { action: 'refresh-and-new-attempt', reason: 'Stale SyncToken: read the record once, rerun its guards, then a new attempt with a new requestid.' } : { action: 'correct', reason: 'Return the fault to the model; a corrected item is a new attempt.' } };
    }
    const entity = Object.keys(row).find(key => !['bId', 'Fault', 'time'].includes(key));
    const wireEntity=item.entity==='CreditCardPayment'?'CreditCardPaymentTxn':item.entity;
    const record = row[wireEntity], valid = entity === wireEntity && record && typeof record.Id === 'string' && /^\d{1,30}$/.test(record.Id) && (!item.id || record.Id === String(item.id));
    if (item.op === 'delete') return valid && record.Id === String(item.id || item.payload?.Id) && record.status === 'Deleted' ? { ref: item.ref, bId: item.bId, outcome: 'deleted', record } : { ref: item.ref, bId: item.bId, outcome: 'unknown', next: { action: 'unresolved', reason: 'The exact deletion is not proved by this response.' } };
    if (!valid || typeof record.SyncToken !== 'string' || !/^(0|[1-9]\d{0,63})$/.test(record.SyncToken)) return { ref: item.ref, bId: item.bId, outcome: 'unknown', next: { action: 'unresolved', reason: 'The saved entity identity or version is incomplete.' } };
    if (item.op === 'void' && !matchesVoid(item, record)) return { ref: item.ref, bId: item.bId, outcome: 'unknown', next: { action: 'unresolved', reason: 'A newer zero-amount void response is required.' } };
    return { ref: item.ref, bId: item.bId, outcome: entity === wireEntity ? 'saved' : 'unknown', record: row[entity] || null, ...(entity === wireEntity ? {} : { next: { action: 'unresolved', reason: 'The response carried another entity type.' } }) };
  });
  return { lost: false, items };
}
// Items that may be sent next: none whose resources are shared with an unknown or
// unresolved item (a barrier), and none depending on an item that did not save.
function blockedRefs(outcomes, resources, dependsOn) {
  const open = outcomes.filter(row => ['unknown', 'pending'].includes(row.outcome) || row.next?.action === 'unresolved').map(row => row.ref);
  const failed = new Set(outcomes.filter(row => !['saved', 'deleted'].includes(row.outcome)).map(row => row.ref));
  const held = new Set(open.flatMap(ref => resources[ref] || []));
  return Object.keys(resources).filter(ref => !outcomes.some(row => row.ref === ref) && ((resources[ref] || []).some(key => held.has(key)) || (dependsOn[ref] || []).some(name => failed.has(name)))).sort();
}
function capturedMatchesSavedRequest(item, record) {
  return require('./business-replay-evidence').captureFunction('general-write-recovery', 'matchesSavedRequest', matchesSavedRequest, [item, record]);
}
function capturedItemOutcomes(batch, response) {
  return require('./business-replay-evidence').captureFunction('general-write-recovery', 'itemOutcomes', itemOutcomes, [batch, response]);
}
module.exports = { itemOutcomes: capturedItemOutcomes, blockedRefs, correlation, STALE, matchesRequest, matchesSavedRequest: capturedMatchesSavedRequest, voidedRecord, matchesVoid };

// Recovery is read-only at QuickBooks: known saved records are never re-sent.
const RECHECK_MS = 60000;
function checkDue(run, now) {
  if (!run || run.executionPending || ['stopped', 'retired', 'verified'].includes(run.status)) return false;
  const last = Date.parse(run.recheckAt || run.executionRequestedAt || '');
  return !Number.isFinite(last) || now - last >= RECHECK_MS;
}
async function recheckSavedOperations({ runs, now, request, guard, limit = 3 }) {
  let queued = 0;
  for (const run of runs.filter(row => row.recheckAvailable && checkDue(row, now)).slice(0, limit)) {
    await guard();
    await request(run, 'saved-check-' + Math.floor(now / RECHECK_MS));
    queued++;
  }
  return queued;
}
function historyFail(message) { throw Object.assign(new Error(message), { status: 409, code: 'GENERAL_HISTORY_UNVERIFIED' }); }
// Original successful mutations after a retained observation explain its changed
// balances. The before-image and exact response remain authoritative; never infer
// a write from a currently similar record or accept an unknown outcome.
function historyMovements(runs, observedAt, ctx, throughDate = null) {
  const { movementsOf } = require('./general-write-postings');
  const since = Date.parse(observedAt), movements = [];
  if (!Number.isFinite(since)) historyFail('Historical report observation has no timestamp.');
  for (const run of runs) for (const [ref, item] of Object.entries(run.items || {})) {
    if (!['saved', 'deleted'].includes(item.outcome)) continue;
    const batch = (run.batches || []).find(row => row.attempt === item.attempt && row.items?.some(sent => sent.ref === ref));
    const at = Date.parse(batch?.answeredAt || run.updatedAt || '');
    if (!Number.isFinite(at)) historyFail('A saved history change has no durable observation time.');
    if (at <= since) continue;
    const op = run.plan?.operations?.find(row => row.ref === ref), sent = batch?.items.find(row => row.ref === ref);
    const before = item.before || sent?.before || op?.before || null;
    if (throughDate && ![before?.TxnDate, item.record?.TxnDate].some(date => date && date <= throughDate)) continue;
    if (item.op !== 'create' && !before) historyFail('A saved history change lost its before-image.');
    if (item.outcome === 'saved' && !matchesSavedRequest({ payload: item.request || sent?.payload || op?.payload || {}, before, entity: item.entity }, item.record)) historyFail('A saved history change differs from its original request.');
    movements.push(...movementsOf(item.entity, item.op === 'create' ? null : before, item.outcome === 'deleted' ? null : item.record, { ...ctx, postingSources: item.postingSources || sent?.postingSources || {} }));
  }
  return movements;
}
function sourceBalances(source) {
  const { unpackReport } = require('./business-report-source');
  const accounts = source.accounts || [];
  return require('./business-financial-movements').balances(unpackReport('TrialBalance', source.reports.TrialBalance, source.version), accounts, accounts.map(row => ({ id: row.Id, key: row.Id })), source.period);
}
function compareHistoryBalances(reference, current, movements, throughDate = current.period.throughDate) {
  const before = sourceBalances(reference), after = sourceBalances(current), expected = { ...before };
  const accounts = new Map([...reference.accounts, ...current.accounts].map(row => [row.Id, row]));
  for (const row of movements) if (row.date <= throughDate) expected[row.accountId] = (expected[row.accountId] || 0) + row.cents;
  const differences = [];
  for (const id of new Set([...Object.keys(expected), ...Object.keys(after)])) {
    const want = expected[id] || 0, got = after[id] || 0;
    if (!Number.isSafeInteger(want) || !Number.isSafeInteger(got) || !accounts.has(id) || want !== got) differences.push({ accountId: id, expectedCents: want, actualCents: got });
  }
  return { ok: differences.length === 0, differences };
}
function assertHistorySource(source, scope, period, now) {
  const { hash, canonical } = require('./business-calendar');
  const { sourceHash, evaluation: ignored, ...raw } = source || {};
  const stamp = Date.parse(raw.startedAt), end = Date.parse(raw.observedAt);
  if (hash(raw) !== sourceHash || canonical(raw.scope) !== canonical(scope) || canonical(raw.period) !== canonical(period) || !Number.isFinite(stamp) || !Number.isFinite(end) || end < stamp || end > now || now - stamp > 300000) historyFail('History needs fresh reports for the exact company and day.');
  const evaluation = require('./book-evidence').evaluateReportSources(raw, { allowExplicitZero: true });
  if (!require('./business-financial-summary').reportComplete(evaluation, raw) || evaluation.checks.some(row => row.status !== 'passed')) historyFail('History reports do not pass the complete accounting checks.');
  return raw;
}
// Every day gets fresh records, a debit/credit ledger and full report checks. Original
// period endpoints additionally re-prove ALL account balances plus authorized edits;
// successive daily balances must roll forward by the complete current ledger.
async function reverifyHistory({ scope, range, runs, references, readReports, verifyDay, context, now, guard = async () => {}, save }) {
  const { shift, hash } = require('./business-calendar');
  const { parseLedger } = require('./general-write-day-close');
  const checkpoints = new Map();
  for (const source of references) {
    const day = source.period?.throughDate;
    if (day && (!checkpoints.has(day) || source.observedAt > checkpoints.get(day).observedAt)) checkpoints.set(day, source);
  }
  if (!checkpoints.has(range.through)) historyFail('The current cursor has no retained accounting observation to re-prove.');
  if (range.baseline && !checkpoints.has(shift(range.from, -1))) historyFail('Opening baseline report evidence is unavailable.');
  const from = range.baseline ? shift(range.from, -1) : range.from, results = [];
  let previous = null;
  for (let day = from; day <= range.through; day = shift(day, 1)) {
    await guard();
    const reference = checkpoints.get(day), period = reference?.period || { fromDate: day, throughDate: day };
    const source = await readReports(period);
    assertHistorySource(source, scope, period, now());
    const closed = await verifyDay(day);
    if (!closed.ok) historyFail('History day ' + day + ' still has unverified records: ' + closed.failures.map(row => row.reason).join(' | '));
    if (reference) {
      const comparison = compareHistoryBalances(reference, source, historyMovements(runs, reference.observedAt, context, day));
      if (!comparison.ok) historyFail('Historical account movements differ on ' + day + ': ' + JSON.stringify(comparison.differences));
    }
    if (previous) {
      const ledger = parseLedger(closed.ledgerReport, day);
      if (ledger.unknown.length) historyFail('A historical ledger contains unattributed movements.');
      const movements = Object.values(ledger.byRecord).flat().map(row => ({ ...row, date: day }));
      // Admission limits edits to the current business fiscal year. January 1
      // is an ordinary day for a business with a later fiscal year start.
      {
        const comparison = compareHistoryBalances(previous, source, movements);
        if (!comparison.ok) historyFail('Daily account roll-forward differs on ' + day + ': ' + JSON.stringify(comparison.differences));
      }
    }
    await guard();
    const proof = { day, baseline: range.baseline && day === from, sourceHash: source.sourceHash, ledgerHash: hash(closed.ledgerReport), records: [...closed.records, ...(closed.fixedRecords || [])], sources: source };
    await save(proof); results.push({ day, sourceHash: proof.sourceHash }); previous = source;
  }
  return { ok: true, from, through: range.through, days: results };
}
module.exports.RECHECK_MS = RECHECK_MS;
module.exports.checkDue = checkDue;
module.exports.recheckSavedOperations = recheckSavedOperations;
module.exports.historyMovements = historyMovements;
module.exports.sourceBalances = sourceBalances;
module.exports.compareHistoryBalances = compareHistoryBalances;
module.exports.reverifyHistory = reverifyHistory;

// Retry unanswered general batches on the existing one-minute accountant wake.
// Retained replies are attributed without dispatch; genuinely lost replies use the
// saved requestid/bIds through the normal gate. Never reconstruct a proposal.
async function recheckGeneralWrites({ scope, models, access, now = () => Date.now(), guard = async () => {}, signal, service = null }) {
  if (!models?.GeneralWriteRuns || !models.Agents) return [];
  const agent = await models.Agents.findOne({ ...scope, 'settings.monitoring': true, 'settings.autonomous': true }).maxTimeMS(3000).lean();
  if (!agent?.grant) return [];
  const runs = await models.GeneralWriteRuns.find({ ...scope, contract: 'general-write-v1', status: { $in: ['unknown', 'sending'] }, updatedAt: { $lte: new Date(now() - RECHECK_MS) }, batches: { $elemMatch: { state: { $ne: 'answered' } } }, 'agentAuthority.agentId': String(agent._id), 'agentAuthority.grantId': agent.grant.id, 'agentAuthority.authorityHash': agent.grant.authorityHash, 'agentAuthority.ownerId': String(agent.ownerId), ownerId: agent.ownerId }).sort({ updatedAt: 1, _id: 1 }).limit(3).maxTimeMS(3000).lean();
  // Unanswered requests keep priority. Saved PO verification never consumes
  // their bounded recovery slots, even when a genuine mismatch remains held.
  if (runs.length < 3) {
    const held = await models.GeneralWriteRuns.find({ ...scope, contract: 'general-write-v1', status: 'needs-correction', updatedAt: { $lte: new Date(now() - RECHECK_MS) }, batches: { $elemMatch: { state: 'answered', 'transport.outcome': 'saved', 'items.entity': { $in: ['PurchaseOrder', 'Invoice'] } } }, 'agentAuthority.agentId': String(agent._id), 'agentAuthority.grantId': agent.grant.id, 'agentAuthority.authorityHash': agent.grant.authorityHash, 'agentAuthority.ownerId': String(agent.ownerId), ownerId: agent.ownerId }).sort({ updatedAt: 1, _id: 1 }).limit(3 - runs.length).maxTimeMS(3000).lean();
    runs.push(...held);
  }
  const results = [];
  for (const run of runs) {
    if (signal?.aborted) break;
    await guard();
    // Replay admission rechecks the same grant transactionally before dispatch.
    const a = run.agentAuthority;
    try {
      const api = service || require('./general-write-service').createDefaultGeneralWrite({ now, access });
      const result = await api.execute({ scope, ownerId: String(run.ownerId), actorId: String(run.actorId), agentAuthority: a }, String(run._id));
      results.push({ runId: String(run._id), ok: result.status === 'complete' || Object.values(result.items || {}).some(item => item.qboId), status: result.status });
    } catch (error) { if (error?.businessAgentFatal) throw error; results.push({ runId: String(run._id), ok: false, code: error.code || 'GENERAL_WRITE_RECOVERY_FAILED' }); }
  }
  return results;
}
module.exports.recheckGeneralWrites = recheckGeneralWrites;

// Composed only on an existing accountant wake. No independent timer or startup work.
async function recheckGeneralHistory({ scope, access, models, now = () => Date.now(), guard = async () => {}, signal }) {
  const recovered = await recheckGeneralWrites({ scope, models, access, now, guard, signal });
  if (!models?.Calendars || !models.Writers || !models.GeneralWriteRuns) return { checked: false, results: recovered };
  const { hash } = require('./business-calendar');
  const persistedHash = value => hash(JSON.parse(JSON.stringify(value)));
  const read = (model, filter, session) => model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const calendar = await read(models.Calendars, scope), writer = await read(models.Writers, { environment: scope.environment, realmId: scope.realmId });
  if (!calendar?.verifiedThrough || !writer || calendar.pendingCommit || calendar.currentOperationId || writer.operationId || writer.unresolved || writer.resourceClaims?.some(row => row.state === 'admitted')) return { checked: false, results: recovered };
  const fence = async session => {
    if (signal?.aborted) historyFail('History re-check was cancelled.');
    await guard(); await access.authorize(scope, 'operations.verify', { session, signal });
    const fresh = await read(models.Calendars, scope, session), current = await read(models.Writers, { environment: scope.environment, realmId: scope.realmId }, session);
    if (persistedHash(fresh) !== persistedHash(calendar) || persistedHash(current) !== persistedHash(writer)) historyFail('Company activity changed during history re-check.');
    if (session) {
      const touched = await models.Writers.findOneAndUpdate({ _id: writer._id, revision: writer.revision, operationId: null, unresolved: null }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!touched) historyFail('The company writer changed before history proof committed.');
    }
  };
  await fence();
  models = { ...models, Evidence: models.Evidence || require('../models/OperationEvidence'), Versions: models.Versions || require('../models/BlueprintVersion') };
  const allModels = { ...models, GeneralDayCloses: models.GeneralDayCloses || require('../models/GeneralDayClose') };
  const active = await require('./business-authority').readPublishedBusiness({ ...models, scope });
  const client = await access.resolveClient(scope, { signal });
  const copy = { read: async (s, entity, id) => {
    await guard(); const record = (await client.apiCall('GET', entity.toLowerCase() + '/' + id, undefined, 0, 0, { signal }))?.[entity==='CreditCardPayment'?'CreditCardPaymentTxn':entity];
    return record || null;
  } };
  const gate = require('./general-write-close-gate').createGeneralCloseGate({ models: allModels, copy, now, readValuation: require('./business-stock-valuation').createValuationReader({access,now}) });
  const options = { verifiedThrough: calendar.verifiedThrough, openingDate: calendar.openingDate, mappings: active.view.mappings || {}, readLedger: async (from, through) => { await guard(); return client.apiCall('GET', gate.ledgerEndpoint(from, through), undefined, 0, 0, { signal }); } };
  const dirtyRuns = await require('./general-write-day-close').readGeneralRuns(models.GeneralWriteRuns, scope);
  const need = { unresolved: dirtyRuns.flatMap(run => (run.dirty || []).filter(marker => marker.date <= calendar.verifiedThrough)) };
  let history = null;
  if (need.unresolved.length) {
    const references = [], Evidence = models.Evidence, Runs = models.Runs;
    const candidates = new Map(), earliest = need.unresolved.map(marker => marker.date).sort()[0];
    let after = null;
    for (;;) {
      const page = await Evidence.find({ ...scope, 'proof.complete': true, 'proof.throughDate': { $gte: earliest, $lte: calendar.verifiedThrough }, ...(after ? { _id: { $gt: after } } : {}) }).select('_id operationId evidenceHash proof.throughDate proof.observedAt').sort({ _id: 1 }).limit(500).maxTimeMS(3000).lean();
      if (after && page.some(row => String(row._id) <= after)) historyFail('History observation enumeration did not advance.');
      for (const row of page) { const day = row.proof.throughDate; if (!candidates.has(day)) candidates.set(day, []); candidates.get(day).push(row); }
      if (page.length < 500) break; after = String(page.at(-1)._id);
    }
    // Read complete raw sources only for the newest committed observation of each
    // day. Activity batches may leave many observations at the same endpoint.
    for (const rows of candidates.values()) for (const selected of rows.sort((a, b) => b.proof.observedAt.localeCompare(a.proof.observedAt))) {
      const run = await read(Runs, { _id: selected.operationId, ...scope });
      if (run?.status !== 'verified' || run.completion?.evidenceHash !== selected.evidenceHash) continue;
      const row = await read(Evidence, { _id: selected._id, ...scope });
      const { sourceHash, evaluation: ignored, ...source } = row?.sources || {};
      if (!row || hash(row.proof) !== row.evidenceHash || hash(source) !== sourceHash) historyFail('Retained historical accounting evidence changed.');
      references.push(row.sources); break;
    }
    const baseline = await read(models.Baselines, { ...scope, evidenceHash: calendar.baseline.evidenceHash });
    if (baseline) references.push(require('./business-baseline').validateBaselineObservation(baseline).sources);
    // Disable report reuse: retry means fresh company reads and fresh named checks.
    const readReports = require('./business-report-evidence').createBusinessReportReader({ access, now, cache: { snapshot: async () => null } });
    const transaction = require('./business-transaction').createBusinessTransaction(require('mongoose').connection);
    const verifyFixedDay = async (from, through, general) => {
      const proofs = [], known = new Set(general.map(row => row.entity + ':' + row.id));
      let after = null;
      for (;;) {
        const rows = await models.Steps.find({ ...scope, ...(after ? { _id: { $gt: after } } : {}) }).select('_id entity qboId state verification receipt compilation dispatch').sort({ _id: 1 }).limit(500).maxTimeMS(3000).lean();
        if (after && rows.some(row => String(row._id) <= after)) historyFail('Historical activity enumeration did not advance.');
        for (const row of rows) {
          let request; try { request = JSON.parse(row.compilation?.request?.body || '{}'); } catch { historyFail('Historical activity lost its original request.'); }
          if (!request.TxnDate || request.TxnDate < from || request.TxnDate > through || known.has(row.entity + ':' + row.qboId)) continue;
          if (row.state !== 'verified' || !row.receipt || row.receipt.qboId !== row.qboId || !row.verification?.observedHash || row.verification.kind !== 'business-readback' || row.verification.compilationHash !== row.dispatch?.compilationHash) historyFail('Historical activity has no verified original receipt.');
          const record = await copy.read(scope, row.entity, row.qboId);
          if (!record || hash(record) !== row.verification.observedHash) historyFail('A fixed historical record changed and needs its original graph re-check.');
          proofs.push({ key: row.entity + ':' + row.qboId, observedHash: hash(record) });
        }
        if (rows.length < 500) break; after = String(rows.at(-1)._id);
      }
      return proofs;
    };
    history = await gate.reverifyDirty(scope, { ...options, references, verifyFixedDay, readReports: period => readReports(scope, period, { signal }), guard: fence, transaction });
  }
  const results = await gate.retryFailed(scope, options);
  return { checked: true, history, results: [...recovered, ...results] };
}
module.exports.recheckGeneralHistory = recheckGeneralHistory;
