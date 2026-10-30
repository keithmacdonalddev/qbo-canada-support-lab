'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { freezeWriteRequest, scoped } = require('./qbo-write-contract');
const { SUPPORTED, canonicalTxnType } = require('./business-transaction-compiler');
const { verifyAccountPosting } = require('./business-receivables-route');
const { createUnreceivedProof } = require('./business-purchase-order-consumption');
const { accountingOnlyObservation } = require('./business-accounting-only');
const HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
function invalid(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_READBACK_UNVERIFIED' }); }
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => a?.[key] === b?.[key]);
function fresh(stamp, now) { const value = typeof stamp === 'string' ? Date.parse(stamp) : NaN; return Number.isFinite(value) && new Date(value).toISOString() === stamp && value <= now && now - value <= 300000; }
function listDefinitionHash(scope, entity, record) { try { return require('./business-reference').referenceDefinition(scope, entity, record).hash; } catch { return null; } }
// The read-back evidence hash of a standalone added list record (no tax policy,
// parents, descendants, routing or conversions), exactly as verifyBusinessContent and
// verifyBusinessReadback compute it. The added-role registry recomputes it from the
// retained receipt hash and observed record hash; keep the two in step.
function listReadbackEvidenceHash({ requestHash, compilationHash, receiptHash, recordHash }) {
  return hash({ content: hash({ requestHash, compilationHash, taxPolicy: null, receipt: receiptHash, recordHash, parents: [], descendants: [] }), parents: [] });
}
function cents(value) { if (typeof value !== 'number' || !Number.isFinite(value)) invalid('A saved monetary value is missing.'); const number = Math.round(value * 100); if (!Number.isSafeInteger(number) || number < 0 || Math.abs(value * 100 - number) > Number.EPSILON * Math.max(1, Math.abs(value * 100)) * 4) invalid('A saved monetary value is invalid.'); return number; }
function validateCompilation(compiled) {
  if (!compiled || compiled.version !== 1 || !SUPPORTED.has(compiled.entity) || !HASH.test(compiled.logicalKey || '') || !HASH.test(compiled.intentHash || '') || !HASH.test(compiled.evidenceHash || '') || !Array.isArray(compiled.relationships) || compiled.relationships.length > 20) invalid('The original compiled transaction is unavailable.');
  const artifact = Object.fromEntries(['version', 'logicalKey', 'entity', 'intentHash', 'request', 'evidenceHash', 'relationships'].map(key => [key, compiled[key]]));
  if (!HASH.test(compiled.compilationHash || '') || hash(artifact) !== compiled.compilationHash) invalid('The original compiled artifact changed.');
  let request;
  try { request = freezeWriteRequest(compiled.request.scope, compiled.request.method, compiled.request.endpoint, JSON.parse(compiled.request.body)); } catch { invalid('The saved compiled request is invalid.'); }
  if (request.requestHash !== compiled.request.requestHash || request.entity !== compiled.entity.toLowerCase() || request.operation !== 'create') invalid('The original compiled request changed.');
  const keys = new Set();
  for (const link of compiled.relationships) {
    if (!HASH.test(link.logicalKey || '') || keys.has(link.logicalKey) || !SUPPORTED.has(link.entity) || typeof link.qboId !== 'string' || !QBO_ID.test(link.qboId) || typeof link.syncToken !== 'string' || !VERSION.test(link.syncToken) || !HASH.test(link.fingerprint || '') || !['linked', 'prerequisite'].includes(link.kind) || !Array.isArray(link.links) || link.links.length > 101) invalid('The original relationship contract is invalid.');
    keys.add(link.logicalKey);
  }
  // A same-day customer credit stands alone: no invoice and no links (it stays open).
  if (compiled.entity === 'CreditMemo' && compiled.relationships.length === 0) {
    const payload = JSON.parse(request.body);
    if (payload.LinkedTxn !== undefined || (payload.Line || []).some(line => line.LinkedTxn !== undefined)) invalid('A standalone customer credit cannot link another transaction.');
  } else if (compiled.entity === 'CreditMemo') {
    const source = compiled.relationships[0], payload = JSON.parse(request.body);
    if (compiled.relationships.length !== 1 || source.entity !== 'Invoice' || source.kind !== 'prerequisite' || source.links.length) invalid('A service credit needs its exact invoice prerequisite.');
    try { date(source.sourceTxnDate); date(payload.TxnDate); } catch { invalid('The original credit source accounting date is unavailable.'); }
    if (source.sourceTxnDate > payload.TxnDate) invalid('The credit cannot precede its original invoice.');
  }
  return request;
}
function linkList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) invalid('Saved transaction links are malformed.');
  return value.map(link => {
    if (!link || typeof link.TxnId !== 'string' || !QBO_ID.test(link.TxnId) || !SUPPORTED.has(canonicalTxnType(link.TxnType)) || (link.TxnLineId !== undefined && (typeof link.TxnLineId !== 'string' || !QBO_ID.test(link.TxnLineId)))) invalid('A saved transaction link is invalid.');
    return { TxnId: link.TxnId, TxnType: canonicalTxnType(link.TxnType), ...(link.TxnLineId && link.TxnLineId !== '0' ? { TxnLineId: link.TxnLineId } : {}) };
  });
}
function exactLinks(expected, actual) {
  const ordered = values => values.map(value => canonical(value)).sort();
  return canonical(ordered(linkList(expected))) === canonical(ordered(linkList(actual)));
}
function subset(expected, actual, path = '') {
  if (expected === null || typeof expected !== 'object') {
    if (typeof expected === 'number') {
      if (['Amount', 'TotalAmt', 'UnitPrice'].includes(path.split('.').at(-1))) { try { return cents(expected) === cents(actual); } catch { return false; } }
      return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(expected - actual) < 0.0000001;
    }
    return expected === actual;
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(expected) || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => {
    if (key === 'LinkedTxn') return exactLinks(value, actual[key]);
    // Omitted processing flags are not proof of a bank movement. Creation intent
    // explicitly forbids processing; an affirmative saved flag is a mismatch.
    if (['ProcessPayment', 'ProcessBillPayment'].includes(key) && value === false && actual[key] === undefined) return true;
    return subset(value, actual[key], path + '.' + key);
  });
}
function checkedObservation(value, scope, entity, qboId, now) {
  if (!value || !sameScope(value.scope, scope) || value.entity !== entity || !fresh(value.observedAt, now) || !value.record || value.record.Id !== qboId || typeof value.record.SyncToken !== 'string' || !VERSION.test(value.record.SyncToken) || value.recordHash !== hash(value.record)) invalid('A scoped fresh read of the exact saved record is required.');
  return value.record;
}
function verifiedObservation(value, scope, entity, qboId, now, kind = 'business-readback') {
  const record = checkedObservation(value, scope, entity, qboId, now), proof = value.verification;
  if (!proof || proof.kind !== kind || proof.version !== 1 || !sameScope(proof.scope, scope) || proof.logicalKey !== value.logicalKey || proof.entity !== entity || proof.qboId !== qboId || proof.fingerprint !== value.fingerprint || proof.matchesIntent !== true || proof.observedHash !== value.recordHash || proof.syncToken !== record.SyncToken || !fresh(proof.observedAt, now) || !HASH.test(proof.evidenceHash || '')) invalid('A related record changed after its verification.');
  return record;
}
function taxMatches(policy, compiled, record) {
  if (!policy || policy.version !== 1 || policy.status !== 'approved' || !sameScope(policy.scope, compiled.request.scope) || policy.compilationHash !== compiled.compilationHash || !HASH.test(policy.evidenceHash || '') || !Number.isSafeInteger(policy.totalTaxCents) || policy.totalTaxCents < 0 || !Array.isArray(policy.lines) || policy.lines.length > 100) return false;
  const tax = record.TxnTaxDetail, actual = tax?.TaxLine || [];
  if (!Array.isArray(actual) || actual.length !== policy.lines.length || cents(tax?.TotalTax) !== policy.totalTaxCents) return false;
  let total = 0; const used = new Set();
  for (const line of policy.lines) {
    if (!line || typeof line.rateId !== 'string' || !QBO_ID.test(line.rateId) || typeof line.percent !== 'number' || !Number.isFinite(line.percent) || line.percent < 0 || !Number.isSafeInteger(line.taxableCents) || line.taxableCents < 0 || !Number.isSafeInteger(line.amountCents) || line.amountCents < 0) return false;
    total += line.amountCents;
    const index = actual.findIndex((saved, i) => !used.has(i) && saved.DetailType === 'TaxLineDetail' && cents(saved.Amount) === line.amountCents && saved.TaxLineDetail?.TaxRateRef?.value === line.rateId && saved.TaxLineDetail?.PercentBased === true && saved.TaxLineDetail?.TaxPercent === line.percent && cents(saved.TaxLineDetail?.NetAmountTaxable) === line.taxableCents);
    if (index < 0) return false; used.add(index);
  }
  return total === policy.totalTaxCents;
}
// All receipt/compilation/neighbor inputs are loaded by trusted server adapters.
// This function checks observed content; it does not identify ownership by notes.
function verifyBusinessContent({ compiled, receipt, observed, parents = [], descendants = [], taxPolicy = null, now = Date.now() }) {
  const request = validateCompilation(compiled), scope = request.scope;
  if (!receipt || receipt.version !== 1 || !sameScope(receipt.scope, scope) || receipt.entity !== compiled.entity || receipt.logicalKey !== compiled.logicalKey || receipt.requestHash !== request.requestHash || typeof receipt.qboId !== 'string' || !QBO_ID.test(receipt.qboId) || !HASH.test(receipt.dispatchKey || '') || !HASH.test(receipt.evidenceHash || '') || !['create-response', 'request-correlated-readback', 'owner-attributed-readback'].includes(receipt.source)) invalid('The exact saved creation receipt is required.');
  const record = checkedObservation(observed, scope, compiled.entity, receipt.qboId, now), payload = JSON.parse(request.body), issues = [];
  const mismatch = message => { if (!issues.includes(message)) issues.push(message); };
  if (!accountingOnlyObservation(compiled.entity, record)) mismatch('Unplanned payment processing or instrument information is present.');
  if (!Array.isArray(parents) || parents.length !== compiled.relationships.length || !Array.isArray(descendants) || descendants.length > 1000) invalid('Complete relationship observations are required.');
  const relationships = compiled.relationships.map(expected => {
    const found = parents.filter(value => value.logicalKey === expected.logicalKey);
    if (found.length !== 1 || !['saved', 'verified'].includes(found[0].state) || found[0].fingerprint !== expected.fingerprint) invalid('An originating activity is not freshly verified.');
    const parent = checkedObservation(found[0], scope, expected.entity, expected.qboId, now);
    return { logicalKey: expected.logicalKey, entity: expected.entity, fingerprint: expected.fingerprint, qboId: parent.Id, syncToken: parent.SyncToken };
  });
  const childKeys = new Set(), childIds = new Set(), childLinks = [];
  let droppedChild = null;
  for (const child of descendants) {
    if (!child || !HASH.test(child.logicalKey || '') || childKeys.has(child.logicalKey) || !HASH.test(child.fingerprint || '') || !['saved', 'verified'].includes(child.state) || !SUPPORTED.has(child.entity) || !child.creationReceipt || !HASH.test(child.creationReceipt.evidenceHash || '') || child.creationReceipt.qboId !== child.record?.Id) invalid('A downstream activity lacks its managed creation evidence.');
    const physicalKey = child.entity + ':' + child.record?.Id;
    if (childIds.has(physicalKey) || (child.entity === compiled.entity && child.record?.Id === record.Id)) invalid('A downstream saved record is duplicated.');
    childIds.add(physicalKey);
    const childReceipt = child.creationReceipt;
    if (childReceipt.version !== 1 || !sameScope(childReceipt.scope, scope) || childReceipt.entity !== child.entity || childReceipt.logicalKey !== child.logicalKey || !HASH.test(childReceipt.requestHash || '') || !HASH.test(childReceipt.dispatchKey || '') || !['create-response', 'request-correlated-readback', 'owner-attributed-readback'].includes(childReceipt.source)) invalid('The downstream creation receipt has a different identity.');
    if (!HASH.test(child.compilationHash || '') || child.verification?.compilationHash !== child.compilationHash) invalid('The downstream proof is not bound to its dispatched compilation.');
    childKeys.add(child.logicalKey); verifiedObservation(child, scope, child.entity, childReceipt.qboId, now, 'business-content');
    const origin = child.verification.relationships?.filter(link => link.logicalKey === compiled.logicalKey);
    if (!origin || origin.length !== 1 || origin[0].entity !== compiled.entity || origin[0].fingerprint !== compiled.intentHash || origin[0].qboId !== record.Id || origin[0].syncToken !== record.SyncToken) invalid('The downstream content proof names a different originating intent or version.');
    const linked = [...linkList(child.record.LinkedTxn), ...(child.record.Line || []).flatMap(line => linkList(line.LinkedTxn))];
    const dropped = compiled.entity === 'Estimate' && child.entity === 'Invoice' && child.verification.estimateLinkDropped?.logicalKey === compiled.logicalKey && child.verification.estimateLinkDropped.estimateId === record.Id;
    if (dropped) droppedChild = child;
    else if (!linked.some(link => link.TxnType === compiled.entity && link.TxnId === receipt.qboId)) invalid('A downstream record does not point back to this saved activity.');
    for (const link of linked.filter(value => value.TxnType === compiled.entity && value.TxnId === record.Id && value.TxnLineId)) {
      if (!Array.isArray(record.Line) || record.Line.filter(line => line.Id === link.TxnLineId && line.DetailType !== 'SubTotalLineDetail').length !== 1) invalid('A downstream line points to a missing or ambiguous originating line.');
    }
    childLinks.push({ TxnId: child.record.Id, TxnType: child.entity });
  }
  const estimateConversion = observed.estimateConversion ? require('./business-estimate-conversion').verifyEstimateConversion({ compiled, receipt, observed, parents, now }) : null;
  const conversion = require('./business-estimate-conversion');
  let estimateLinkDropped = null;
  if (compiled.relationships.some(link => link.representation !== undefined) && !conversion.verifyWholeEstimateCreation({ compiled, receipt, observed, parents, now })) {
    estimateLinkDropped = conversion.verifyDroppedEstimateLink({ compiled, receipt, observed, parents, now });
    if (!estimateLinkDropped) mismatch('The complete Estimate conversion links, states or economics remain unverified.');
  }
  const expectedHeader = { ...payload }; delete expectedHeader.Line; delete expectedHeader.LinkedTxn;
  if (compiled.entity === 'Estimate' && descendants.length) {
    if (descendants.length !== 1 || descendants[0].entity !== 'Invoice') mismatch('Only one complete managed invoice may convert this Estimate.');
    // A dropped link leaves the Estimate open and unlinked (see verifyDroppedEstimateLink).
    if (droppedChild) { if (!['Pending', 'Accepted'].includes(record.TxnStatus) || linkList(record.LinkedTxn).length) mismatch('The unlinked Estimate changed after its invoice was saved.'); }
    else expectedHeader.TxnStatus = 'Closed';
  }
  if (compiled.entity === 'TimeActivity' && record.BillableStatus === 'HasBeenBilled' && descendants.some(value => value.entity === 'Invoice')) expectedHeader.BillableStatus = 'HasBeenBilled';
  const postingAccount = compiled.entity === 'BillPayment' ? 'APAccountRef' : 'ARAccountRef';
  if (['Invoice', 'Payment', 'BillPayment', 'CreditMemo'].includes(compiled.entity) && record[postingAccount] === undefined && payload[postingAccount]) {
    if (verifyAccountPosting({ observed, compiled, receipt, now }) !== payload[postingAccount].value) invalid('The transaction posted to a different approved account.');
    delete expectedHeader[postingAccount];
  }
  if (!subset(expectedHeader, record)) mismatch('Saved header fields differ from the requested transaction.');
  const listRecord = require('./business-transaction-compiler').LISTS.has(compiled.entity);
  if (listRecord && record.Active !== true) mismatch('The added customer, supplier or item is not active.');
  // An added list record is standalone: no parent, sub-customer/project, billing
  // through a parent, sub-item or quantity tracking (the request sends none of them).
  if (listRecord && (record.ParentRef?.value || [record.Job, record.BillWithParent, record.IsProject, record.SubItem, record.TrackQtyOnHand].some(value => value === true || value === 'true') || (compiled.entity === 'Item' && record.Type !== 'Service'))) mismatch('The added customer, supplier or item gained a parent, project, sub-item or stock setting.');
  for (const key of ['ClassRef', 'DepartmentRef', 'ProjectRef']) if (!payload[key] && record[key]?.value) mismatch('An unplanned transaction dimension is present.');
  const permittedTop = [...linkList(payload.LinkedTxn), ...childLinks], actualTop = linkList(record.LinkedTxn);
  for (const expected of linkList(payload.LinkedTxn)) if (!(estimateLinkDropped && expected.TxnType === 'Estimate' && expected.TxnId === estimateLinkDropped.estimateId) && !actualTop.some(value => canonical(value) === canonical(expected))) mismatch('An originating transaction link is missing.');
  for (const actual of actualTop) if (!permittedTop.some(value => value.TxnType === actual.TxnType && value.TxnId === actual.TxnId && (value.TxnLineId || null) === (actual.TxnLineId || null))) mismatch('An unplanned transaction link is present.');
  if (payload.Line) {
    if (!Array.isArray(record.Line) || record.Line.length > 101) invalid('Saved transaction lines are unavailable.');
    const expectedLines = payload.Line, actualLines = record.Line.filter(line => line.DetailType !== 'SubTotalLineDetail'), subtotals = record.Line.filter(line => line.DetailType === 'SubTotalLineDetail');
    const beforeTax = expectedLines.reduce((sum, line) => sum + cents(line.Amount), 0);
    if (subtotals.length > 1 || subtotals.some(line => record.Line.at(-1) !== line || cents(line.Amount) !== beforeTax || !['Estimate', 'Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt'].includes(compiled.entity))) mismatch('Unexpected subtotal lines were saved.');
    const used = new Set();
    if (actualLines.length !== expectedLines.length) mismatch('The saved financial line count differs.');
    for (const originalExpected of expectedLines) {
      const expected = estimateConversion ? { ...originalExpected } : originalExpected;
      // This separate proof reports a whole-Estimate header conversion. It does
      // not insert a provider line link or alter the original compiled request.
      if (estimateConversion) delete expected.LinkedTxn;
      const index = actualLines.findIndex((actual, index) => !used.has(index) && subset(expected, actual));
      if (index < 0) { mismatch('Saved line amounts, quantities, tax codes or source links differ.'); continue; }
      used.add(index); const actual = actualLines[index], detail = actual[actual.DetailType];
      for (const key of ['ClassRef', 'ProjectRef']) if (!expected[key] && actual[key]?.value) mismatch('An unplanned line dimension is present.');
      if (detail) for (const key of ['CustomerRef', 'ClassRef', 'ProjectRef', 'AccountRef']) if (!expected[expected.DetailType]?.[key] && detail[key]?.value) mismatch('An unplanned line relationship is present.');
      if (!expected.LinkedTxn && linkList(actual.LinkedTxn).length) mismatch('An unplanned line transaction link is present.');
    }
    if (['Estimate', 'Invoice', 'SalesReceipt', 'CreditMemo', 'PurchaseOrder', 'Bill', 'Purchase', 'VendorCredit', 'RefundReceipt'].includes(compiled.entity)) {
      if (!taxMatches(taxPolicy, compiled, record)) mismatch('Approved tax amounts and rates remain unverified.');
      if (cents(record.TotalAmt) !== beforeTax + cents(record.TxnTaxDetail?.TotalTax)) mismatch('The saved total does not equal item amounts plus tax.');
    } else if (compiled.entity === 'Deposit' && cents(record.TotalAmt) !== beforeTax) mismatch('The saved deposit total differs from its linked receipt.');
    if (compiled.entity === 'Payment' && cents(record.UnappliedAmt) !== 0) mismatch('The payment is not fully applied to its invoice.');
    // A new supplier credit is not yet applied to any bill.
    if (compiled.entity === 'VendorCredit' && (descendants.length || cents(record.Balance) !== cents(record.TotalAmt))) mismatch('The supplier credit is already applied or its remaining credit differs.');
  } else if (Array.isArray(record.Line) && record.Line.length) mismatch('Unexpected financial lines were saved.');
  if (['Invoice', 'Bill'].includes(compiled.entity)) {
    const childType = compiled.entity === 'Invoice' ? 'Payment' : 'BillPayment';
    let applied = 0;
    for (const child of descendants) {
      if (child.entity !== childType) { mismatch('An unsupported settlement affects this balance.'); continue; }
      for (const line of child.record.Line || []) {
        const links = linkList(line.LinkedTxn);
        if (!links.some(link => link.TxnType === compiled.entity && link.TxnId === record.Id)) continue;
        if (links.length !== 1) { mismatch('A settlement amount has ambiguous transaction links.'); continue; }
        applied += cents(line.Amount);
      }
    }
    if (cents(record.Balance) !== cents(record.TotalAmt) - applied) mismatch('The saved balance does not reconcile to verified settlements.');
  }
  if (compiled.entity === 'CreditMemo') {
    let consumed = 0;
    for (const child of descendants) {
      if (child.entity !== 'Payment') { mismatch('An unsupported settlement affects this credit.'); continue; }
      for (const line of child.record.Line || []) {
        const linked = linkList(line.LinkedTxn);
        if (!linked.some(link => link.TxnType === 'CreditMemo' && link.TxnId === record.Id)) continue;
        if (linked.length !== 1) { mismatch('A credit application amount has ambiguous transaction links.'); continue; }
        consumed += cents(line.Amount);
      }
    }
    if (consumed > cents(record.TotalAmt) || cents(record.RemainingCredit) !== cents(record.TotalAmt) - consumed) mismatch('The remaining credit does not reconcile to its verified applications.');
  }
  if (compiled.entity === 'PurchaseOrder') {
    let fullyReceived = true;
    if (new Set((record.Line || []).map(line => line.Id)).size !== record.Line?.length) invalid('Purchase order line identities are duplicated.');
    for (const line of record.Line || []) {
      if (line.DetailType !== 'ItemBasedExpenseLineDetail' || typeof line.Id !== 'string' || !QBO_ID.test(line.Id)) { mismatch('The saved purchase order line cannot be reconciled.'); continue; }
      let consumed = 0;
      for (const child of descendants) {
        if (child.entity !== 'Bill') { mismatch('An unsupported activity consumes this purchase order.'); continue; }
        for (const billLine of child.record.Line || []) {
          const links = linkList(billLine.LinkedTxn);
          if (!links.some(link => link.TxnType === 'PurchaseOrder' && link.TxnId === record.Id && link.TxnLineId === line.Id)) continue;
          const detail = billLine.ItemBasedExpenseLineDetail;
          if (links.length !== 1 || !detail || detail.ItemRef?.value !== line.ItemBasedExpenseLineDetail?.ItemRef?.value || typeof detail.Qty !== 'number' || !Number.isFinite(detail.Qty) || detail.Qty < 0) { mismatch('A bill quantity cannot be assigned to one purchase order line.'); continue; }
          consumed += detail.Qty;
        }
      }
      const quantity = line.ItemBasedExpenseLineDetail?.Qty;
      // QBO can omit Received when no quantity has been consumed. This is a
      // graph-derived zero, never a fabricated API field or a partial receipt.
      const omittedUnreceived = line.Received === undefined && consumed === 0 && descendants.length === 0 && record.POStatus === 'Open' && linkList(record.LinkedTxn).length === 0 && record.Line.every(value => linkList(value.LinkedTxn).length === 0);
      if ((!omittedUnreceived && (typeof line.Received !== 'number' || !Number.isFinite(line.Received) || Math.abs(line.Received - consumed) > 0.0000001)) || consumed > quantity) mismatch('The purchase order consumed quantity is unavailable or differs from its saved bill lines.');
      if (consumed !== quantity) fullyReceived = false;
    }
    if (record.POStatus !== (fullyReceived ? 'Closed' : 'Open')) mismatch('The purchase order status differs from its verified consumption.');
  }
  const purchaseOrderConsumption = compiled.entity === 'PurchaseOrder' && issues.length === 0 && record.Line.some(line => line.Received === undefined) ? createUnreceivedProof({ compiled, receipt, observed, descendants }) : null;
  if (taxPolicy?.purchaseOrderReceipt) {
    const source = taxPolicy.purchaseOrderReceipt, original = source.original;
    const tax = require('./business-verification-runtime').taxExpectation(original.policy, original.compilation);
    const child = { logicalKey: compiled.logicalKey, entity: 'Bill', qboId: receipt.qboId, receiptHash: receipt.evidenceHash, compilation: compiled, receipt, observed, settlementLines: record.Line, relationships: [{ logicalKey: original.logicalKey, qboId: original.qboId, fingerprint: original.compilation.intentHash }] };
    verifyPopulationFinancialContent({ compiled: original.compilation, receipt: { ...original.receipt, scope, entity: 'PurchaseOrder', logicalKey: original.logicalKey }, observed: source.observed, parents: [], children: [child], taxPolicy: { ...tax, status: 'approved', scope, compilationHash: original.compilation.compilationHash, evidenceHash: hash(original.policy) }, now });
    // The received order must link back to this bill.
    if (!linkList(source.observed.record?.LinkedTxn).some(link => link.TxnType === 'Bill' && link.TxnId === receipt.qboId)) invalid('The received purchase order does not link back to this bill.');
  }
  const dropProof = estimateLinkDropped || droppedChild?.verification.estimateLinkDropped || null;
  const oldest = [observed, ...(taxPolicy?.purchaseOrderReceipt ? [taxPolicy.purchaseOrderReceipt.observed] : []), ...(observed.accountRouting ? [observed.accountRouting] : []), ...(estimateConversion ? [estimateConversion] : []), ...parents, ...descendants, ...descendants.map(value => value.verification)].map(value => value.observedAt).sort()[0];
  // The verified full definition of an added list record (the shared reference
  // definition contract: everything except version metadata and balances). Later use
  // of the record is refused unless its current definition still has this hash.
  const listDefinition = listRecord && record.Active === true ? listDefinitionHash(scope, compiled.entity, record) : null;
  return { version: 1, kind: 'business-content', compilationHash: compiled.compilationHash, scope, logicalKey: compiled.logicalKey, entity: compiled.entity, qboId: record.Id, fingerprint: compiled.intentHash, matchesIntent: issues.length === 0, issues,
    syncToken: record.SyncToken, observedAt: oldest, observedHash: observed.recordHash, ...(listDefinition ? { listDefinitionHash: listDefinition } : {}), ...(observed.accountRouting ? { accountRouting: observed.accountRouting } : {}), ...(estimateConversion ? { estimateConversion } : {}), ...(dropProof ? { estimateLinkDropped: dropProof } : {}), ...(purchaseOrderConsumption ? { purchaseOrderConsumption } : {}),
    evidenceHash: hash({ requestHash: request.requestHash, compilationHash: compiled.compilationHash, taxPolicy: taxPolicy?.evidenceHash || null, ...(taxPolicy?.purchaseOrderReceipt ? { purchaseOrderReceipt: hash(JSON.parse(JSON.stringify(taxPolicy.purchaseOrderReceipt))) } : {}), receipt: receipt.evidenceHash, recordHash: observed.recordHash, ...(purchaseOrderConsumption ? { purchaseOrderConsumptionHash: purchaseOrderConsumption.evidenceHash } : {}), ...(observed.accountRouting ? { accountRoutingHash: observed.accountRouting.evidenceHash } : {}), ...(estimateConversion ? { estimateConversionHash: estimateConversion.evidenceHash } : {}), ...(dropProof ? { estimateLinkDropped: dropProof } : {}), parents: parents.map(value => ({ logicalKey: value.logicalKey, recordHash: value.recordHash })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)), descendants: descendants.map(value => ({ logicalKey: value.logicalKey, recordHash: value.recordHash })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) }), relationships };
}
// Content checks can be computed for a saved child before closing its parent graph.
// They never mark a step verified. This avoids a circular dependency when an invoice
// changes its time activity to HasBeenBilled in the same QuickBooks save.
function verifyBusinessReadback(input) {
  const proof = verifyBusinessContent(input), now = input.now ?? Date.now();
  for (const parent of input.parents || []) {
    if (parent.state !== 'verified') invalid('An originating activity is not freshly verified.');
    verifiedObservation(parent, proof.scope, parent.entity, parent.record.Id, now);
  }
  return { ...proof, kind: 'business-readback', observedAt: [proof.observedAt, ...(input.parents || []).map(value => value.verification.observedAt)].sort()[0], evidenceHash: hash({ content: proof.evidenceHash, parents: (input.parents || []).map(value => ({ logicalKey: value.logicalKey, evidenceHash: value.verification.evidenceHash })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) }) };
}
function createBusinessReadbackAdapter({ loadCompilation, readRecord, loadParents, loadDescendants, loadTaxPolicy, now = () => Date.now() }) {
  if ([loadCompilation, readRecord, loadParents, loadDescendants, loadTaxPolicy, now].some(value => typeof value !== 'function')) throw new TypeError('Read-back needs explicit trusted evidence adapters');
  return async step => {
    const scope = scoped({ realmId: step.realmId, environment: step.environment, connectionId: step.connectionId });
    const compiled = await loadCompilation(step);
    if (compiled?.logicalKey !== step.logicalKey || compiled?.entity !== step.entity || compiled?.intentHash !== step.fingerprint || compiled?.request?.requestHash !== step.dispatch?.requestHash || compiled?.compilationHash !== step.dispatch?.compilationHash) invalid('The saved compilation does not match this dispatched step.');
    if (!step.receipt || step.receipt.version !== 1 || step.receipt.dispatchKey !== step.dispatch.key || step.receipt.qboId !== step.qboId || step.receipt.requestHash !== step.dispatch.requestHash) invalid('The stored receipt no longer matches its dispatched step.');
    const receipt = { ...step.receipt, scope, entity: step.entity, logicalKey: step.logicalKey };
    const [observed, parents, descendants, taxPolicy] = await Promise.all([readRecord(scope, step.entity, step.qboId), loadParents(step, compiled), loadDescendants(step, compiled), loadTaxPolicy(step, compiled)]);
    return verifyBusinessReadback({ compiled, receipt, observed, parents, descendants, taxPolicy, now: now() });
  };
}

