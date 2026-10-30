'use strict';
// Activity policy v7: the accountant corrects its OWN earlier records as governed
// same-day activity. A correction never edits or voids the original: it adds a full
// reversal dated today (and, for an unpaid original, a zero-funds application), with
// the original's party, lines, accounts and ORIGINAL-supply tax (CRA Notice 342).
//
// The agent names only the target and a reason. Everything else is derived here from
// the original's immutable creation intent and approved policy, and every term is
// proved again before the first write (preparation) and inside the writer fence
// (compiler). Supported first build, by Sol's plan review (2026-10-30):
//   wholly unpaid service Invoice  -> CreditMemo + zero-funds Payment
//   fully collected service sale   -> RefundReceipt (never also a CreditMemo)
//   wholly unpaid operating Bill   -> VendorCredit + zero-funds BillPayment
//   accountant JournalEntry        -> exact reversing JournalEntry
// Refused before any write: voids, paid bills, bank expenses, partial settlements,
// prior credits or unexpected links, stock/inventory, corrections of corrections,
// records the accountant did not create (imported, adopted or unmanaged), and
// applications that would touch a closed or reconciled period.
const { hash, canonical } = require('./business-calendar');
const QBO_ID = /^\d{1,30}$/, HASH = /^[a-f0-9]{64}$/;
const SERVICES = ['field-service-hour', 'care-plan-1', 'care-plan-2', 'care-plan-3'];
const PARTY = /^(field-client-0(?:0[1-9]|1[0-5])|care-client-0(?:0[1-9]|1[0-9]|2[0-5]))$/;
// A reversal step that exists in any of these states was sent or may have been sent.
const SENT = ['dispatched', 'unknown', 'saved', 'verified'];
const REVERSALS = Object.freeze({ Invoice: ['correction-credit', 'correction-refund'], SalesReceipt: ['correction-refund'], Bill: ['correction-vendor-credit'], JournalEntry: ['correction-journal'] });
// Only a credit reversal cancels the original's own collection or payment. A refund
// returns money already collected, so the original's follow-ups (its deposits) go on.
const CREDIT_REVERSALS = Object.freeze({ Invoice: ['correction-credit'], Bill: ['correction-vendor-credit'] });
const CREDIT_KINDS = ['credit-unpaid-invoice', 'credit-unpaid-bill'];
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_CORRECTION_UNAVAILABLE' }); }
const same = (a, b) => a != null && b != null && String(a) === String(b);
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => same(a?.[key], b?.[key]));
const company = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId });
const name = target => target.entity + ' ' + target.qboId;
function cents(value) { const n = Math.round(Number(value) * 100); if (typeof value !== 'number' || !Number.isSafeInteger(n) || Math.abs(value * 100 - n) > 0.00001) fail('A saved QuickBooks amount is not an exact cent value.'); return n; }
function linkTypes(record) { return [...(record.LinkedTxn || []), ...(record.Line || []).flatMap(line => line.LinkedTxn || [])].map(link => link?.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link?.TxnType); }
// Deterministic identities of a correction's steps: derived from the original only.
function reversalKeys(scope, businessKey, original, stepKeys) {
  const { correctionRuleKey } = require('./business-activity-batch'), ruleKey = correctionRuleKey(original);
  return stepKeys.map(stepKey => hash({ realmId: scope.realmId, environment: scope.environment, businessKey, ruleKey, occurrence: original.txnDate, stepKey }));
}
function allStepKeys(kind) { return require('./business-activity-batch').CORRECTION[kind].steps.map(row => row[0]); }

