'use strict';
const { hash, canonical } = require('./business-calendar');
const { freezeWriteRequest, scoped } = require('./qbo-write-contract');
const { SUPPORTED } = require('./business-transaction-compiler');
const HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
function invalid(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_READBACK_UNVERIFIED' }); }
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => a?.[key] === b?.[key]);
function fresh(stamp, now) { const value = typeof stamp === 'string' ? Date.parse(stamp) : NaN; return Number.isFinite(value) && new Date(value).toISOString() === stamp && value <= now && now - value <= 300000; }
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
  return request;
}
function linkList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) invalid('Saved transaction links are malformed.');
  return value.map(link => {
    if (!link || typeof link.TxnId !== 'string' || !QBO_ID.test(link.TxnId) || !SUPPORTED.has(link.TxnType) || (link.TxnLineId !== undefined && (typeof link.TxnLineId !== 'string' || !QBO_ID.test(link.TxnLineId)))) invalid('A saved transaction link is invalid.');
    return { TxnId: link.TxnId, TxnType: link.TxnType, ...(link.TxnLineId && link.TxnLineId !== '0' ? { TxnLineId: link.TxnLineId } : {}) };
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
  if (!receipt || receipt.version !== 1 || !sameScope(receipt.scope, scope) || receipt.entity !== compiled.entity || receipt.logicalKey !== compiled.logicalKey || receipt.requestHash !== request.requestHash || typeof receipt.qboId !== 'string' || !QBO_ID.test(receipt.qboId) || !HASH.test(receipt.dispatchKey || '') || !HASH.test(receipt.evidenceHash || '') || !['create-response', 'request-correlated-readback'].includes(receipt.source)) invalid('The exact saved creation receipt is required.');
  const record = checkedObservation(observed, scope, compiled.entity, receipt.qboId, now), payload = JSON.parse(request.body), issues = [];
  const mismatch = message => { if (!issues.includes(message)) issues.push(message); };
  if (!Array.isArray(parents) || parents.length !== compiled.relationships.length || !Array.isArray(descendants) || descendants.length > 1000) invalid('Complete relationship observations are required.');
  const relationships = compiled.relationships.map(expected => {
    const found = parents.filter(value => value.logicalKey === expected.logicalKey);
    if (found.length !== 1 || !['saved', 'verified'].includes(found[0].state) || found[0].fingerprint !== expected.fingerprint) invalid('An originating activity is not freshly verified.');
    const parent = checkedObservation(found[0], scope, expected.entity, expected.qboId, now);
    return { logicalKey: expected.logicalKey, entity: expected.entity, fingerprint: expected.fingerprint, qboId: parent.Id, syncToken: parent.SyncToken };
  });
  const childKeys = new Set(), childIds = new Set(), childLinks = [];
  for (const child of descendants) {
    if (!child || !HASH.test(child.logicalKey || '') || childKeys.has(child.logicalKey) || !HASH.test(child.fingerprint || '') || !['saved', 'verified'].includes(child.state) || !SUPPORTED.has(child.entity) || !child.creationReceipt || !HASH.test(child.creationReceipt.evidenceHash || '') || child.creationReceipt.qboId !== child.record?.Id) invalid('A downstream activity lacks its managed creation evidence.');
    const physicalKey = child.entity + ':' + child.record?.Id;
    if (childIds.has(physicalKey) || (child.entity === compiled.entity && child.record?.Id === record.Id)) invalid('A downstream saved record is duplicated.');
    childIds.add(physicalKey);
    const childReceipt = child.creationReceipt;
    if (childReceipt.version !== 1 || !sameScope(childReceipt.scope, scope) || childReceipt.entity !== child.entity || childReceipt.logicalKey !== child.logicalKey || !HASH.test(childReceipt.requestHash || '') || !HASH.test(childReceipt.dispatchKey || '') || !['create-response', 'request-correlated-readback'].includes(childReceipt.source)) invalid('The downstream creation receipt has a different identity.');
    if (!HASH.test(child.compilationHash || '') || child.verification?.compilationHash !== child.compilationHash) invalid('The downstream proof is not bound to its dispatched compilation.');
    childKeys.add(child.logicalKey); verifiedObservation(child, scope, child.entity, childReceipt.qboId, now, 'business-content');
    const origin = child.verification.relationships?.filter(link => link.logicalKey === compiled.logicalKey);
    if (!origin || origin.length !== 1 || origin[0].entity !== compiled.entity || origin[0].fingerprint !== compiled.intentHash || origin[0].qboId !== record.Id || origin[0].syncToken !== record.SyncToken) invalid('The downstream content proof names a different originating intent or version.');
    const linked = [...linkList(child.record.LinkedTxn), ...(child.record.Line || []).flatMap(line => linkList(line.LinkedTxn))];
    if (!linked.some(link => link.TxnType === compiled.entity && link.TxnId === receipt.qboId)) invalid('A downstream record does not point back to this saved activity.');
    for (const link of linked.filter(value => value.TxnType === compiled.entity && value.TxnId === record.Id && value.TxnLineId)) {
      if (!Array.isArray(record.Line) || record.Line.filter(line => line.Id === link.TxnLineId && line.DetailType !== 'SubTotalLineDetail').length !== 1) invalid('A downstream line points to a missing or ambiguous originating line.');
    }
    childLinks.push({ TxnId: child.record.Id, TxnType: child.entity });
  }
  const expectedHeader = { ...payload }; delete expectedHeader.Line; delete expectedHeader.LinkedTxn;
  if (compiled.entity === 'TimeActivity' && record.BillableStatus === 'HasBeenBilled' && descendants.some(value => value.entity === 'Invoice')) expectedHeader.BillableStatus = 'HasBeenBilled';
  if (!subset(expectedHeader, record)) mismatch('Saved header fields differ from the requested transaction.');
  for (const key of ['ClassRef', 'DepartmentRef', 'ProjectRef']) if (!payload[key] && record[key]?.value) mismatch('An unplanned transaction dimension is present.');
  const permittedTop = [...linkList(payload.LinkedTxn), ...childLinks], actualTop = linkList(record.LinkedTxn);
  for (const expected of linkList(payload.LinkedTxn)) if (!actualTop.some(value => canonical(value) === canonical(expected))) mismatch('An originating transaction link is missing.');
  for (const actual of actualTop) if (!permittedTop.some(value => value.TxnType === actual.TxnType && value.TxnId === actual.TxnId && (value.TxnLineId || null) === (actual.TxnLineId || null))) mismatch('An unplanned transaction link is present.');
  if (payload.Line) {
    if (!Array.isArray(record.Line) || record.Line.length > 101) invalid('Saved transaction lines are unavailable.');
    const expectedLines = payload.Line, actualLines = record.Line.filter(line => line.DetailType !== 'SubTotalLineDetail'), subtotals = record.Line.filter(line => line.DetailType === 'SubTotalLineDetail');
    const beforeTax = expectedLines.reduce((sum, line) => sum + cents(line.Amount), 0);
    if (subtotals.length > 1 || subtotals.some(line => record.Line.at(-1) !== line || cents(line.Amount) !== beforeTax || !['Estimate', 'Invoice', 'SalesReceipt'].includes(compiled.entity))) mismatch('Unexpected subtotal lines were saved.');
    const used = new Set();
    if (actualLines.length !== expectedLines.length) mismatch('The saved financial line count differs.');
    for (const expected of expectedLines) {
      const index = actualLines.findIndex((actual, index) => !used.has(index) && subset(expected, actual));
      if (index < 0) { mismatch('Saved line amounts, quantities, tax codes or source links differ.'); continue; }
      used.add(index); const actual = actualLines[index], detail = actual[actual.DetailType];
      for (const key of ['ClassRef', 'ProjectRef']) if (!expected[key] && actual[key]?.value) mismatch('An unplanned line dimension is present.');
      if (detail) for (const key of ['CustomerRef', 'ClassRef', 'ProjectRef', 'AccountRef']) if (!expected[expected.DetailType]?.[key] && detail[key]?.value) mismatch('An unplanned line relationship is present.');
      if (!expected.LinkedTxn && linkList(actual.LinkedTxn).length) mismatch('An unplanned line transaction link is present.');
    }
    if (['Estimate', 'Invoice', 'SalesReceipt', 'PurchaseOrder', 'Bill'].includes(compiled.entity)) {
      if (!taxMatches(taxPolicy, compiled, record)) mismatch('Approved tax amounts and rates remain unverified.');
      if (cents(record.TotalAmt) !== beforeTax + cents(record.TxnTaxDetail?.TotalTax)) mismatch('The saved total does not equal item amounts plus tax.');
    } else if (compiled.entity === 'Deposit' && cents(record.TotalAmt) !== beforeTax) mismatch('The saved deposit total differs from its linked receipt.');
    if (compiled.entity === 'Payment' && cents(record.UnappliedAmt) !== 0) mismatch('The payment is not fully applied to its invoice.');
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
      if (typeof line.Received !== 'number' || !Number.isFinite(line.Received) || Math.abs(line.Received - consumed) > 0.0000001 || consumed > quantity) mismatch('The purchase order API consumed quantity differs from its saved bill lines.');
      if (consumed !== quantity) fullyReceived = false;
    }
    if (record.POStatus !== (fullyReceived ? 'Closed' : 'Open')) mismatch('The purchase order status differs from its verified consumption.');
  }
  const oldest = [observed, ...parents, ...descendants, ...descendants.map(value => value.verification)].map(value => value.observedAt).sort()[0];
  return { version: 1, kind: 'business-content', compilationHash: compiled.compilationHash, scope, logicalKey: compiled.logicalKey, entity: compiled.entity, qboId: record.Id, fingerprint: compiled.intentHash, matchesIntent: issues.length === 0, issues,
    syncToken: record.SyncToken, observedAt: oldest, observedHash: observed.recordHash,
    evidenceHash: hash({ requestHash: request.requestHash, compilationHash: compiled.compilationHash, taxPolicy: taxPolicy?.evidenceHash || null, receipt: receipt.evidenceHash, recordHash: observed.recordHash, parents: parents.map(value => ({ logicalKey: value.logicalKey, recordHash: value.recordHash })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)), descendants: descendants.map(value => ({ logicalKey: value.logicalKey, recordHash: value.recordHash })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) }), relationships };
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
module.exports = { validateCompilation, verifyBusinessContent, verifyBusinessReadback, createBusinessReadbackAdapter };
