'use strict';
const C = require('./bank-settlement-contract');
const { description } = require('./bank-feed-csv');
function need(ok, message) {
  if (!ok) throw Object.assign(new Error(message), {status:409,code:'BANKING_LEDGER_INVALID'});
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// Registration adds only these aliases. Validate any supplied value before deriving it.
function normalizeEventAliases(input, check = need) {
  check(object(input), 'Settlement events must be objects.');
  const event = JSON.parse(JSON.stringify(input));
  check(event.source === undefined || object(event.source), 'Settlement source must be an object.');
  check(event.resolution === undefined || object(event.resolution), 'Settlement resolution must be an object.');
  const creators = {'existing-qbo':'none','api-accountant':'api-accountant','native-add':'native-add'};
  const creator = Object.hasOwn(creators,event.resolution?.designatedCreator) ? creators[event.resolution.designatedCreator] : undefined;
  check(event.resolution?.designatedCreator === undefined || Boolean(creator), 'Unknown BF1 designated creator.');
  const derived = {sourceHash:event.source?.sourceHash,
    expectedResolution:typeof event.resolution?.action === 'string' ? event.resolution.action.toLowerCase() : undefined,creator};
  for (const [key,value] of Object.entries(derived)) if (value !== undefined) {
    check(event[key] === undefined || event[key] === value, 'Settlement alias conflicts with retained BF1 ' + key + '.');
    event[key] = value;
  }
  return event;
}
const FIELDS = [...C.SETTLEMENT_CONTRACT.eventFields,'contractVersion','accountType','evidenceType','kind','direction',
  'postingBasis','timingPolicy','description','sourceHash','expectedResolution','creator'];
const NATIVE_CODES = new Set(['existing-reconciled-mark-requires-native-inspection','report-only-adjustment-requires-native-inspection']);
function nativeWarnings(event) {
  const codes = event.resolution?.nativeActionBlockers === undefined ? [] : event.resolution.nativeActionBlockers;
  need(Array.isArray(codes) && codes.every(code=>NATIVE_CODES.has(code)), 'Unknown or invalid event-level evidence blockers prevent adoption.');
  return codes.map(code=>event.eventId + ': ' + code);
}
function eventMap(events, snapshot) {
  need(Array.isArray(events), 'Retained manifest and snapshot event evidence arrays are required.');
  const result = new Map();
  for (const raw of events) {
    const event = normalizeEventAliases(raw);
    need(typeof event.eventId === 'string' && event.eventId.length > 0 && Number.isSafeInteger(event.revision) && event.revision > 0 && !result.has(event.eventId), 'Missing or duplicate retained event identity/revision.');
    need(event.accountId === snapshot.accountId && event.accountCurrency === snapshot.accountCurrency && C.canonical(event.scope === undefined ? snapshot.scope : event.scope) === C.canonical(snapshot.scope), 'Retained event crosses account/currency/company scope.');
    need(object(event.source) && typeof event.source.entity === 'string' && event.source.entity.length > 0 && typeof event.source.id === 'string' && event.source.id.length > 0 && /^[a-f0-9]{64}$/.test(event.sourceHash || ''), 'Retained event source identity and hash are required.');
    need(event.resolution?.linkedQboIds === undefined || Array.isArray(event.resolution.linkedQboIds), 'Retained event QBO references must be an array.');
    result.set(event.eventId,event);
  }
  return result;
}
function materialEvent(event, scope) {
  const projection = Object.fromEntries(FIELDS.map(field=>[field,event[field]]));
  projection.scope = event.scope === undefined ? scope : event.scope;
  // The sole permitted evidence difference: known native-inspection warnings.
  // Every code is checked separately and the union is retained, never discarded.
  const {nativeActionBlockers,...resolution} = event.resolution || {};
  projection.resolution = resolution;
  return projection;
}
function validateEventEvidence(snapshot, manifest) {
  need(object(snapshot) && object(manifest), 'Retained event evidence is missing.');
  const stored = eventMap(snapshot.events,snapshot), retained = eventMap(manifest.events,snapshot);
  need(stored.size === retained.size, 'Retained manifest event set differs from its package.');
  const warnings = new Set();
  for (const [id,event] of stored) {
    const other = retained.get(id);
    need(other && C.canonical(materialEvent(event,snapshot.scope)) === C.canonical(materialEvent(other,snapshot.scope)), 'Retained manifest event evidence conflicts with its package: ' + id);
    for (const warning of [...nativeWarnings(event),...nativeWarnings(other)]) warnings.add(warning);
  }
  for (const field of ['sourceSnapshotHash','policyVersion','balanceConvention','revision']) if (manifest[field] !== undefined)
    need(manifest[field] === snapshot[field], 'Retained manifest ' + field + ' conflicts with its package.');
  // Producer crosswalks bind each CSV row to full source/link and paired-leg provenance.
  need(Array.isArray(snapshot.rows) && Array.isArray(manifest.crosswalk) && manifest.crosswalk.length === snapshot.rows.length && stored.size === snapshot.rows.length, 'Retained manifest event crosswalk is missing or incomplete.');
  const specs = new Map();
  for (const row of snapshot.rows) {
    need(object(row) && !specs.has(row.eventId), 'Duplicate or malformed stored event crosswalk.');
    specs.set(row.eventId,row);
  }
  const seen = new Set();
  for (const row of manifest.crosswalk) {
    need(object(row) && !seen.has(row.eventId), 'Duplicate or malformed retained event crosswalk.'); seen.add(row.eventId);
    const event = stored.get(row.eventId), spec = specs.get(row.eventId);
    need(event && spec && ['rowId','eventId','eventRevision','fileId','rowNumber'].every(key=>row[key] === spec[key]) && row.eventRevision === event.revision,
      'Retained crosswalk identity/revision conflicts with its package.');
    need(row.qboRefs === undefined || Array.isArray(row.qboRefs), 'Retained crosswalk QBO references must be an array.');
    need(row.amountMinor === event.amountMinor && row.date === (event.actualPostingDate || event.expectedPostingDate) && row.description === description(event) &&
      C.canonical(row.source) === C.canonical(event.source) && C.canonical(row.qboRefs || []) === C.canonical(event.resolution?.linkedQboIds || []) &&
      row.settlementGroupId === event.settlementGroupId && row.pairedEventId === event.pairedEventId,
      'Retained crosswalk financial/source lineage conflicts with its event.');
  }
  return [...warnings].sort();
}
module.exports = {normalizeEventAliases,validateEventEvidence};