// The managed step that created this QuickBooks record. Imported (population or
// adopted) and unmanaged records are refused explicitly.
async function originalStep(models, scope, target) {
  // A record that appears in the imported (population or adopted) history is refused
  // outright, even if a managed step also claims it. Ownership of everything else is
  // proved from the managed creation chain (ownershipProblem).
  const Records = models.PopulationRecords || require('../models/BusinessPopulationRecord');
  const imported = await Records.findOne({ environment: scope.environment, realmId: scope.realmId, entity: target.entity, qboId: target.qboId }).select('_id').maxTimeMS(3000).lean();
  if (imported) fail(name(target) + ' came from imported (adopted) history, not from the accountant’s own work; only its own records can be corrected.');
  const rows = await models.Steps.find({ environment: scope.environment, realmId: scope.realmId, entity: target.entity, qboId: target.qboId }).limit(2).maxTimeMS(3000).lean();
  if (!rows.length) fail(name(target) + ' was not created by the accountant’s governed workflows; only its own records can be corrected.');
  if (rows.length !== 1 || !sameScope(rows[0], scope)) fail(name(target) + ' belongs to an earlier connection or is claimed twice; it cannot be corrected.');
  if (rows[0].state !== 'verified') fail(name(target) + ' has not been verified yet; it cannot be corrected.');
  return rows[0];
}

