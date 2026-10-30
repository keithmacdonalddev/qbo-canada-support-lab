'use strict';
// Activity policy v7 end to end: the accountant corrects its own records as governed
// same-day activity on the simulated company (no live QuickBooks).
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { fixture } = require('./helpers/business-governance-fixture');
const { reversalKeys } = require('../src/modules/business-correction');
const config = require('../src/config'); const previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, DAY = 86400000;
async function calendar(h, throughDate, key) { const p = await h.service.prepare(h.user, { requestKey: key, throughDate }); await h.service.approve(h.user, p.operationId, { planHash: p.planHash }); const result = await h.runtime(p.operationId).execute(); assert.equal(result.complete, true, JSON.stringify(result)); return p; }
async function run(h, prepared) { await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash }); return h.runtime(prepared.operationId).execute(); }
const correct = (decisionKey, target, purpose = 'The original was raised by mistake and is reversed in full.') => ({ decisionKey, purpose: 'Correct an earlier record the accountant raised by mistake.', activities: [{ type: 'correct-own-record', target, purpose }] });
const own = (h, entity) => h.data.Steps.filter(row => row.entity === entity && row.state === 'verified').map(step => ({ step, record: h.records.get(entity.toLowerCase() + ':' + step.qboId).record }));
const current = (h, entity, id) => h.records.get(entity.toLowerCase() + ':' + id).record;
const created = (h, entity) => [...h.records.values()].filter(row => row.entity === entity).map(row => row.record);
const linksTo = (record, entity, id) => (record.Line || []).some(line => (line.LinkedTxn || []).some(link => link.TxnType === entity && link.TxnId === id));
const unpaidCareInvoice = h => own(h, 'Invoice').filter(({ record }) => record.Balance === record.TotalAmt && !(record.LinkedTxn || []).length).sort((a, b) => a.record.TxnDate.localeCompare(b.record.TxnDate))[0];
const collectedCareInvoice = h => own(h, 'Invoice').find(({ record }) => record.Balance === 0 && (record.LinkedTxn || []).length && record.LinkedTxn.every(link => link.TxnType === 'Payment'));
const allLinks = record => [...(record.LinkedTxn || []), ...(record.Line || []).flatMap(line => line.LinkedTxn || [])];
// An unpaid field invoice whose estimate or time entry is dated before the invoice itself.
const unpaidFieldInvoice = h => own(h, 'Invoice').map(row => ({ ...row, sources: allLinks(row.record).filter(link => ['Estimate', 'TimeActivity'].includes(link.TxnType)).map(link => current(h, link.TxnType, link.TxnId)) })).filter(({ record, sources }) => record.Balance === record.TotalAmt && sources.length && allLinks(record).every(link => ['Estimate', 'TimeActivity'].includes(link.TxnType)) && sources.some(source => source.TxnDate < record.TxnDate)).sort((a, b) => a.record.TxnDate.localeCompare(b.record.TxnDate))[0];
const unpaidOperatingBill = h => own(h, 'Bill').find(({ record }) => record.Balance === record.TotalAmt && record.Line.every(line => line.DetailType === 'AccountBasedExpenseLineDetail'));
const target = row => ({ entity: row.step.entity, qboId: row.step.qboId });
const evidenceOf = (h, step) => structuredClone(h.data.Evidence.filter(row => String(row.operationId) === String(step.operationId)));
const outcomeText = (h, operationId, outcome) => JSON.stringify(outcome) + String(h.data.Runs.find(row => String(row._id) === operationId)?.lastError || '');
async function november(options = {}) { const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01', ...options }); await h.publish(); await calendar(h, '2026-11-30', 'correction-november-' + Object.keys(options).join('-')); return h; }

test('a wholly unpaid invoice is credited in full, the credit applied, and its scheduled collection never created', { timeout: 300000 }, async () => {
  const h = await november(), original = unpaidCareInvoice(h); assert.ok(original, 'an unpaid care invoice');
  const invoice = structuredClone(original.record), before = evidenceOf(h, original.step);
  const listed = (await h.service.activityOptions(h.user)).correctableRecords;
  assert.ok(listed.length && listed.some(row => row.eligible));
  for (const row of listed) assert.ok(row.eligible ? row.kind && row.totalCents > 0 : row.reason.length > 10, JSON.stringify(row));
  const posts = h.posts, prepared = await h.service.prepareActivityBatch(h.user, correct('correct-invoice-001', target(original)));
  // A lost-response retry returns the saved plan; another decision key is refused.
  assert.equal((await h.service.prepareActivityBatch(h.user, correct('correct-invoice-001', target(original)))).reused, true);
  await assert.rejects(h.service.prepareActivityBatch(h.user, correct('correct-invoice-002', target(original))), /already being corrected/);
  assert.equal(h.posts, posts);
  const result = await run(h, prepared); assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(h.posts, posts + 2);
  const memo = created(h, 'CreditMemo').find(row => row.TxnDate === '2026-12-01'), application = created(h, 'Payment').find(row => linksTo(row, 'CreditMemo', memo.Id));
  assert.equal(memo.TotalAmt, invoice.TotalAmt); assert.equal(memo.CustomerRef.value, invoice.CustomerRef.value); assert.deepEqual(memo.TxnTaxDetail, invoice.TxnTaxDetail);
  assert.deepEqual(memo.Line.filter(line => line.DetailType === 'SalesItemLineDetail').map(line => [line.SalesItemLineDetail.ItemRef.value, line.Amount]), invoice.Line.filter(line => line.DetailType === 'SalesItemLineDetail').map(line => [line.SalesItemLineDetail.ItemRef.value, line.Amount]));
  assert.match(memo.PrivateNote, new RegExp('correction of Invoice ' + invoice.Id + ' dated ' + invoice.TxnDate));
  assert.equal(application.TotalAmt, 0); assert.ok(linksTo(application, 'Invoice', invoice.Id));
  assert.equal(current(h, 'Invoice', invoice.Id).Balance, 0); assert.equal(current(h, 'CreditMemo', memo.Id).RemainingCredit, 0);
  const memoStep = h.data.Steps.find(row => row.entity === 'CreditMemo' && row.qboId === memo.Id), admitted = h.data.Receipts.find(row => row.entity === 'creditmemo' && row.logicalKey === memoStep.logicalKey).periodProof.businessCreditSource;
  assert.equal(memoStep.compilation.relationships[0].earliestSourceTxnDate, invoice.TxnDate); assert.equal(admitted.earliestSourceTxnDate, invoice.TxnDate); assert.equal(admitted.sourceTxnDate, invoice.TxnDate);
  // The original's committed evidence is untouched.
  assert.deepEqual(evidenceOf(h, original.step), before);
  // Retry after success returns the same operation; any later correction is refused for good.
  assert.equal((await h.service.prepareActivityBatch(h.user, correct('correct-invoice-001', target(original)))).operationId, prepared.operationId);
  await assert.rejects(h.service.prepareActivityBatch(h.user, correct('correct-invoice-003', target(original))), /already has a correction/);
  // Same-day work continues, the day closes, and the scheduled collection is suppressed.
  const sale = await h.service.prepareActivityBatch(h.user, { decisionKey: 'after-correction-sale', purpose: 'Sell a monthly care plan to a returning client today.', activities: [{ type: 'settled-service-sale', customerKey: 'care-client-002', itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 1000, purpose: 'Monthly care plan.' }] });
  assert.equal((await run(h, sale)).complete, true);
  await calendar(h, '2026-12-01', 'correction-close-december-first');
  h.clock += 15 * DAY; await calendar(h, '2026-12-16', 'correction-december-second-half');
  assert.equal(h.data.Calendars[0].verifiedThrough, '2026-12-16');
  assert.deepEqual(created(h, 'Payment').filter(row => linksTo(row, 'Invoice', invoice.Id)).map(row => row.TotalAmt), [0]);
  const plan = h.data.Plans.find(row => row.manifest.correctedFollowUps?.originals.includes(original.step.logicalKey));
  assert.ok(plan, 'a later period excluded the corrected invoice follow-up'); assert.ok(plan.manifest.correctedFollowUps.excluded.length >= 1);
});

test('a fully collected sale is refunded once (never also credited); the original stays unchanged', { timeout: 300000 }, async () => {
  const h = await november(), original = collectedCareInvoice(h); assert.ok(original, 'a collected care invoice');
  const invoice = structuredClone(original.record), posts = h.posts, memos = created(h, 'CreditMemo').length;
  const result = await run(h, await h.service.prepareActivityBatch(h.user, correct('refund-invoice-001', target(original))));
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(h.posts, posts + 1);
  const [refund] = created(h, 'RefundReceipt');
  assert.equal(refund.TotalAmt, invoice.TotalAmt); assert.deepEqual(refund.TxnTaxDetail, invoice.TxnTaxDetail); assert.equal(refund.DepositToAccountRef.value, h.mappings.operatingBank); assert.equal(refund.CustomerRef.value, invoice.CustomerRef.value);
  assert.equal(created(h, 'CreditMemo').length, memos); assert.deepEqual(current(h, 'Invoice', invoice.Id), invoice);
  await assert.rejects(h.service.prepareActivityBatch(h.user, correct('refund-invoice-002', target(original))), /already has a correction/);
  await calendar(h, '2026-12-01', 'refund-close-december-first');
  // A refund returns collected money; it never suppresses the original's follow-ups.
  assert.ok(!h.data.Plans.some(row => row.manifest.correctedFollowUps?.originals.includes(original.step.logicalKey)));
});

test('a refund needs the sale collected exactly by the accountant’s own cash payments; imported originals are refused', { timeout: 300000 }, async () => {
  const h = await november(), posts = h.posts, refuse = (value, pattern, key) => assert.rejects(h.service.prepareActivityBatch(h.user, correct(key, value)), pattern);
  // An outside payment (no managed step) collected an otherwise unpaid invoice.
  const unpaid = unpaidCareInvoice(h), invoice = current(h, 'Invoice', unpaid.step.qboId), outsideId = String(++h.sequence);
  h.records.set('payment:' + outsideId, { entity: 'Payment', record: { Id: outsideId, SyncToken: '0', TxnDate: invoice.TxnDate, CurrencyRef: { value: 'CAD' }, CustomerRef: { ...invoice.CustomerRef }, ARAccountRef: { ...invoice.ARAccountRef }, DepositToAccountRef: { value: h.mappings.operatingBank }, TotalAmt: invoice.TotalAmt, UnappliedAmt: 0, Line: [{ Amount: invoice.TotalAmt, LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }] }] } });
  const balance = invoice.Balance; invoice.Balance = 0; invoice.LinkedTxn = [{ TxnId: outsideId, TxnType: 'Payment' }];
  await refuse(target(unpaid), /did not record for this sale/, 'refuse-outside-payment');
  invoice.Balance = balance; delete invoice.LinkedTxn; h.records.delete('payment:' + outsideId);
  // An own record that also appears in imported history is refused outright.
  h.data.PopulationRecords.push({ _id: 'p'.repeat(24), ...scope, entity: 'Invoice', qboId: unpaid.step.qboId, state: 'saved' });
  await refuse(target(unpaid), /imported \(adopted\) history/, 'refuse-also-imported');
  h.data.PopulationRecords.pop();
  // A credit-funded application on the accountant's own payment: refused at preparation…
  const collected = collectedCareInvoice(h), paymentId = current(h, 'Invoice', collected.step.qboId).LinkedTxn.find(link => link.TxnType === 'Payment').TxnId, payment = current(h, 'Payment', paymentId);
  const lines = structuredClone(payment.Line), creditFunded = () => { payment.Line = [...structuredClone(lines), { Amount: 0, LinkedTxn: [{ TxnId: '999999', TxnType: 'CreditMemo' }] }]; };
  creditFunded(); await refuse(target(collected), /with a credit, another invoice or no money received/, 'refuse-credit-funded'); payment.Line = structuredClone(lines);
  // …and again immediately before the refund is sent.
  const prepared = await h.service.prepareActivityBatch(h.user, correct('refund-then-credit-001', target(collected)));
  await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  creditFunded();
  const outcome = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(outcome.complete, true, JSON.stringify(outcome)); assert.match(outcomeText(h, prepared.operationId, outcome), /cannot be refunded/);
  payment.Line = structuredClone(lines);
  assert.equal(h.posts, posts); assert.equal(created(h, 'RefundReceipt').length, 0);
});

