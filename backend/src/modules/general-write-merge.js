'use strict';
// One version-aware merge decision for the synced company copy, shared by write responses
// and change-data-capture reads (general-write-v1, design rev 3, R1-7 and R2-3). Pure.
//
// A whole mirror row is replaced only by a COMPLETE effective entity. A sparse response
// (for example only Id, SyncToken and the changed fields of a sparse update) never
// replaces a full record: the caller reads it once instead. Versions: a higher SyncToken
// or a later LastUpdatedTime wins. An equal version replaces a row only when that row was
// marked stale by a child write and the incoming entity was read after the invalidation
// (a settlement can change an invoice's balance without changing its token or timestamp).
const { ENTITIES } = require('./qbo-entity-schema');
// Fields a complete entity of each kind carries.
const COMPLETE = Object.freeze({
  transaction: ['Id', 'SyncToken', 'TxnDate', 'MetaData'], list: ['Id', 'SyncToken', 'MetaData'], attachment: ['Id', 'SyncToken', 'MetaData'], settings: ['Id', 'SyncToken'],
});
// Transaction fields whose absence means a sparse response.
const TRANSACTION_BODY = { Transfer: ['Amount', 'FromAccountRef', 'ToAccountRef'], TimeActivity: ['NameOf'], default: ['Line'] };
const LIST_BODY = { Customer: ['DisplayName'], Vendor: ['DisplayName'], Employee: ['DisplayName'], Item: ['Name', 'Type'], Account: ['Name', 'AccountType'], Class: ['Name'], Department: ['Name'], Term: ['Name'], PaymentMethod: ['Name'] };
function isComplete(entity, record, requested = null) {
  const spec = ENTITIES[entity];
  if (!spec || !record || typeof record !== 'object') return false;
  const fields = [...(COMPLETE[spec.kind] || COMPLETE.list), ...(spec.kind === 'transaction' ? (TRANSACTION_BODY[entity] || TRANSACTION_BODY.default) : spec.kind === 'list' ? (LIST_BODY[entity] || []) : [])];
  if (fields.some(key => record[key] === undefined)) return false;
  if (spec.kind === 'transaction' && ['Invoice', 'Bill', 'SalesReceipt', 'CreditMemo', 'RefundReceipt', 'VendorCredit', 'Purchase', 'Payment', 'BillPayment', 'Deposit', 'Estimate', 'PurchaseOrder', 'JournalEntry'].includes(entity) && !Array.isArray(record.Line)) return false;
  // Every requested top-level field must be present (its value is checked by read-back).
  if (requested && Object.keys(requested).some(key => record[key] === undefined)) return false;
  return true;
}
const token = record => /^\d+$/.test(String(record?.SyncToken ?? '')) ? BigInt(record.SyncToken) : null;
const updated = record => { const value = Date.parse(record?.MetaData?.LastUpdatedTime || ''); return Number.isFinite(value) ? value : null; };
// current: the mirror row ({ record, staleSince? } or null); incoming: { record, readStartedAt,
// deleted?, requested? }. Returns { action: 'replace' | 'tombstone' | 'keep' | 'fetch', reason }.
function mergeDecision(entity, current, incoming) {
  if (incoming.deleted === true) return { action: 'tombstone', reason: 'QuickBooks reported the record deleted.' };
  if (!isComplete(entity, incoming.record, incoming.requested)) return { action: 'fetch', reason: 'The response is not a complete ' + entity + '; read it once before replacing the copy.' };
  if (!current?.record) return { action: 'replace', reason: 'New record.' };
  if (String(current.record.Id) !== String(incoming.record.Id)) throw new TypeError('A merge compares one record id.');
  const have = token(current.record), got = token(incoming.record);
  if (have !== null && got !== null && got !== have) return got > have ? { action: 'replace', reason: 'Higher SyncToken.' } : { action: 'keep', reason: 'Older SyncToken.' };
  const a = updated(current.record), b = updated(incoming.record);
  if (a !== null && b !== null && a !== b) return b > a ? { action: 'replace', reason: 'Later LastUpdatedTime.' } : { action: 'keep', reason: 'Earlier LastUpdatedTime.' };
  // Same version: only a stale row is refreshed, and only by a read that began after the
  // invalidation. Otherwise the copy keeps what it has.
  const stale = Date.parse(current.staleSince || ''), read = Date.parse(incoming.readStartedAt || '');
  if (Number.isFinite(stale) && Number.isFinite(read) && read > stale) return { action: 'replace', reason: 'Equal version, read after the record was invalidated by a child write.' };
  return { action: 'keep', reason: 'Same version.' };
}
// Records a child write invalidates (their balance and backlinks change without their
// own version necessarily changing): every record linked before or after the change.
function invalidatedParents(before, after) {
  const links = record => [...(record?.LinkedTxn || []), ...(Array.isArray(record?.Line) ? record.Line : []).flatMap(line => line?.LinkedTxn || [])];
  return [...new Set([...links(before), ...links(after)].filter(link => link?.TxnId != null && typeof link.TxnId !== 'object').map(link => (link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType) + ':' + String(link.TxnId)))].sort();
}
module.exports = { isComplete, mergeDecision, invalidatedParents };