// Server-derived terms. Pure derivation from the original's immutable creation intent
// and approved policy (via the plan store's validated history) plus the current
// QuickBooks balance, which decides between a credit and a refund.
async function deriveCorrection({ models, scope, history, readRecord, target, purpose }) {
  const step = await originalStep(models, scope, target);
  const observed = await history(scope, [step.logicalKey]), entries = observed.entries || [], entry = entries.find(row => row.logicalKey === step.logicalKey);
  if (!entry || entry.entity !== target.entity || entry.qboId !== target.qboId || entry.fingerprint !== step.fingerprint || entry.state !== 'verified' || entries.length > 10) fail(name(target) + ' lost its original creation intent; it cannot be corrected.');
  const d = entry.step.details;
  if (d.correction !== undefined) fail(name(target) + ' is itself a correction. Correcting a correction is not supported.');
  let lifecycle = null;
  try { lifecycle = require('./business-lifecycle-policy').lifecyclePolicy(entry.step); } catch { fail(name(target) + ' has an unsupported original lifecycle.'); }
  const record = await readRecord(target.entity, target.qboId);
  if (!record || record.Id !== target.qboId || record.CurrencyRef?.value !== 'CAD' || record.status === 'Deleted') fail(name(target) + ' could not be read completely from QuickBooks.');
  if (record.TxnDate !== entry.step.txnDate) fail(name(target) + ' changed its date in QuickBooks; it cannot be corrected.');
  const original = { entity: target.entity, qboId: target.qboId, logicalKey: entry.logicalKey, fingerprint: entry.fingerprint, txnDate: entry.step.txnDate, policyHash: hash(entry.policy), compilationHash: step.compilation?.compilationHash };
  const sources = entries.map(row => ({ logicalKey: row.logicalKey, entity: row.entity, txnDate: row.step.txnDate, dependsOn: row.step.dependencies.map(link => link.logicalKey).sort() })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
  const tax = key => {
    const expected = entry.policy?.readbackTax, codeId = entry.policy?.tax?.[key];
    if (!QBO_ID.test(codeId || '') || expected?.version !== 1 || !Array.isArray(expected.lines) || !expected.lines.length) fail(name(target) + ' has no exact approved original tax to repeat.');
    return { codeId, totalTaxCents: expected.totalTaxCents, lines: expected.lines.map(line => ({ rateId: line.rateId, percent: line.percent, taxableCents: line.taxableCents, amountCents: line.amountCents })) };
  };
  const total = target.entity === 'JournalEntry' ? null : cents(record.TotalAmt), balance = target.entity === 'SalesReceipt' || target.entity === 'JournalEntry' ? null : cents(record.Balance);
  let correction;
  if (['Invoice', 'SalesReceipt'].includes(target.entity)) {
    if (d.lines.some(line => /^added-item-/.test(line.itemKey || ''))) fail(name(target) + ' uses a service item the accountant added; corrections support published services only for now.');
    if (!d.lines.every(line => SERVICES.includes(line.itemKey) && ['serviceIncome', 'careIncome'].includes(line.accountMapping))) fail(name(target) + ' includes stock or inventory lines. Inventory corrections are not supported yet.');
    if (!PARTY.test(d.customerKey || '')) fail(name(target) + ' uses a customer the accountant added; corrections support published customers only for now.');
    const kind = target.entity === 'SalesReceipt' || balance === 0 ? 'refund-collected-sale' : balance === total ? 'credit-unpaid-invoice' : null;
    if (!kind) fail(name(target) + ' is partly paid. Partial settlements cannot be corrected yet.');
    correction = { kind, original, sources, customerKey: d.customerKey, lines: d.lines.map(line => ({ key: line.key, itemKey: line.itemKey, quantity: line.quantity, unit: line.unit, unitPriceCents: line.unitPriceCents, amountCents: line.amountCents, accountMapping: line.accountMapping })), tax: tax('salesTax') };
  } else if (target.entity === 'Bill') {
    // An operating-expense bill (an original v1 schedule has no lifecycle contract but
    // the same single nonbillable operating-expense line).
    if (!(lifecycle?.mode === 'operating-expense' || (lifecycle === null && d.lines.length === 1 && d.lines[0].accountMapping === 'operatingExpense' && d.lines[0].itemKey === undefined))) fail(name(target) + ' is a stock or purchase-order bill. Inventory corrections are not supported yet.');
    if (!/^overhead-supplier-[1-3]$/.test(d.vendorKey || '')) fail(name(target) + ' uses a supplier the accountant added; corrections support published suppliers only for now.');
    if (balance === 0) fail(name(target) + ' is already paid. Corrections of paid bills (a supplier refund) are not supported yet.');
    if (balance !== total) fail(name(target) + ' is partly paid. Partial settlements cannot be corrected yet.');
    correction = { kind: 'credit-unpaid-bill', original, sources, vendorKey: d.vendorKey, expenseCategory: d.expenseCategory, lines: d.lines.map(line => ({ key: line.key, accountMapping: line.accountMapping, amountCents: line.amountCents, billableStatus: line.billableStatus })), tax: tax('purchaseTax') };
  } else if (target.entity === 'JournalEntry') {
    if (!['journal-entry'].includes(lifecycle?.mode)) fail(name(target) + ' is not an accountant journal entry.');
    correction = { kind: 'reverse-journal', original, sources, lines: d.lines.map(line => ({ key: line.key, accountMapping: line.accountMapping, postingType: line.postingType === 'Debit' ? 'Credit' : 'Debit', amountCents: line.amountCents })) };
  } else fail('Only invoices, sales receipts, bills and journal entries can be corrected.');
  // Validated with the same exact rules a saved batch is rebuilt with.
  const row = { type: 'correct-own-record', target: { entity: target.entity, qboId: target.qboId }, purpose, correction };
  return { row: require('./business-activity-batch').validateChoices({ decisionKey: 'derive-correction', purpose: 'Derive the exact terms of one correction of an own record.', activities: [row] }).activities[0], step, entry, record };
}

// The step's full creation chain, adapted from the added-role proof
// (business-added-roles.js) for transactions: compilation and dispatch for this
// company, a receipt rebuilt from its transport row and audits (or the owner's
// attribution), its current verification and audit, and the creating operation's
// committed period evidence (business-stock-history committedReceipt) containing this
// exact creation with its original verification audit. A later operation may have
// re-verified the record, so the current audit may name a later operation.
async function verifyAudit(models, scope, ownerId, auditId, step, operationId) {
  const audit = await models.Audits.findOne({ _id: auditId, realmId: scope.realmId }).maxTimeMS(3000).lean(), params = audit?.inputParams, details = params?.details;
  return Boolean(audit && String(audit.userId) === String(ownerId) && audit.action === 'Business operation evidence recorded' && audit.outcome === 'success' && sameScope(params, scope) && sameScope(details, scope) && (operationId === null || same(details.operationId, operationId)) && details.logicalKey === step.logicalKey && details.phase === 'verify' && details.qboId === step.qboId && details.dispatchKey === step.dispatch?.key);
}
async function ownershipProblem(models, scope, ownerId, step, cache = new Map()) {
  scope = company(scope);
  const c = step.compilation, d = step.dispatch, r = step.receipt, v = step.verification;
  let request;
  try { request = require('./business-readback').validateCompilation(c); } catch { return 'its saved creation request is invalid'; }
  if (!sameScope(request.scope, scope) || c.entity !== step.entity || c.logicalKey !== step.logicalKey || c.intentHash !== step.fingerprint || !d || c.compilationHash !== d.compilationHash || c.evidenceHash !== d.evidenceHash || request.requestHash !== d.requestHash) return 'its creation request does not match its dispatch for this company';
  if (!r || r.version !== 1 || !HASH.test(d.key || '') || r.dispatchKey !== d.key || r.requestHash !== d.requestHash || r.qboId !== step.qboId || !QBO_ID.test(step.qboId || '') || !HASH.test(r.evidenceHash || '')) return 'its creation receipt does not match its dispatch';
  if (step.state !== 'verified' || !v || v.kind !== 'business-readback' || v.compilationHash !== d.compilationHash || !HASH.test(v.observedHash || '') || !HASH.test(v.evidenceHash || '') || !step.lastAuditId) return 'its read-back verification proof is missing';
  if (await require('./business-added-roles').receiptProblem(models, scope, step)) return 'its creation receipt or transport audit is missing or changed';
  if (!await verifyAudit(models, scope, ownerId, step.lastAuditId, step, null)) return 'its verification audit record is missing or differs';
  const operationId = String(step.operationId);
  if (!cache.has(operationId)) {
    let value;
    try {
      const run = await models.Runs.findOne({ ...scope, _id: operationId }).maxTimeMS(3000).lean();
      if (!run || run.planHash !== step.planHash || run.status !== 'verified') value = { problem: 'its creating operation has not verified' };
      else { const committed = await require('./business-stock-history').committedReceipt(models, scope, String(ownerId), operationId, null); value = { records: new Map(committed.evidence.proof.records.map(row => [row?.logicalKey, row])) }; }
    } catch { value = { problem: 'its operation completion evidence is missing or changed' }; }
    cache.set(operationId, value);
  }
  const completion = cache.get(operationId);
  if (completion.problem) return completion.problem;
  const record = completion.records.get(step.logicalKey);
  if (!record || record.entity !== step.entity || record.qboId !== step.qboId || record.fingerprint !== step.fingerprint || record.state !== 'verified') return 'its operation evidence does not include this record';
  if (!await verifyAudit(models, scope, ownerId, record.auditId, step, operationId)) return 'its original verification audit is missing or differs';
  return null;
}

// A collected invoice is refunded only when the accountant's own verified cash
// payments for it, and nothing else, collected exactly its total. An outside payment
// or a credit-funded application is refused: the refund would return money the
// accountant never received. Every payment is read fresh from QuickBooks.
async function assertOwnCollection({ models, scope, original, record, readRecord, label }) {
  if (typeof readRecord !== 'function') fail(label + ' cannot be refunded: its payments could not be read.');
  const links = [...(record.LinkedTxn || []), ...(record.Line || []).flatMap(line => line.LinkedTxn || [])];
  const ids = [...new Set(links.filter(link => link?.TxnType === 'Payment').map(link => String(link.TxnId)))];
  if (!ids.length || ids.length > 10 || ids.some(id => !QBO_ID.test(id))) fail(label + ' is not collected by the accountant’s own payments; it cannot be refunded.');
  const steps = await models.Steps.find({ environment: scope.environment, realmId: scope.realmId, entity: 'Payment', qboId: { $in: ids } }).select('qboId state environment realmId connectionId dependencies').limit(21).maxTimeMS(3000).lean();
  let collected = 0;
  for (const id of ids) {
    const own = steps.filter(row => row.qboId === id);
    if (own.length !== 1 || !sameScope(own[0], scope) || own[0].state !== 'verified' || !(own[0].dependencies || []).some(link => link?.logicalKey === original.logicalKey)) fail(label + ' has payment ' + id + ', which the accountant did not record for this sale. Only sales collected entirely by its own verified payments can be refunded.');
    const payment = await readRecord('Payment', id), lines = Array.isArray(payment?.Line) ? payment.Line : [];
    const cash = Boolean(payment) && payment.Id === id && payment.CurrencyRef?.value === 'CAD' && QBO_ID.test(payment.DepositToAccountRef?.value || '') && lines.length > 0
      && lines.every(line => Array.isArray(line.LinkedTxn) && line.LinkedTxn.length === 1 && line.LinkedTxn[0]?.TxnType === 'Invoice' && String(line.LinkedTxn[0].TxnId) === record.Id)
      && (payment.LinkedTxn || []).every(link => link?.TxnType === 'Deposit') && (payment.UnappliedAmt === undefined || cents(payment.UnappliedAmt) === 0);
    const applied = cash ? lines.reduce((sum, line) => sum + cents(line.Amount), 0) : 0;
    if (!cash || applied <= 0 || cents(payment.TotalAmt) !== applied) fail(label + ' was settled by payment ' + id + ' with a credit, another invoice or no money received; it cannot be refunded.');
    collected += applied;
  }
  if (collected !== cents(record.TotalAmt) || cents(record.Balance) !== 0) fail(label + ' was not collected exactly by the accountant’s own payments; it cannot be refunded.');
}
// Everything that must hold before the first write. Throws with a plain reason.
async function assertEligible({ models, scope, ownerId, businessKey, derived, day, cutoff, setup, ownership, readRecord }) {
  const { row, step, record } = derived, c = row.correction, original = c.original, label = name(row.target);
  if (original.txnDate >= day) fail(label + ' is from today. Correct it tomorrow, after today’s history is verified.');
  if (!HASH.test(original.compilationHash || '')) fail(label + ' lost its original compilation.');
  const problem = await ownershipProblem(models, scope, ownerId, step, ownership);
  if (problem) fail(label + ' cannot be corrected: ' + problem + '.');
  // One correction per original, ever: any earlier attempt (any decision key, any
  // outcome, including unknown) or another unsent prepared batch reserves it.
  const keys = reversalKeys(scope, businessKey, original, REVERSALS[original.entity] ? [...new Set([...REVERSALS[original.entity], ...allStepKeys(c.kind)])] : allStepKeys(c.kind));
  const attempted = await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, logicalKey: { $in: keys } }).select('state operationId').maxTimeMS(3000).lean();
  if (attempted) fail(label + ' already has a correction (' + attempted.state + ' in operation ' + attempted.operationId + '). Each record can be corrected once.');
  const open = await models.Runs.find({ ...company(scope), status: { $nin: ['verified', 'retired'] } }).select('planId status').limit(50).maxTimeMS(3000).lean();
  for (const run of open) {
    if (await models.Intents.findOne({ ...company(scope), planId: run.planId, logicalKey: { $in: keys } }).select('_id').maxTimeMS(3000).lean()) fail(label + ' is already being corrected by prepared operation ' + run._id + ' (' + run.status + '). Run or retire it first.');
    const planned = await models.Intents.findOne({ ...company(scope), planId: run.planId, kind: 'create', 'step.dependencies.logicalKey': original.logicalKey }).select('logicalKey').maxTimeMS(3000).lean();
    if (planned && !await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, logicalKey: planned.logicalKey }).select('_id').maxTimeMS(3000).lean()) fail(label + ' still has follow-up work planned in prepared operation ' + run._id + '. Run or retire it first.');
  }
  // Managed records that already depend on the original (its payments, credits…).
  const dependents = await models.Steps.find({ environment: scope.environment, realmId: scope.realmId, 'dependencies.logicalKey': original.logicalKey }).select('entity state').limit(21).maxTimeMS(3000).lean();
  if (c.kind === 'refund-collected-sale' ? dependents.some(row => row.entity !== 'Payment' || row.state !== 'verified') : dependents.length) fail(label + (c.kind === 'refund-collected-sale' ? ' has follow-up records other than its own verified payments.' : ' already has payments, credits or other follow-up records.'));
  // Fresh content: party, lines and the exact original tax must still be on the record.
  const linked = linkTypes(record), sale = c.kind !== 'credit-unpaid-bill' && c.kind !== 'reverse-journal';
  if (c.kind === 'credit-unpaid-invoice' && linked.some(type => !['Estimate', 'TimeActivity'].includes(type))) fail(label + ' already has a payment, credit or other link.');
  if (c.kind === 'credit-unpaid-bill' && linked.length) fail(label + ' already has a payment, credit or other link.');
  if (c.kind === 'refund-collected-sale' && (record.Balance !== undefined && cents(record.Balance) !== 0 || linked.some(type => !['Estimate', 'TimeActivity', 'Payment'].includes(type)))) fail(label + ' has a credit or other link besides its own payments.');
  if (c.kind === 'refund-collected-sale' && original.entity === 'Invoice') await assertOwnCollection({ models, scope, original, record, readRecord, label });
  if (c.tax) {
    if (record.GlobalTaxCalculation !== 'TaxExcluded' || !require('./business-transaction-compiler').originalTaxMatches(record, c.tax) || cents(record.TotalAmt) !== c.lines.reduce((sum, line) => sum + line.amountCents, 0) + c.tax.totalTaxCents) fail(label + ' no longer shows its original approved tax and total.');
    const code = setup.options.taxCodes.find(value => value.id === c.tax.codeId), direction = sale ? 'sales' : 'purchases';
    if (!setup.completeness.taxCodes || code?.active !== true || (code[direction] !== true && code.taxable !== false)) fail(label + ' used tax code ' + c.tax.codeId + ', which is no longer active for ' + direction + '. The original tax cannot be repeated, so it cannot be corrected.');
  }
  // An application changes the original's balance and links. Preserve protection:
  // refuse rather than touch a closed or reconciled period.
  if (['credit-unpaid-invoice', 'credit-unpaid-bill'].includes(c.kind) && cutoff && c.sources.some(source => source.txnDate <= cutoff)) fail(label + ' (dated ' + original.txnDate + ') is inside a closed or reconciled period through ' + cutoff + '. Applying a reversal to it would change protected history, so it cannot be corrected.');
}