test('zero-funds applications verify from their exact pair when QuickBooks omits the control and bank accounts', { timeout: 300000 }, async () => {
  const h = await november({ omitZeroApplicationAccount: true, omitZeroBillPaymentBank: true }), invoice = unpaidCareInvoice(h), bill = unpaidOperatingBill(h), posts = h.posts;
  assert.ok(invoice && bill, 'an unpaid care invoice and operating bill');
  const choices = { decisionKey: 'correct-omitted-001', purpose: 'Correct an earlier invoice and bill the accountant raised by mistake.', activities: [correct('x', target(invoice)).activities[0], correct('y', target(bill)).activities[0]] };
  const result = await run(h, await h.service.prepareActivityBatch(h.user, choices));
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(h.posts, posts + 4);
  const payment = created(h, 'Payment').find(row => row.TotalAmt === 0 && linksTo(row, 'Invoice', invoice.step.qboId)), billPayment = created(h, 'BillPayment').find(row => row.TotalAmt === 0 && linksTo(row, 'Bill', bill.step.qboId));
  assert.ok(payment && billPayment, 'both zero-funds applications were saved');
  // Every QuickBooks read omits the fields, yet both applications verified.
  const readPayment = (await h.client.read('payment', payment.Id)).Payment, readBillPayment = (await h.client.read('billpayment', billPayment.Id)).BillPayment;
  assert.equal(readPayment.ARAccountRef, undefined); assert.equal(readBillPayment.APAccountRef, undefined); assert.equal(readBillPayment.CheckPayment.BankAccountRef, undefined);
  for (const [entity, record] of [['Payment', payment], ['BillPayment', billPayment]]) assert.equal(h.data.Steps.find(row => row.entity === entity && row.qboId === record.Id).state, 'verified');
  // The day still closes over the same omitted shapes.
  await calendar(h, '2026-12-01', 'omitted-close-december-first');
});

