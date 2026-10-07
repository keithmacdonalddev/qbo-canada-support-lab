'use strict';
const { hash } = require('../../src/modules/business-calendar');
const { verifyBusinessContent, verifyBusinessReadback } = require('../../src/modules/business-readback');
const { fixture, scope, now, clone } = require('./business-transaction-fixtures');
const ENTITIES = ['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment'];
function sample(entity = 'Invoice', configure = () => {}) {
  const f = fixture(entity); configure(f); f.refresh(); f.approve(); const compiled = f.compile();
  const record = { ...JSON.parse(compiled.request.body), Id: '2000', SyncToken: '0', DocNumber: 'provider-number' };
  if (record.Line) record.Line.forEach((line, i) => { line.Id = String(i + 1); });
  let taxPolicy = null;
  if (['Estimate', 'Invoice', 'SalesReceipt', 'PurchaseOrder', 'Bill'].includes(entity)) {
    const base = record.Line.reduce((sum, line) => sum + Math.round(line.Amount * 100), 0), tax = Math.round(base * 0.13);
    record.TxnTaxDetail = { TotalTax: tax / 100, TaxLine: [{ Amount: tax / 100, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '950' }, PercentBased: true, TaxPercent: 13, NetAmountTaxable: base / 100 } }] };
    record.TotalAmt = (base + tax) / 100;
    taxPolicy = { version: 1, status: 'approved', scope, compilationHash: compiled.compilationHash, evidenceHash: hash('approved exact tax'), totalTaxCents: tax, lines: [{ rateId: '950', percent: 13, taxableCents: base, amountCents: tax }] };
  }
  if (['Invoice', 'Bill'].includes(entity)) record.Balance = record.TotalAmt;
  if (entity === 'PurchaseOrder') { record.POStatus = 'Open'; record.Line.forEach(line => { line.Received = 0; }); }
  if (entity === 'Payment') record.UnappliedAmt = 0;
  if (entity === 'Deposit') record.TotalAmt = record.Line.reduce((sum, line) => sum + line.Amount, 0);
  const h = { intent: { step: clone(f.step), policy: clone(f.policy) }, compiled, receipt: { version: 1, scope, entity, logicalKey: compiled.logicalKey, requestHash: compiled.request.requestHash, dispatchKey: hash('dispatch ' + entity), qboId: record.Id, evidenceHash: hash('create ' + entity), source: 'create-response' },
    observed: { scope, entity, observedAt: new Date(now).toISOString(), record, recordHash: hash(record) }, parents: clone(f.parents), descendants: [], taxPolicy, now };
  h.refresh = () => { h.observed.recordHash = hash(record); };
  h.verifyParents = () => { for (const parent of h.parents) parent.verification = { version: 1, kind: 'business-readback', scope, entity: parent.entity, logicalKey: parent.logicalKey, qboId: parent.record.Id, fingerprint: parent.fingerprint, matchesIntent: true, observedHash: parent.recordHash, syncToken: parent.record.SyncToken, observedAt: parent.observedAt, evidenceHash: hash('verified parent ' + parent.logicalKey) }; };
  h.verifyParents(); h.check = () => verifyBusinessReadback(h); h.content = () => verifyBusinessContent(h); return h;
}
function bindParent(f, index, target) {
  const parent = f.parents[index], previous = parent.logicalKey;
  parent.logicalKey = target.compiled.logicalKey; parent.fingerprint = target.compiled.intentHash; parent.qboId = target.observed.record.Id; parent.record.Id = parent.qboId; parent.record.SyncToken = target.observed.record.SyncToken; parent.syncToken = parent.record.SyncToken;
  Object.assign(f.step.dependencies.find(link => link.logicalKey === previous), { logicalKey: parent.logicalKey, fingerprint: parent.fingerprint });
  f.step.details.references.find(link => link.logicalKey === previous).logicalKey = parent.logicalKey;
  if (f.step.details.amountSourceKey === previous) f.step.details.amountSourceKey = parent.logicalKey;
}
function descendant(child) { return { ...child.observed, logicalKey: child.compiled.logicalKey, fingerprint: child.compiled.intentHash, compilationHash: child.compiled.compilationHash, state: 'saved', creationReceipt: child.receipt, verification: child.content() }; }

module.exports = { sample, bindParent, descendant, ENTITIES, scope, now, clone };
