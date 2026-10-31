'use strict';
// Activity policy v8: the accountant collects or pays its OWN open terms invoices and
// bills (invoice-on-terms, bill-on-terms), in full or in part, and converts its own sent
// estimates (send-estimate) into time and an invoice on terms, as governed same-day
// activity. The agent names the record, its party and the amount. The original's
// identity and saved dependency closure are derived here from its immutable creation
// intent (the plan store's validated history) and become the batch's existing
// prerequisites. Every rule is proved before a plan is saved; the compiler re-proves
// the open balance and links inside the writer fence before anything is sent.
//
// Eligible: a verified record created by an activity batch on payment terms, for this
// company, with the complete ownership chain (business-correction ownershipProblem),
// still open, settled so far only by its own verified payments, never corrected, and
// with no other unsent planned work depending on it. Imported, adopted, calendar and
// same-day-settled records are refused explicitly.
const { canonical } = require('./business-calendar');
const QBO_ID = /^\d{1,30}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_OWN_SETTLEMENT_UNAVAILABLE' }); }
const same = (a, b) => a != null && b != null && String(a) === String(b);
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => same(a?.[key], b?.[key]));
const company = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId });
function cents(value) { const n = Math.round(Number(value) * 100); if (typeof value !== 'number' || !Number.isSafeInteger(n) || Math.abs(value * 100 - n) > 0.00001) fail('A saved QuickBooks amount is not an exact cent value.'); return n; }
function linkTypes(record) { return [...(record.LinkedTxn || []), ...(record.Line || []).flatMap(line => line.LinkedTxn || [])].map(link => link?.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link?.TxnType); }
const label = (entity, qboId) => entity + ' ' + qboId;
const specOf = type => require('./business-activity-batch').OWN_SOURCED[type];
// Activity types whose batches can leave one of these records open.
const OPENING_TYPES = ['invoice-on-terms', 'bill-on-terms', 'send-estimate', 'convert-own-estimate'];