test('a period closed after preparation refuses the supplier credit before any write', { timeout: 300000 }, async () => {
  const h = await november(), original = unpaidOperatingBill(h), credits = created(h, 'VendorCredit').length;
  const prepared = await h.service.prepareActivityBatch(h.user, correct('credit-bill-closed-001', target(original)));
  await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  // QuickBooks' own closing date moves past the original bill after preparation.
  h.closedThrough = original.record.TxnDate;
  const posts = h.posts, outcome = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(outcome.complete, true, JSON.stringify(outcome)); assert.match(outcomeText(h, prepared.operationId, outcome), /closed or reconciled period/);
  assert.equal(h.posts, posts); assert.equal(created(h, 'VendorCredit').length, credits);
  assert.equal(created(h, 'BillPayment').filter(row => linksTo(row, 'Bill', original.step.qboId)).length, 0);
});

test('a closing date moved onto an invoice source record after preparation refuses the customer credit before any write', { timeout: 300000 }, async () => {
  const h = await november(), original = unpaidFieldInvoice(h); assert.ok(original, 'an unpaid field invoice with an earlier estimate or time entry');
  const earliest = original.sources.map(source => source.TxnDate).sort()[0], credits = created(h, 'CreditMemo').length;
  assert.ok(earliest < original.record.TxnDate);
  const prepared = await h.service.prepareActivityBatch(h.user, correct('credit-field-closed-001', target(original)));
  await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  // QuickBooks' own closing date moves onto the earliest source record, still before the
  // invoice: the credit alone would pass, but its zero-funds application would be refused.
  h.closedThrough = earliest;
  const posts = h.posts, outcome = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(outcome.complete, true, JSON.stringify(outcome)); assert.match(outcomeText(h, prepared.operationId, outcome), /estimate or time entry\), is in a closed or reconciled period/);
  assert.equal(h.posts, posts); assert.equal(created(h, 'CreditMemo').length, credits);
  assert.equal(created(h, 'Payment').filter(row => linksTo(row, 'Invoice', original.step.qboId)).length, 0);
});