// This facet proves accounting content only. It never grants full-graph verification
// or advances a business calendar. The runtime loads every receipt and child itself.
function verifyPopulationFinancialContent({ compiled, receipt, observed, parents = [], children = [], taxPolicy = null, now = Date.now() }) {
  const request = validateCompilation(compiled), scope = request.scope;
  if (!receipt || receipt.version !== 1 || !sameScope(receipt.scope, scope) || receipt.entity !== compiled.entity || receipt.logicalKey !== compiled.logicalKey || receipt.requestHash !== request.requestHash || !HASH.test(receipt.dispatchKey || '') || !HASH.test(receipt.evidenceHash || '') || !['create-response','request-correlated-readback','owner-attributed-readback'].includes(receipt.source)) invalid('Exact creation evidence is required for population content.');
  const record = checkedObservation(observed, scope, compiled.entity, receipt.qboId, now), payload = JSON.parse(request.body), gaps = [];
  if ([record.ProcessPayment,record.ProcessBillPayment].some(value=>value===true||String(value).toLowerCase()==='true') || !accountingOnlyObservation(compiled.entity, record) || record.sparse === true || record.status === 'Deleted') invalid('Population requires a complete accounting-only record.');
  if (!Array.isArray(children) || children.length > 1000 || !Array.isArray(parents) || parents.length !== compiled.relationships.length) invalid('Population neighbors are incomplete.');
  for (const parent of compiled.relationships) {
    const found = parents.filter(value => value.logicalKey === parent.logicalKey && value.entity === parent.entity && value.fingerprint === parent.fingerprint);
    if (found.length !== 1) invalid('An original population source is missing.');
    checkedObservation(found[0], scope, parent.entity, parent.qboId, now);
  }
  const childLinks = children.map(child => {
    if (!HASH.test(child.logicalKey || '') || !HASH.test(child.receiptHash || '') || !QBO_ID.test(child.qboId || '') || !SUPPORTED.has(child.entity) || !Array.isArray(child.relationships) || !child.relationships.some(link => link.logicalKey === compiled.logicalKey && link.qboId === record.Id && link.fingerprint === compiled.intentHash)) invalid('A population child lacks its original source reservation.');
    if (['Invoice','Bill','PurchaseOrder'].includes(compiled.entity)) {
      const childRequest=validateCompilation(child.compilation),childRecord=checkedObservation(child.observed,scope,child.entity,child.qboId,now),childPayload=JSON.parse(childRequest.body),childHeader={...childPayload};delete childHeader.Line;delete childHeader.LinkedTxn;
      if(child.receipt?.evidenceHash!==child.receiptHash||child.receipt.qboId!==child.qboId||child.receipt.logicalKey!==child.logicalKey||child.receipt.requestHash!==childRequest.requestHash||!sameScope(child.receipt.scope,scope)||!accountingOnlyObservation(child.entity,childRecord))invalid('A financial child lost its exact creation/content evidence.');
      const postingKey=child.entity==='BillPayment'?'APAccountRef':'ARAccountRef';if(['Payment','BillPayment'].includes(child.entity)&&childHeader[postingKey]&&childRecord[postingKey]===undefined){if(verifyAccountPosting({observed:child.observed,compiled:child.compilation,receipt:child.receipt,now})!==childHeader[postingKey].value)invalid('A settlement posting account changed.');delete childHeader[postingKey];}
      const lines=(childRecord.Line||[]).filter(line=>line.DetailType!=='SubTotalLineDetail'),used=new Set();if(!subset(childHeader,childRecord)||lines.length!==(childPayload.Line||[]).length)invalid('A saved child amount or header differs.');for(const expected of childPayload.Line||[]){const index=lines.findIndex((line,i)=>!used.has(i)&&subset(expected,line));if(index<0)invalid('A saved child amount, quantity or source allocation differs.');used.add(index);}
      if(canonical(child.settlementLines)!==canonical(childRecord.Line||[]))invalid('A settlement source differs from its fresh raw observation.');
    }
    return compiled.entity==='Bill'&&child.entity==='SalesReceipt'?null:{ TxnId: child.qboId, TxnType: child.entity };
  }).filter(Boolean);
  const hasChild = entity => children.some(child => child.entity === entity);
  const estimate = parents.find(parent => parent.entity === 'Estimate'), time = parents.find(parent => parent.entity === 'TimeActivity');
  const exactWholeEstimate = compiled.entity === 'Invoice' && compiled.relationships.some(link=>link.entity==='Estimate'&&link.representation==='whole-estimate-header') && require('./business-estimate-conversion').verifyWholeEstimateCreation({compiled,receipt,observed,parents,now});
  const exactLegacyWholeReference=compiled.entity==='Invoice'&&compiled.relationships.some(link=>link.entity==='Estimate'&&link.representation===undefined)&&require('./business-estimate-conversion').verifyLegacyWholeEstimateLineReference({compiled,receipt,observed,parents,now});
  const missingEstimate = compiled.entity === 'Invoice' && compiled.relationships.length === 2 && estimate && time && linkList(payload.LinkedTxn).some(link => link.TxnType === 'Estimate') && !linkList(record.LinkedTxn).some(link => link.TxnType === 'Estimate');
  if (missingEstimate) {
    const quote = estimate.record, work = time.record, line = payload.Line?.[0], detail = line?.SalesItemLineDetail;
    if (payload.Line?.length !== 1 || !['Pending','Accepted'].includes(quote.TxnStatus) || linkList(quote.LinkedTxn).length || !['Billable','HasBeenBilled'].includes(work.BillableStatus) || work.CustomerRef?.value !== payload.CustomerRef?.value || quote.CustomerRef?.value !== payload.CustomerRef?.value || work.ItemRef?.value !== detail?.ItemRef?.value || work.Hours + work.Minutes / 60 !== detail?.Qty || linkList(record.LinkedTxn).filter(link => link.TxnType === 'TimeActivity' && link.TxnId === work.Id).length !== 1) invalid('The missing Estimate origin is outside the explicitly supported coverage gap.');
    const quoteLines = quote.Line?.filter(value => value.DetailType === 'SalesItemLineDetail');
    if (quoteLines?.length !== 1 || quoteLines[0].SalesItemLineDetail?.ItemRef?.value !== detail.ItemRef.value || quoteLines[0].SalesItemLineDetail.Qty !== detail.Qty || cents(quoteLines[0].SalesItemLineDetail.UnitPrice) !== cents(detail.UnitPrice) || cents(quoteLines[0].Amount) !== cents(line.Amount)) invalid('The unconverted Estimate economics differ.');
    gaps.push('estimate-invoice-conversion-unverified');
    if(work.BillableStatus==='Billable')gaps.push('time-invoice-billing-unverified');
  }
  const header = { ...payload }; delete header.Line; delete header.LinkedTxn;
  if (compiled.entity === 'Estimate' && hasChild('Invoice')) {
    if (record.TxnStatus === 'Closed') header.TxnStatus = 'Closed';
    else if (['Pending','Accepted'].includes(record.TxnStatus) && !linkList(record.LinkedTxn).length) { header.TxnStatus = record.TxnStatus; gaps.push('estimate-invoice-conversion-unverified'); }
  }
  if (compiled.entity === 'TimeActivity' && hasChild('Invoice')) {if(record.BillableStatus==='Billable'){header.BillableStatus='Billable';gaps.push('time-invoice-billing-unverified');}else header.BillableStatus='HasBeenBilled';}
  if (compiled.entity === 'PurchaseOrder' && hasChild('Bill')) header.POStatus = 'Closed';
  const accountKey = compiled.entity === 'BillPayment' ? 'APAccountRef' : 'ARAccountRef';
  if (['Invoice','Payment','BillPayment'].includes(compiled.entity) && record[accountKey] === undefined && header[accountKey]) {
    if (verifyAccountPosting({ observed, compiled, receipt, now }) !== header[accountKey].value) invalid('The actual posting account differs.');
    delete header[accountKey];
  }
  if (!subset(header, record)) invalid('Population financial header fields differ.');
  for (const key of ['ClassRef','DepartmentRef','ProjectRef']) if (!payload[key] && record[key]?.value) invalid('An unplanned dimension is present.');
  const expectedLinks = linkList(payload.LinkedTxn), actualLinks = linkList(record.LinkedTxn), permitted = [...expectedLinks, ...childLinks];
  for (const expected of expectedLinks) if (!(missingEstimate && expected.TxnType === 'Estimate') && !actualLinks.some(link => canonical(link) === canonical(expected))) invalid('A required population source link is missing.');
  for (const actual of actualLinks) if (!permitted.some(link => canonical(link) === canonical(actual))) invalid('An unrelated transaction consumes this population record.');
  if (payload.Line) {
    if (!Array.isArray(record.Line) || record.Line.length > 101) invalid('Population financial lines are unavailable.');
    const actual = record.Line.filter(line => line.DetailType !== 'SubTotalLineDetail'), totals = record.Line.filter(line => line.DetailType === 'SubTotalLineDetail'), used = new Set();
    const subtotal = payload.Line.reduce((sum,line) => sum + cents(line.Amount), 0);
    if (actual.length !== payload.Line.length || totals.length > 1 || totals.some(line => line !== record.Line.at(-1) || cents(line.Amount) !== subtotal)) invalid('Population financial line counts or subtotals differ.');
    for (const wanted of payload.Line) {
      const expected = { ...wanted };
      if ((missingEstimate||exactLegacyWholeReference) && expected.LinkedTxn?.every(link => link.TxnType === 'Estimate')) delete expected.LinkedTxn;
      const index = actual.findIndex((line,i) => !used.has(i) && subset(expected,line));
      if (index < 0) invalid('Population amounts, quantities, rates, tax codes or line links differ.');
      used.add(index); const line = actual[index], detail = line[line.DetailType];
      for (const key of ['ClassRef','ProjectRef']) if (!expected[key] && line[key]?.value) invalid('An unplanned financial line dimension is present.');
      if (detail) for (const key of ['CustomerRef','ClassRef','ProjectRef','AccountRef']) if (!expected[expected.DetailType]?.[key] && detail[key]?.value) invalid('An unplanned financial line relationship is present.');
      if (!expected.LinkedTxn && linkList(line.LinkedTxn).length && !exactWholeEstimate && !exactLegacyWholeReference) invalid('An unplanned source line link is present.');
    }
    if (['Estimate','Invoice','SalesReceipt','PurchaseOrder','Bill'].includes(compiled.entity) && (!taxMatches(taxPolicy,compiled,record) || cents(record.TotalAmt) !== subtotal + cents(record.TxnTaxDetail?.TotalTax))) invalid('Population tax or gross amount differs from the approved dated policy.');
    if (compiled.entity === 'Deposit' && cents(record.TotalAmt) !== subtotal) invalid('Deposit total differs.');
    if (compiled.entity === 'Payment' && cents(record.UnappliedAmt) !== 0) invalid('A population payment is not fully applied.');
  } else if (Array.isArray(record.Line) && record.Line.length) invalid('Unexpected financial lines exist.');
  if (record.ExchangeRate !== undefined && record.ExchangeRate !== 1) invalid('The population record has an unexpected exchange rate.');
  if (['Invoice','Bill'].includes(compiled.entity)) {
    const childType=compiled.entity==='Invoice'?'Payment':'BillPayment';let applied=0;
    for(const child of children){if(compiled.entity==='Bill'&&child.entity==='SalesReceipt')continue;if(child.entity!==childType)invalid('An unsupported settlement consumes this population balance.');for(const line of child.settlementLines || []){const links=linkList(line.LinkedTxn);if(links.some(link=>link.TxnType===compiled.entity&&link.TxnId===record.Id)){if(links.length!==1)invalid('The settlement application is ambiguous.');applied+=cents(line.Amount);}}}
    if(cents(record.Balance)!==cents(record.TotalAmt)-applied)invalid('The population balance differs from its exact saved applications.');
  }
  if(compiled.entity==='PurchaseOrder'){
    const seen=new Set();for(const line of record.Line){if(seen.has(line.Id)||!QBO_ID.test(line.Id||''))invalid('Purchase-order line identity is ambiguous.');seen.add(line.Id);let received=0;for(const child of children){if(child.entity!=='Bill')invalid('An unsupported record consumes this purchase order.');for(const issued of child.settlementLines||[]){if(linkList(issued.LinkedTxn).some(link=>link.TxnType==='PurchaseOrder'&&link.TxnId===record.Id&&link.TxnLineId===line.Id))received+=issued.ItemBasedExpenseLineDetail?.Qty || 0;}}
      if(line.Received===undefined?received!==0||children.length!==0||record.POStatus!=='Open':line.Received!==received)invalid('The purchase-order received quantity is not proved.');
    }
  }
  const source = { compiled, receipt, observed, parents, children, taxPolicy };
  const proof = { version: 1, kind: 'population-financial-content', scope, logicalKey: compiled.logicalKey, entity: compiled.entity, fingerprint: compiled.intentHash, qboId: record.Id, syncToken: record.SyncToken, observedHash: observed.recordHash, compilationHash: compiled.compilationHash, observedAt: observed.observedAt, matchesFinancialIntent: true, coverageGaps: gaps, sourceJson: JSON.stringify(source), sourceHash: hash(JSON.stringify(source)) };
  return { ...proof, evidenceHash: hash(proof) };
}
function verifyPopulationFinancialParent(value, now = Date.now()) {
  const proof = value?.financialProof;
  if (value?.state !== 'financially-verified' || proof?.kind !== 'population-financial-content' || proof.matchesFinancialIntent !== true || !fresh(proof.observedAt,now) || proof.observedHash !== value.recordHash || proof.qboId !== value.qboId || proof.syncToken !== value.syncToken || proof.fingerprint !== value.fingerprint || !sameScope(proof.scope,value.scope)) invalid('A fresh exact population financial-parent proof is required.');
  if(typeof proof.sourceJson!=='string'||Buffer.byteLength(proof.sourceJson)>8000000||hash(proof.sourceJson)!==proof.sourceHash)invalid('The retained population source bytes changed.');
  const replayed = verifyPopulationFinancialContent({ ...JSON.parse(proof.sourceJson), now });
  if (canonical(replayed) !== canonical(proof) || hash(value.record) !== proof.observedHash) invalid('The population financial-parent evidence changed.');
  return proof;
}

module.exports = { validateCompilation, verifyBusinessContent, verifyBusinessReadback, listReadbackEvidenceHash, createBusinessReadbackAdapter, verifyPopulationFinancialContent, verifyPopulationFinancialParent };
