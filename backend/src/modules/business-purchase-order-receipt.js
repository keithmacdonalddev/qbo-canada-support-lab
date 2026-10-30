'use strict';
// Read-only provenance and content for same-day, whole-order stock receiving.
const { hash, canonical, date } = require('./business-calendar');
const { validateCompilation, verifyBusinessReadback, verifyPopulationFinancialContent } = require('./business-readback');
const { taxExpectation } = require('./business-verification-runtime');
const ID = /^\d{1,30}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_PO_RECEIPT_UNVERIFIED' }); }
function unreceived(record) {
  if (record?.POStatus !== 'Open' || record.CurrencyRef?.value !== 'CAD' || record.GlobalTaxCalculation !== 'TaxExcluded' || record.sparse === true || record.status === 'Deleted' || !Array.isArray(record.Line) || !record.Line.length || record.Line.length > 20 || (record.LinkedTxn || []).length || record.Line.some(line => line.DetailType !== 'ItemBasedExpenseLineDetail' || ![undefined, 0].includes(line.Received) || (line.LinkedTxn || []).length)) fail('Receive only a wholly unreceived open purchase order; partial or unknown prior receipts are unavailable.');
}
function receiptChoice(source, bindings) {
  const record = source.record; unreceived(record); date(record.TxnDate);
  const vendor = Object.entries(bindings).filter(([key, id]) => /^stock-supplier-[1-3]$/.test(key) && id === record.VendorRef?.value);
  if (vendor.length !== 1) fail('The purchase order needs one published stock supplier.');
  const seen = new Set();
  const lines = record.Line.map(line => {
    const detail = line.ItemBasedExpenseLineDetail, items = Object.entries(bindings).filter(([key, id]) => /^workshop-stock-[1-5]$/.test(key) && id === detail.ItemRef?.value), cents = Math.round(detail.UnitPrice * 100);
    if (!ID.test(line.Id || '') || seen.has(line.Id) || items.length !== 1 || !Number.isSafeInteger(detail.Qty) || detail.Qty < 1 || detail.Qty > 1000000 || !Number.isSafeInteger(cents) || cents < 1 || Math.abs(detail.UnitPrice * 100 - cents) > 0.00001 || Math.round(line.Amount * 100) !== detail.Qty * cents || Math.abs(line.Amount * 100 - detail.Qty * cents) > 0.00001) fail('The purchase order needs unique whole-unit inventory lines at exact original costs.');
    seen.add(line.Id); return { lineId: line.Id, itemKey: items[0][0], quantity: detail.Qty, unitPriceCents: cents };
  });
  return { purchaseOrderId: record.Id, vendorKey: vendor[0][0], source: { kind: source.originKind, logicalKey: source.logicalKey, txnDate: record.TxnDate }, lines };
}
function assertChoice(choice, source, bindings) {
  const { purchaseOrderId, vendorKey, source: origin, lines } = choice;
  if (canonical({ purchaseOrderId, vendorKey, source: origin, lines }) !== canonical(receiptChoice(source, bindings))) fail('The purchase order, supplier, quantity or original cost changed. Refresh the receiving choices.');
}
function createPurchaseOrderReceiptReader({ models, readRecord, history, now = () => Date.now() }) {
  return async (scope, selection, { signal } = {}) => {
    if (!ID.test(selection?.purchaseOrderId || '')) fail('Choose an owned purchase order.');
    const filter = { ...scope, entity: 'PurchaseOrder', qboId: selection.purchaseOrderId };
    const managed = await models.Steps.findOne(filter).maxTimeMS(3000).lean();
    let row, originalStep, originalPolicy, originKind;
    if (managed) {
      const retained = await history(scope, [managed.logicalKey], { signal });
      const entry = retained.entries.find(entry => entry.logicalKey === managed.logicalKey);
      if (!entry || entry.entity !== 'PurchaseOrder' || entry.qboId !== managed.qboId || entry.fingerprint !== managed.fingerprint || managed.state !== 'verified' || managed.receipt?.qboId !== managed.qboId || managed.dispatch?.compilationHash !== managed.compilation?.compilationHash || managed.dispatch?.requestHash !== managed.compilation?.request?.requestHash) fail('The purchase order lacks its original managed creation evidence.');
      row = managed; originalStep = entry.step; originalPolicy = entry.policy; originKind = 'managed';
    } else {
      const calendar = await models.Calendars.findOne(scope).select('adoption').maxTimeMS(3000).lean(), adoption = calendar?.adoption;
      if (adoption?.kind !== 'adopted-history') fail('This purchase order was not created by the accountant or adopted import.');
      const job = await require('./business-adopted-settlement').adoptedJob(models.PopulationJobs, adoption);
      const Records = models.PopulationRecords || require('../models/BusinessPopulationRecord');
      row = await Records.findOne(filter).maxTimeMS(3000).lean();
      if (!job || String(job._id) !== String(adoption.jobId) || job.status !== 'adopted' || !HASH.test(job.authorityHash || '') || !row || row.authorityHash !== job.authorityHash || row.state !== 'saved' || row.receipt?.qboId !== row.qboId || row.financialProof?.matchesFinancialIntent !== true || row.relationshipCheck?.outcome === 'error' || row.txnDate > adoption.importedThrough) fail('This purchase order is not a verified saved record of the adopted import.');
      originalStep = row.step; originalPolicy = row.policy; originKind = 'adopted';
    }
    const observed = await readRecord(scope, 'PurchaseOrder', selection.purchaseOrderId, { signal });
    const request = validateCompilation(row.compilation);
    if (canonical(request.scope) !== canonical(scope) || row.compilation.intentHash !== hash(originalStep) || row.compilation.logicalKey !== row.logicalKey || originalStep.entity !== 'PurchaseOrder' || originalPolicy?.stepHash !== hash(originalStep)) fail('The original purchase-order intent or company changed.');
    unreceived(observed.record);
    const receipt = { ...row.receipt, scope, entity: 'PurchaseOrder', logicalKey: row.logicalKey };
    const taxPolicy = { ...taxExpectation(originalPolicy, row.compilation), status: 'approved', scope, compilationHash: row.compilation.compilationHash, evidenceHash: hash(originalPolicy) };
    let financialProof;
    if (originKind === 'managed') {
      const proof = verifyBusinessReadback({ compiled: row.compilation, receipt, observed, parents: [], descendants: [], taxPolicy, now: now() });
      if (!proof.matchesIntent) fail('The current purchase order differs from its managed intent.');
    } else {
      // Rebuild the proof from fresh content, never renew a historical timestamp.
      financialProof = verifyPopulationFinancialContent({ compiled: row.compilation, receipt, observed, parents: [], children: [], taxPolicy, now: now() });
    }
    return { ...observed, originKind, logicalKey: row.logicalKey, entity: 'PurchaseOrder', fingerprint: hash(originalStep), qboId: row.qboId, syncToken: observed.record.SyncToken, state: originKind === 'adopted' ? 'financially-verified' : 'verified', originalStep, originalPolicy, ...(financialProof ? { financialProof } : {}) };
  };
}
module.exports = { unreceived, receiptChoice, assertChoice, createPurchaseOrderReceiptReader };