test('a wholly unpaid operating bill gets a full supplier credit applied; its scheduled payment is suppressed at day close', { timeout: 300000 }, async () => {
  const h = await november(), original = unpaidOperatingBill(h); assert.ok(original, 'an unpaid operating bill');
  const bill = structuredClone(original.record), posts = h.posts;
  const result = await run(h, await h.service.prepareActivityBatch(h.user, correct('credit-bill-001', target(original))));
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(h.posts, posts + 2);
  const [credit] = created(h, 'VendorCredit'), application = created(h, 'BillPayment').find(row => linksTo(row, 'VendorCredit', credit.Id));
  assert.equal(credit.TotalAmt, bill.TotalAmt); assert.equal(credit.VendorRef.value, bill.VendorRef.value); assert.deepEqual(credit.TxnTaxDetail, bill.TxnTaxDetail);
  assert.equal(application.TotalAmt, 0); assert.ok(linksTo(application, 'Bill', bill.Id));
  assert.equal(current(h, 'Bill', bill.Id).Balance, 0); assert.equal(current(h, 'VendorCredit', credit.Id).Balance, 0);
  await calendar(h, '2026-12-01', 'bill-credit-close-december-first');
  assert.deepEqual(created(h, 'BillPayment').filter(row => linksTo(row, 'Bill', bill.Id)).map(row => row.TotalAmt), [0]);
  assert.ok(h.data.Plans.some(row => row.manifest.correctedFollowUps?.originals.includes(original.step.logicalKey)));
});

