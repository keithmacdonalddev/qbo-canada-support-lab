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
  const byId = new Map((Array.isArray(response) ? response : []).map(row => [String(row?.bId), row]));
  const items = batch.items.map(item => {
    const row = byId.get(String(item.bId));
    if (!row) return { ref: item.ref, bId: item.bId, outcome: 'unknown', next: correlation(item) ? { action: 'read-back', by: correlation(item) } : { action: 'unresolved', reason: 'No reliable correlation; the barrier holds until the record is attributed.' } };
    const errors = row.Fault?.Error || [];
    if (errors.length) {
      const stale = errors.some(error => String(error?.code) === STALE);
      return { ref: item.ref, bId: item.bId, outcome: 'fault', fault: errors.map(error => ({ code: String(error?.code ?? ''), message: String(error?.Message ?? error?.message ?? ''), detail: String(error?.Detail ?? '') })), next: stale ? { action: 'refresh-and-new-attempt', reason: 'Stale SyncToken: read the record once, rerun its guards, then a new attempt with a new requestid.' } : { action: 'correct', reason: 'Return the fault to the model; a corrected item is a new attempt.' } };
    }
    const entity = Object.keys(row).find(key => !['bId', 'Fault', 'time'].includes(key));
    if (item.op === 'delete') return { ref: item.ref, bId: item.bId, outcome: 'deleted', record: row[entity] || null };
    return { ref: item.ref, bId: item.bId, outcome: entity === item.entity ? 'saved' : 'unknown', record: row[entity] || null, ...(entity === item.entity ? {} : { next: { action: 'unresolved', reason: 'The response carried another entity type.' } }) };
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
module.exports = { itemOutcomes, blockedRefs, correlation, STALE };
