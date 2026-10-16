'use strict';
// Report hierarchies have a separate bounded JSON domain. Do not widen the
// immutable blueprint/calendar serializer to accommodate external report trees.
const MAX_REPORT_BYTES = 6000000, MAX_COLLECTION_BYTES = 12004096;
const MAX_DEPTH = 128, MAX_NODES = 1000000;
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_REPORT_UNVERIFIED' }); }
function canonicalReport(value) {
  let bytes = 0, nodes = 0;
  const chunks = [], active = new WeakSet();
  const emit = text => { bytes += Buffer.byteLength(text, 'utf8'); if (bytes > MAX_REPORT_BYTES) fail('Report JSON exceeds its supported byte budget.'); chunks.push(text); };
  function visit(item, depth) {
    if (depth > MAX_DEPTH) fail('Report JSON exceeds its supported nesting depth.');
    if (++nodes > MAX_NODES) fail('Report JSON exceeds its supported node budget.');
    if (item === null || ['boolean', 'string'].includes(typeof item)) { emit(JSON.stringify(item)); return; }
    if (typeof item === 'number' && Number.isFinite(item)) { emit(JSON.stringify(item)); return; }
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== (Array.isArray(item) ? Array.prototype : Object.prototype)) fail('Report values must be plain JSON.');
    if (active.has(item)) fail('Report JSON cannot contain cycles.');
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const keys = Reflect.ownKeys(item);
        if (keys.length !== item.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) fail('Report arrays must be dense JSON arrays without extra properties.');
        emit('[');
        for (let index = 0; index < item.length; index++) {
          const entry = Object.getOwnPropertyDescriptor(item, String(index));
          if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value')) fail('Report arrays must contain ordinary JSON values.');
          if (index) emit(','); visit(entry.value, depth + 1);
        }
        emit(']');
      } else {
        const keys = Reflect.ownKeys(item);
        if (keys.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))) fail('Report JSON contains an unsupported key.');
        keys.sort(); emit('{');
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index], entry = Object.getOwnPropertyDescriptor(item, key);
          if (!entry.enumerable || !Object.hasOwn(entry, 'value')) fail('Report objects must contain ordinary JSON values.');
          if (index) emit(','); emit(JSON.stringify(key)); emit(':'); visit(entry.value, depth + 1);
        }
        emit('}');
      }
    } finally { active.delete(item); }
  }
  visit(value, 0);
  return chunks.join('');
}
// Comparison must preserve each accepted report's own structural budget. An
// outer map must not consume one level or combine seven per-report node limits.
function canonicalReportCollection(reports) {
  if (!reports || Object.getPrototypeOf(reports) !== Object.prototype) fail('A report collection must be a plain map.');
  const names = Reflect.ownKeys(reports);
  if (!names.length || names.length > 7 || names.some(name => typeof name !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(name))) fail('A report collection needs at most seven named reports.');
  names.sort(); const chunks = ['{']; let bytes = 2;
  for (let index = 0; index < names.length; index++) {
    const name = names[index], entry = Object.getOwnPropertyDescriptor(reports, name);
    if (!entry.enumerable || !Object.hasOwn(entry, 'value')) fail('Report collections must contain ordinary JSON values.');
    const text = (index ? ',' : '') + JSON.stringify(name) + ':' + canonicalReport(entry.value);
    bytes += Buffer.byteLength(text, 'utf8'); if (bytes > MAX_COLLECTION_BYTES) fail('The report collection exceeds its supported byte budget.');
    chunks.push(text);
  }
  chunks.push('}'); return chunks.join('');
}
module.exports = { canonicalReport, canonicalReportCollection, MAX_REPORT_BYTES, MAX_COLLECTION_BYTES, MAX_DEPTH, MAX_NODES };