test('a journal entry is reversed exactly the next day', { timeout: 300000 }, async () => {
  const h = await november(), posts = h.posts;
  const journal = await run(h, await h.service.prepareActivityBatch(h.user, { decisionKey: 'journal-to-correct-001', purpose: 'Reclassify a care-plan amount recorded as an expense refund.', activities: [{ type: 'journal-entry', lines: [{ accountKey: 'operatingExpense', postingType: 'Debit', amountCents: 3000 }, { accountKey: 'careIncome', postingType: 'Credit', amountCents: 3000 }], purpose: 'Reclassify a care-plan credit recorded as an expense refund.' }] }));
  assert.equal(journal.complete, true, JSON.stringify(journal));
  await calendar(h, '2026-12-01', 'journal-close-december-first'); h.clock += DAY;
  const original = own(h, 'JournalEntry')[0];
  const result = await run(h, await h.service.prepareActivityBatch(h.user, correct('reverse-journal-001', target(original), 'The reclassification was booked against the wrong account.')));
  assert.equal(result.complete, true, JSON.stringify(result));
  const reversal = created(h, 'JournalEntry').find(row => row.Id !== original.record.Id), shape = (record, flip) => record.Line.map(line => [flip ? { Debit: 'Credit', Credit: 'Debit' }[line.JournalEntryLineDetail.PostingType] : line.JournalEntryLineDetail.PostingType, line.JournalEntryLineDetail.AccountRef.value, line.Amount]).sort();
  assert.equal(reversal.TxnDate, '2026-12-02'); assert.deepEqual(shape(reversal, true), shape(original.record, false));
  assert.ok(h.posts >= posts + 2);
  await calendar(h, '2026-12-02', 'journal-close-december-second');
});

test('ineligible targets, forged evidence and protected periods are refused before any write', { timeout: 300000 }, async () => {
  const h = await november({ populationRecords: true }), posts = h.posts, refuse = (value, pattern, key) => assert.rejects(h.service.prepareActivityBatch(h.user, correct(key, value)), pattern);
  await refuse({ entity: 'Invoice', qboId: '987654' }, /not created by the accountant/, 'refuse-unmanaged');
  h.data.PopulationRecords.push({ _id: 'p'.repeat(24), ...scope, entity: 'Invoice', qboId: '876543', state: 'saved' });
  await refuse({ entity: 'Invoice', qboId: '876543' }, /imported \(adopted\) history/, 'refuse-adopted');
  const partly = own(h, 'Invoice').find(({ record }) => record.Balance > 0 && record.Balance < record.TotalAmt);
  if (partly) await refuse(target(partly), /partly paid/, 'refuse-partly-paid');
  const stockSale = own(h, 'SalesReceipt')[0], stockBill = own(h, 'Bill').find(({ record }) => record.Line.some(line => line.DetailType === 'ItemBasedExpenseLineDetail'));
  assert.ok(stockSale && stockBill, 'stock records exist');
  await refuse(target(stockSale), /stock or inventory/, 'refuse-stock-sale'); await refuse(target(stockBill), /stock or purchase-order bill/, 'refuse-stock-bill');
  // A prior credit or unexpected link on an otherwise unpaid invoice.
  const unpaid = unpaidCareInvoice(h), record = current(h, 'Invoice', unpaid.step.qboId);
  record.LinkedTxn = [{ TxnId: '999', TxnType: 'CreditMemo' }];
  await refuse(target(unpaid), /already has a payment, credit or other link/, 'refuse-prior-credit');
  delete record.LinkedTxn;
  // Forged or missing ownership evidence.
  const step = unpaid.step, compilation = step.verification.compilationHash;
  step.verification.compilationHash = 'e'.repeat(64); await refuse(target(unpaid), /read-back verification proof is missing/, 'refuse-forged-verification'); step.verification.compilationHash = compilation;
  const receiptIndex = h.data.Receipts.findIndex(row => row.dispatchKey === step.dispatch.key), receipt = h.data.Receipts.splice(receiptIndex, 1)[0];
  await refuse(target(unpaid), /creation receipt or transport audit/, 'refuse-missing-receipt'); h.data.Receipts.push(receipt);
  const auditIndex = h.data.Audits.findIndex(row => row._id === step.lastAuditId), audit = h.data.Audits.splice(auditIndex, 1)[0];
  await refuse(target(unpaid), /verification audit record is missing/, 'refuse-missing-audit'); h.data.Audits.push(audit);
  const evidence = h.data.Evidence.find(row => String(row.operationId) === String(step.operationId)), assertions = evidence.proof.assertions;
  evidence.proof.assertions = []; await refuse(target(unpaid), /completion evidence is missing or changed/, 'refuse-forged-completion'); evidence.proof.assertions = assertions;
  const connection = step.connectionId; step.connectionId = 'f'.repeat(24); await refuse(target(unpaid), /earlier connection/, 'refuse-other-company'); step.connectionId = connection;
  // An application would touch a closed period: refused, protection is not weakened.
  const bill = unpaidOperatingBill(h); h.closedThrough = '2026-11-20';
  await refuse(target(bill), /closed or reconciled period through 2026-11-20/, 'refuse-protected');
  h.closedThrough = null;
  // Server-derived terms cannot be replaced by the agent.
  const valid = await h.service.prepareActivityBatch(h.user, correct('derive-terms-001', target(unpaid)));
  const terms = structuredClone(h.data.Plans.find(row => String(row.operationId) === valid.operationId).manifest.activityBatch.activities[0].correction);
  terms.tax.lines[0].amountCents += 1; terms.tax.totalTaxCents += 1;
  await assert.rejects(h.service.prepareActivityBatch(h.user, { ...correct('forged-terms-001', target(unpaid)), activities: [{ ...correct('x', target(unpaid)).activities[0], correction: terms }] }), /differ from the original record/);
  assert.equal(h.posts, posts);
});