// Preparation: the agent sent target + reason; derive every term from the original.
async function expandCorrections({ choices, ...input }) {
  const activities = [];
  for (const row of choices.activities) {
    if (row.type !== 'correct-own-record') { activities.push(row); continue; }
    const derived = await deriveCorrection({ ...input, target: row.target, purpose: row.purpose });
    if (row.correction !== undefined && canonical(row.correction) !== canonical(derived.row.correction)) fail('The supplied correction terms differ from the original record. Send only the target and a reason; the server derives the rest.');
    activities.push(derived.row);
  }
  return { ...choices, activities };
}
// Before a correction batch is saved: re-derive every term (the saved terms must be
// exactly what the original yields now) and prove eligibility.
async function assertCorrectionsEligible({ models, scope, ownerId, businessKey, batch, history, readRecord, cutoff, setup }) {
  const ownership = new Map();
  for (const row of batch.activities.filter(value => value.type === 'correct-own-record')) {
    const derived = await deriveCorrection({ models, scope, history, readRecord, target: row.target, purpose: row.purpose });
    if (canonical(derived.row.correction) !== canonical(row.correction)) fail('The correction of ' + name(row.target) + ' no longer matches its original record. Prepare it again.');
    await assertEligible({ models, scope, ownerId, businessKey, derived, day: batch.day, cutoff, setup, ownership, readRecord });
  }
}
// Activity choices: recent own records with their correction eligibility.
async function correctableRecords({ models, scope, ownerId, businessKey, history, readRecord, day, cutoff, setup, limit = 15, signal }) {
  const steps = await models.Steps.find({ ...company(scope), entity: { $in: require('./business-activity-batch').CORRECTION_TARGETS }, state: 'verified' }).select('entity qboId').sort({ _id: -1 }).limit(limit).maxTimeMS(3000).lean();
  const rows = [], ownership = new Map();
  for (const step of steps) {
    if (signal?.aborted) fail('Correction choices were cancelled.');
    const target = { entity: step.entity, qboId: step.qboId };
    try {
      const derived = await deriveCorrection({ models, scope, history, readRecord, target, purpose: 'List the correction choices for own records.' });
      await assertEligible({ models, scope, ownerId, businessKey, derived, day, cutoff, setup, ownership, readRecord });
      const c = derived.row.correction, base = c.lines.reduce((sum, line) => sum + (line.postingType === 'Credit' ? 0 : line.amountCents), 0);
      rows.push({ target, txnDate: c.original.txnDate, docNumber: derived.record.DocNumber || null, kind: c.kind, eligible: true, totalCents: base + (c.tax?.totalTaxCents || 0), ...(c.tax ? { originalTaxPercent: c.tax.lines.map(line => line.percent) } : {}) });
    } catch (error) {
      if (signal?.aborted) throw error;
      // A listing degrades per record; preparation re-checks everything and fails loudly.
      rows.push({ target, eligible: false, reason: /^BUSINESS_/.test(error.code || '') ? error.message : 'Its correction eligibility could not be checked.' });
    }
  }
  return rows;
}
// Calendar preparation: scheduled follow-ups (collections, payments, credits) of an
// original whose CREDIT reversal was sent are not created (a refund suppresses
// nothing: the money was collected, so its deposit still runs). Derived from durable step
// evidence each time, so no saved plan is rewritten. A follow-up chain stops at a
// record that already exists (for example a payment's later deposit still runs).
async function suppressCorrectedFollowUps({ models, scope, businessKey, prepared }) {
  const current = new Set(prepared.steps.map(step => step.logicalKey)), earlier = new Map(prepared.earlierRequirements.map(row => [row.logicalKey, row]));
  const candidates = new Map();
  for (const step of prepared.steps) for (const link of step.dependencies) {
    const source = earlier.get(link.logicalKey);
    if (!current.has(link.logicalKey) && source && CREDIT_REVERSALS[source.entity] && !candidates.has(link.logicalKey)) candidates.set(link.logicalKey, reversalKeys(scope, businessKey, { logicalKey: source.logicalKey, txnDate: source.txnDate }, CREDIT_REVERSALS[source.entity]));
  }
  if (!candidates.size) return prepared;
  if (candidates.size > 500) fail('Correction follow-up checks exceed their bounded history.');
  const keys = [...candidates.values()].flat(), sent = new Set();
  for (let offset = 0; offset < keys.length; offset += 200) for (const row of await models.Steps.find({ environment: scope.environment, realmId: scope.realmId, logicalKey: { $in: keys.slice(offset, offset + 200) }, state: { $in: SENT } }).select('logicalKey').limit(201).maxTimeMS(3000).lean()) sent.add(row.logicalKey);
  const corrected = new Set([...candidates].filter(([, values]) => values.some(key => sent.has(key))).map(([key]) => key));
  if (!corrected.size) return prepared;
  const excluded = new Set();
  for (let changed = true; changed;) { changed = false; for (const step of prepared.steps) if (!excluded.has(step.logicalKey) && step.dependencies.some(link => corrected.has(link.logicalKey) || excluded.has(link.logicalKey))) { excluded.add(step.logicalKey); changed = true; } }
  if (!excluded.size) return prepared;
  prepared.steps = prepared.steps.filter(step => !excluded.has(step.logicalKey));
  const needed = new Set(prepared.steps.flatMap(step => step.dependencies.map(link => link.logicalKey)));
  prepared.earlierRequirements = prepared.earlierRequirements.filter(row => !corrected.has(row.logicalKey) || needed.has(row.logicalKey));
  prepared.correctedFollowUps = { version: 1, originals: [...corrected].sort(), excluded: [...excluded].sort() };
  prepared.limitations = [...(prepared.limitations || []), excluded.size + ' scheduled follow-ups of ' + corrected.size + ' corrected record(s) were not prepared: the accountant reversed the original, so it is no longer collected or paid.'];
  return prepared;
}
// Immediately before each write of a saved correction batch: no other operation holds
// any of its reversal identities (the unique step identity also refuses a duplicate).
// Until this operation has sent a correction's first step, what preparation proved and
// the app does not control is proved again: no source of a credit correction is in an
// owner-recorded closed or reconciled period, and a refunded invoice is still
// collected exactly by the accountant's own cash payments (read fresh through
// readRecord). The write gate separately refuses the credit itself while the earliest
// date across the original and its source records (bound into the credit's
// compilation) is protected by the same fresh combined cutoff it uses for every write,
// including QuickBooks' own closing date, so no credit is left open when its
// zero-funds application would be refused.
async function assertCorrectionsDispatchable(models, scope, manifest, operationId, readRecord) {
  const batch = manifest.activityBatch, corrections = (batch?.activities || []).filter(row => row.type === 'correct-own-record');
  if (!corrections.length) return;
  require('./business-activity-batch').buildBatchActivity(batch, company(scope), manifest.businessKey);
  // Every reversal identity of each original (credit, refund…), not only this kind's.
  const keys = corrections.flatMap(row => reversalKeys(scope, manifest.businessKey, row.correction.original, [...new Set([...(REVERSALS[row.correction.original.entity] || []), ...allStepKeys(row.correction.kind)])]));
  const other = await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, logicalKey: { $in: keys }, operationId: { $ne: operationId } }).select('operationId state').maxTimeMS(3000).lean();
  if (other) fail('Another operation (' + other.operationId + ', ' + other.state + ') already corrected this record. Nothing was sent; retire this batch.');
  let cutoff;
  for (const row of corrections) {
    const c = row.correction, original = c.original, label = name(row.target);
    const own = reversalKeys(scope, manifest.businessKey, original, allStepKeys(c.kind));
    if (await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, operationId, logicalKey: { $in: own }, state: { $in: SENT } }).select('_id').maxTimeMS(3000).lean()) continue;
    if (CREDIT_KINDS.includes(c.kind)) {
      if (cutoff === undefined) { const control = (await models.Policies.findOne({ environment: scope.environment, realmId: scope.realmId }).select('periodControl').maxTimeMS(3000).lean())?.periodControl; cutoff = [control?.closedThrough, control?.reconciledThrough].filter(Boolean).sort().at(-1) || null; }
      if (cutoff && c.sources.some(source => source.txnDate <= cutoff)) fail(label + ' (dated ' + original.txnDate + ') or one of its source records is now inside a closed or reconciled period through ' + cutoff + '. Its reversal was not sent; retire this batch.');
    }
    if (c.kind === 'refund-collected-sale' && original.entity === 'Invoice') {
      if (typeof readRecord !== 'function') fail(label + ' cannot be refunded: its payments could not be read.');
      const record = await readRecord('Invoice', original.qboId);
      if (!record || record.Id !== original.qboId || record.TxnDate !== original.txnDate) fail(label + ' could not be read completely from QuickBooks; nothing was refunded.');
      await assertOwnCollection({ models, scope, original, record, readRecord, label });
    }
  }
}
module.exports = { deriveCorrection, ownershipProblem, assertEligible, expandCorrections, assertCorrectionsEligible, correctableRecords, suppressCorrectedFollowUps, assertCorrectionsDispatchable, reversalKeys, REVERSALS };