// The original terms record, its creation intent and its fresh QuickBooks state.
async function ownOriginal({ models, scope, history, readRecord, entity, qboId }) {
  const name = label(entity, qboId);
  if (!['Invoice', 'Bill', 'Estimate'].includes(entity) || !QBO_ID.test(qboId || '')) fail('Only your own invoices and bills on terms can be collected or paid, and your own sent estimates converted.');
  const Records = models.PopulationRecords || require('../models/BusinessPopulationRecord');
  if (await Records.findOne({ environment: scope.environment, realmId: scope.realmId, entity, qboId }).select('_id').maxTimeMS(3000).lean()) fail(name + ' came from imported (adopted) history' + (entity === 'Estimate' ? '; only estimates the accountant sent can be converted.' : '; settle it with ' + (entity === 'Invoice' ? 'collect-adopted-invoice' : 'pay-adopted-bill') + '.'));
  const rows = await models.Steps.find({ environment: scope.environment, realmId: scope.realmId, entity, qboId }).limit(2).maxTimeMS(3000).lean();
  if (!rows.length) fail(name + ' was not created by the accountant’s governed workflows.');
  if (rows.length !== 1 || !sameScope(rows[0], scope)) fail(name + ' belongs to an earlier connection or is claimed twice.');
  if (rows[0].state !== 'verified') fail(name + ' has not been verified yet.');
  const step = rows[0], observed = await history(scope, [step.logicalKey]), entries = observed.entries || [], entry = entries.find(row => row.logicalKey === step.logicalKey);
  if (!entry || entry.entity !== entity || entry.qboId !== qboId || entry.fingerprint !== step.fingerprint || entry.state !== 'verified' || entries.length > 10) fail(name + ' lost its original creation intent.');
  const d = entry.step.details;
  if (entity === 'Estimate' ? d?.activityBatch === undefined || d.quoteOnly !== true : d?.activityBatch === undefined || d.paymentTerms === undefined || d.correction !== undefined) fail(entity === 'Estimate' ? name + ' was not sent on its own by your activity (send-estimate); quotes of scheduled or same-day jobs convert with their own workflow.' : name + ' was not raised on payment terms by your own activity; scheduled and same-day settled records are collected or paid by their own workflow.');
  const record = await readRecord(entity, qboId);
  if (!record || record.Id !== qboId || record.CurrencyRef?.value !== 'CAD' || record.status === 'Deleted') fail(name + ' could not be read completely from QuickBooks.');
  if (record.TxnDate !== entry.step.txnDate) fail(name + ' changed its date in QuickBooks; it cannot be settled.');
  const sources = entries.map(row => ({ logicalKey: row.logicalKey, entity: row.entity, txnDate: row.step.txnDate, dependsOn: row.step.dependencies.map(link => link.logicalKey).sort() })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
  const source = { logicalKey: entry.logicalKey, txnDate: entry.step.txnDate, sources };
  if (entity === 'Estimate') { const line = d.lines[0]; return { step, entry, record, partyKey: d.customerKey, total: cents(record.TotalAmt), quote: { itemKey: line.itemKey, quantity: line.quantity, unitPriceCents: line.unitPriceCents }, source }; }
  return { step, entry, record, partyKey: entity === 'Invoice' ? d.customerKey : d.vendorKey, dueDate: d.dueDate, termsDays: d.paymentTerms.days, total: cents(record.TotalAmt), balance: cents(record.Balance), source };
}
// What must hold for this record to be settled now (independent of the amount).
async function assertSettleable({ models, scope, ownerId, businessKey, original, day, ownership }) {
  const { step, entry, record } = original, entity = entry.entity, name = label(entity, entry.qboId);
  if (entry.step.txnDate >= day) fail(name + ' is from today. ' + (entity === 'Estimate' ? 'Convert' : 'Settle') + ' it tomorrow, after today’s history is verified.');
  const problem = await require('./business-correction').ownershipProblem(models, scope, ownerId, step, ownership);
  if (problem) fail(name + ' cannot be ' + (entity === 'Estimate' ? 'converted' : 'settled') + ': ' + problem + '.');
  if (entity === 'Estimate') {
    // A sent estimate converts once, whole, while QuickBooks still shows it open.
    if (!['Pending', 'Accepted'].includes(record.TxnStatus) || linkTypes(record).length) fail(name + ' is no longer open (status ' + (record.TxnStatus || 'unknown') + ') or is already linked to an invoice.');
    if (await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, 'dependencies.logicalKey': entry.logicalKey, state: { $ne: 'rejected' } }).select('_id').maxTimeMS(3000).lean()) fail(name + ' already has time or an invoice recorded against it.');
    await assertNoPlannedWork(models, scope, entry, [], name);
    return;
  }
  if (original.balance <= 0) fail(name + ' is already fully ' + (entity === 'Invoice' ? 'collected' : 'paid') + '.');
  if (original.balance > original.total) fail(name + ' shows an open balance above its total.');
  const allowed = entity === 'Invoice' ? ['Estimate', 'TimeActivity', 'Payment'] : ['BillPayment'];
  if (linkTypes(record).some(type => !allowed.includes(type))) fail(name + ' has a credit or other link besides its own payments.');
  // A correction (sent, unknown or planned) reverses the original: never also settle it.
  const { reversalKeys, REVERSALS } = require('./business-correction');
  const reversals = reversalKeys(scope, businessKey, { logicalKey: entry.logicalKey, txnDate: entry.step.txnDate }, REVERSALS[entity]);
  if (await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, logicalKey: { $in: reversals } }).select('_id').maxTimeMS(3000).lean()) fail(name + ' has a correction; it is no longer collected or paid.');
  // Earlier settlements must all be verified: an unknown or unfinished one may already
  // have reduced the balance.
  const dependents = await models.Steps.find({ environment: scope.environment, realmId: scope.realmId, 'dependencies.logicalKey': entry.logicalKey }).select('entity state operationId').limit(51).maxTimeMS(3000).lean();
  const settlement = entity === 'Invoice' ? 'Payment' : 'BillPayment';
  if (dependents.some(row => row.entity !== settlement && row.state !== 'rejected')) fail(name + ' has follow-up records other than its own payments.');
  const pending = dependents.find(row => !['verified', 'rejected'].includes(row.state));
  if (pending) fail(name + ' has an earlier ' + (entity === 'Invoice' ? 'collection' : 'payment') + ' still being recorded (' + pending.state + ' in operation ' + pending.operationId + '). Finish it first.');
  await assertNoPlannedWork(models, scope, entry, reversals, name);
}
// Another prepared, unsent batch that settles, converts or corrects this record reserves it.
async function assertNoPlannedWork(models, scope, entry, reversals, name) {
  const open = await models.Runs.find({ ...company(scope), status: { $nin: ['verified', 'retired'] } }).select('planId status').limit(50).maxTimeMS(3000).lean();
  for (const run of open) {
    const planned = await models.Intents.find({ ...company(scope), planId: run.planId, kind: 'create', $or: [{ 'step.dependencies.logicalKey': entry.logicalKey }, { logicalKey: { $in: reversals } }] }).select('logicalKey').limit(20).maxTimeMS(3000).lean();
    for (const row of planned) if (!await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, logicalKey: row.logicalKey, state: 'verified' }).select('_id').maxTimeMS(3000).lean()) fail(name + ' already has work planned in prepared operation ' + run._id + ' (' + run.status + '). Run or retire it first.');
  }
}
// One activity row: the record, its party and the amount against the fresh balance.
async function deriveOwnSettlement({ models, scope, history, readRecord, row }) {
  const spec = specOf(row.type), qboId = row[spec.idKey];
  const original = await ownOriginal({ models, scope, history, readRecord, entity: spec.entity, qboId }), name = label(spec.entity, qboId);
  if (original.partyKey !== row[spec.partyKey]) fail(name + ' belongs to another ' + (spec.entity === 'Bill' ? 'supplier' : 'customer') + ' (' + original.partyKey + ').');
  if (spec.entity === 'Estimate') {
    const value = { type: row.type, estimateId: qboId, customerKey: row.customerKey, termsDays: row.termsDays, purpose: row.purpose, source: original.source, quote: original.quote };
    return { row: require('./business-activity-batch').validateChoices({ decisionKey: 'derive-estimate-conversion', purpose: 'Derive the exact original of one conversion of an own estimate.', activities: [value] }).activities[0], original };
  }
  if (row.amountCents > original.balance) fail(name + ' has an open balance of ' + original.balance + ' cents, less than this ' + (spec.entity === 'Invoice' ? 'collection' : 'payment') + ' of ' + row.amountCents + ' cents.');
  const value = { type: row.type, [spec.idKey]: qboId, [spec.partyKey]: row[spec.partyKey], amountCents: row.amountCents, purpose: row.purpose, source: original.source };
  return { row: require('./business-activity-batch').validateChoices({ decisionKey: 'derive-own-settlement', purpose: 'Derive the exact original of one settlement of an own record.', activities: [value] }).activities[0], original };
}
// Preparation: the agent sent the record, party and amount; derive the source.
async function expandOwnSettlements({ choices, ...input }) {
  const activities = [];
  for (const row of choices.activities) {
    if (!specOf(row.type)) { activities.push(row); continue; }
    const derived = await deriveOwnSettlement({ ...input, row });
    if ((row.source !== undefined && canonical(row.source) !== canonical(derived.row.source)) || (row.quote !== undefined && canonical(row.quote) !== canonical(derived.row.quote))) fail('The supplied source differs from your own original record. Send only the record, its party and the amount or terms; the server derives the rest.');
    activities.push(derived.row);
  }
  return { ...choices, activities };
}
// Before a settlement batch is saved: re-derive (the saved source must be exactly what
// the original yields now) and prove eligibility and the fresh open balance.
async function assertOwnSettlementsEligible({ models, scope, ownerId, businessKey, batch, history, readRecord }) {
  const ownership = new Map();
  for (const row of batch.activities.filter(value => specOf(value.type))) {
    const { source: ignored, quote: unused, ...plain } = row, derived = await deriveOwnSettlement({ models, scope, history, readRecord, row: plain });
    if (canonical(derived.row.source) !== canonical(row.source) || canonical(derived.row.quote ?? null) !== canonical(row.quote ?? null)) fail('The settlement of ' + label(specOf(row.type).entity, row[specOf(row.type).idKey]) + ' no longer matches its original record. Prepare it again.');
    await assertSettleable({ models, scope, ownerId, businessKey, original: derived.original, day: batch.day, ownership });
  }
}
// Activity choices: the accountant's own open terms invoices and bills (with the open
// balance) and its open sent estimates, each with its eligibility. Only verified batches
// that could leave such a record open are searched, newest first.
async function ownOpenRecords({ models, scope, ownerId, businessKey, history, readRecord, day, limit = 40, signal }) {
  const runs = await models.Runs.find({ ...company(scope), status: 'verified', 'activityBatch.activities.type': { $in: OPENING_TYPES } }).select('_id').sort({ _id: -1 }).limit(60).maxTimeMS(3000).lean();
  const steps = runs.length ? await models.Steps.find({ ...company(scope), operationId: { $in: runs.map(run => run._id) }, entity: { $in: ['Invoice', 'Bill', 'Estimate'] }, state: 'verified' }).select('entity qboId').sort({ _id: -1 }).limit(limit).maxTimeMS(3000).lean() : [];
  const invoices = [], bills = [], estimates = [], ownership = new Map();
  for (const step of steps) {
    if (signal?.aborted) fail('Settlement choices were cancelled.');
    let original;
    try { original = await ownOriginal({ models, scope, history, readRecord, entity: step.entity, qboId: step.qboId }); }
    catch (error) { if (signal?.aborted) throw error; continue; }
    if (step.entity === 'Estimate') {
      if (!['Pending', 'Accepted'].includes(original.record.TxnStatus) || linkTypes(original.record).length) continue;
      const row = { estimateId: step.qboId, customerKey: original.partyKey, docNumber: original.record.DocNumber || null, txnDate: original.entry.step.txnDate, status: original.record.TxnStatus, hours: original.quote.quantity, unitPriceCents: original.quote.unitPriceCents, totalCents: original.total };
      try { await assertSettleable({ models, scope, ownerId, businessKey, original, day, ownership }); row.eligible = true; }
      catch (error) { if (signal?.aborted) throw error; row.eligible = false; row.reason = /^BUSINESS_/.test(error.code || '') ? error.message : 'Its conversion eligibility could not be checked.'; }
      estimates.push(row); continue;
    }
    if (original.balance <= 0) continue;
    const invoice = step.entity === 'Invoice', row = { [invoice ? 'invoiceId' : 'billId']: step.qboId, [invoice ? 'customerKey' : 'vendorKey']: original.partyKey, docNumber: original.record.DocNumber || null, txnDate: original.entry.step.txnDate, dueDate: original.dueDate, termsDays: original.termsDays, totalCents: original.total, balanceCents: original.balance };
    try { await assertSettleable({ models, scope, ownerId, businessKey, original, day, ownership }); row.eligible = true; }
    catch (error) { if (signal?.aborted) throw error; row.eligible = false; row.reason = /^BUSINESS_/.test(error.code || '') ? error.message : 'Its settlement eligibility could not be checked.'; }
    (invoice ? invoices : bills).push(row);
  }
  return { ownOpenInvoices: invoices, ownOpenBills: bills, ownOpenEstimates: estimates };
}
module.exports = { ownOriginal, assertSettleable, deriveOwnSettlement, expandOwnSettlements, assertOwnSettlementsEligible, ownOpenRecords };