test('an earlier or concurrent correction reserves the original, including unknown outcomes; nothing is sent twice', { timeout: 300000 }, async () => {
  const h = await november(), original = unpaidCareInvoice(h), businessKey = h.data.Calendars[0].businessKey;
  const [key] = reversalKeys(scope, businessKey, { logicalKey: original.step.logicalKey, txnDate: original.record.TxnDate }, ['correction-credit']);
  const fake = operationId => ({ _id: 'zz' + operationId.slice(0, 22), contractVersion: 1, ...scope, operationId, planHash: 'e'.repeat(64), logicalKey: key, fingerprint: hash({ fake: operationId }), entity: 'CreditMemo', state: 'unknown', dependencies: [] });
  h.data.Steps.push(fake('f'.repeat(24)));
  await assert.rejects(h.service.prepareActivityBatch(h.user, correct('reserved-unknown-001', target(original))), /already has a correction \(unknown/);
  h.data.Steps.pop();
  const prepared = await h.service.prepareActivityBatch(h.user, correct('reserved-dispatch-001', target(original)));
  await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  // Another operation's unknown write of the same reversal appears after approval.
  h.data.Steps.push(fake('9'.repeat(24)));
  const posts = h.posts, outcome = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(outcome.complete, true, JSON.stringify(outcome)); assert.match(outcomeText(h, prepared.operationId, outcome), /already corrected this record/);
  assert.equal(h.posts, posts);
});

test('a credit saved before its application failed is never resent', { timeout: 300000 }, async () => {
  const h = await november(), original = unpaidCareInvoice(h), prepared = await h.service.prepareActivityBatch(h.user, correct('credit-then-fail-001', target(original)));
  await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  // Someone records a part payment outside the app right after the credit is saved.
  h.afterPost = async opts => { if (new URL(opts.url).pathname.endsWith('/creditmemo')) { h.afterPost = null; const invoice = current(h, 'Invoice', original.step.qboId); invoice.Balance = Math.round((invoice.Balance - 1) * 100) / 100; invoice.SyncToken = String(Number(invoice.SyncToken) + 1); } };
  const posts = h.posts, first = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(first.complete, true, JSON.stringify(first)); assert.equal(h.posts, posts + 1);
  assert.equal(created(h, 'Payment').filter(row => row.TotalAmt === 0 && linksTo(row, 'Invoice', original.step.qboId)).length, 0);
  const again = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(again.complete, true, JSON.stringify(again)); assert.equal(h.posts, posts + 1);
});
