'use strict';
const { hash, canonical } = require('./business-calendar');
const HASH = /^[a-f0-9]{64}$/;
const sameScope = (a,b) => ['environment','realmId','connectionId'].every(key => a?.[key] === b?.[key]);
function fail() { throw Object.assign(new Error('The omitted purchase-order quantity needs current complete unreceived graph proof.'), { status:409, code:'BUSINESS_TRANSACTION_UNVERIFIED' }); }
const fresh = (value,now) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) <= now && now-Date.parse(value) <= 300000;
function unreceivedLines(record) {
  const empty = links => links === undefined || (Array.isArray(links) && links.length === 0);
  if (record?.POStatus !== 'Open' || !empty(record.LinkedTxn) || !Array.isArray(record.Line) || !record.Line.length || record.Line.length > 100) fail();
  const ids = new Set();
  return record.Line.map(line => {
    const qty = line.ItemBasedExpenseLineDetail?.Qty;
    if (line.DetailType !== 'ItemBasedExpenseLineDetail' || !/^\d{1,30}$/.test(line.Id || '') || ids.has(line.Id) || !empty(line.LinkedTxn) || ![undefined,0].includes(line.Received) || typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) fail();
    ids.add(line.Id); return { lineId:line.Id, quantity:qty, received:0, basis:line.Received === undefined ? 'complete-graph-unreceived' : 'provider-reported' };
  }).sort((a,b)=>a.lineId.localeCompare(b.lineId));
}
// Called only after full content/receipt and complete descendant graph validation.
function createUnreceivedProof({compiled,receipt,observed,descendants}) {
  if (compiled.entity !== 'PurchaseOrder' || descendants.length !== 0) fail();
  const proof = {version:1,kind:'unreceived-purchase-order',scope:observed.scope,logicalKey:compiled.logicalKey,fingerprint:compiled.intentHash,qboId:observed.record.Id,syncToken:observed.record.SyncToken,recordHash:observed.recordHash,compilationHash:compiled.compilationHash,receiptHash:receipt.evidenceHash,observedAt:observed.observedAt,lines:unreceivedLines(observed.record)};
  return {...proof,evidenceHash:hash(proof)};
}
function verifyUnreceivedProof(value,now) {
  const verification=value.verification, proof=verification?.purchaseOrderConsumption;
  if (!proof || proof.version !== 1 || proof.kind !== 'unreceived-purchase-order' || !sameScope(proof.scope,value.scope) || proof.logicalKey !== value.logicalKey || proof.fingerprint !== value.fingerprint || proof.qboId !== value.record?.Id || proof.syncToken !== value.record.SyncToken || proof.recordHash !== value.recordHash || proof.recordHash !== hash(value.record) || !fresh(proof.observedAt,now) || !HASH.test(proof.receiptHash || '') || verification.version !== 1 || verification.kind !== 'business-readback' || !fresh(verification.observedAt,now) || verification.compilationHash !== proof.compilationHash || !HASH.test(proof.compilationHash || '') || verification.observedHash !== proof.recordHash || verification.syncToken !== proof.syncToken || !HASH.test(verification.evidenceHash || '') || !HASH.test(proof.evidenceHash || '')) fail();
  const {evidenceHash,...original}=proof;
  if (hash(original) !== evidenceHash || canonical(proof.lines) !== canonical(unreceivedLines(value.record))) fail();
  return true;
}
module.exports={createUnreceivedProof,verifyUnreceivedProof};
