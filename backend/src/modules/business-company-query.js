'use strict';
// Search and analysis over the app's private synced copy of the company (CompanySyncRecord),
// for the accountant's queryCompanyData tool. No QuickBooks request is made.
// Safe by construction: requests are a fixed vocabulary (whitelisted operators, validated
// field paths, no Mongo operators or pipeline stages from the caller); the company scope and
// deleted:false are always applied server side; every read has a Mongo time limit, a wall-clock
// deadline and a scan cap; output is bounded by rows and bytes.
const { createHash } = require('node:crypto');
const { ENTITIES } = require('./business-agent-sync');

const OPS = Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'startsWith', 'exists']);
const METRICS = Object.freeze(['count', 'sum', 'avg', 'min', 'max', 'countDistinct']);
const PERIODS = Object.freeze(['day', 'week', 'month', 'quarter', 'year']);
// Derived per-record fields. _paidDate/_daysToPay/_daysLate read Payment (for invoices) or
// BillPayment (for bills) links from the mirror; _ageDays/_daysLate use asOf.
const DERIVED = Object.freeze(['_entity', '_paidDate', '_daysToPay', '_daysLate', '_ageDays']);
const PAYMENT_DERIVED = new Set(['_paidDate', '_daysToPay', '_daysLate']);
const SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/, DAY = /^\d{4}-\d{2}-\d{2}$/, MOMENT = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
const LIMITS = Object.freeze({ rows: 200, bytes: 30000, rowBytes: 8000, groups: 200, roots: 25, nodes: 100, depth: 3, docs: 25000, rowsScanned: 80000, timeMs: 8000 });
const DEFAULT_FIELDS = Object.freeze(['DocNumber', 'TxnDate', 'DueDate', 'DisplayName', 'Name', 'CustomerRef.name', 'VendorRef.name', 'EntityRef.name', 'TotalAmt', 'Balance', 'Active', 'TxnStatus']);
// QBO LinkedTxn.TxnType values that name a mirrored entity differently.
const LINK_TYPES = Object.freeze({ BillPaymentCheck: 'BillPayment', BillPaymentCreditCard: 'BillPayment', ReceivePayment: 'Payment', Check: 'Purchase', Expense: 'Purchase', CreditCardCharge: 'Purchase', CreditCardCredit: 'Purchase' });
const TRANSACTIONS = Object.freeze(['Invoice', 'Bill', 'Payment', 'BillPayment', 'Estimate', 'PurchaseOrder', 'SalesReceipt', 'CreditMemo', 'VendorCredit', 'RefundReceipt', 'Purchase', 'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity']);

const problem = (message, status = 400) => Object.assign(new Error(message), { status, code: 'BUSINESS_QUERY_REJECTED' });
const own = (value, key) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key);
const round = value => Math.round(value * 10000) / 10000;
const linkEntity = type => LINK_TYPES[type] || (ENTITIES.includes(type) ? type : null);
const dayMs = value => Date.parse(String(value).slice(0, 10) + 'T00:00:00Z');
const daysBetween = (from, to) => from && to && Number.isFinite(dayMs(from)) && Number.isFinite(dayMs(to)) ? Math.round((dayMs(to) - dayMs(from)) / 86400000) : null;

function fieldPath(path, label) {
  if (typeof path !== 'string' || !path.length || path.length > 200) throw problem(label + ' must name a field.');
  if (DERIVED.includes(path)) return path;
  const parts = path.split('.');
  if (parts.length > 8 || parts.some(part => !SEGMENT.test(part))) throw problem(label + ' "' + path.slice(0, 80) + '" is not a supported field path (letters, digits and underscores separated by dots; derived fields: ' + DERIVED.join(', ') + ').');
  return path;
}
// Every value at a path, traversing arrays at any level (Mongo-style); own properties only.
function pick(value, parts) {
  if (!parts.length) return value;
  if (Array.isArray(value)) { const out = value.map(item => pick(item, parts)).filter(item => item !== undefined); return out.length ? out.flat() : undefined; }
  return own(value, parts[0]) ? pick(value[parts[0]], parts.slice(1)) : undefined;
}
function leaves(value) { return value === undefined ? [] : Array.isArray(value) ? value.flatMap(leaves) : [value]; }

function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    if (MOMENT.test(a) && MOMENT.test(b) && (a.length > 10 || b.length > 10)) return Date.parse(a.length === 10 ? a + 'T00:00:00Z' : a) - Date.parse(b.length === 10 ? b + 'T00:00:00Z' : b);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // A numeric string (QBO ids, amounts) compares with a number numerically.
  const x = typeof a === 'string' && a.trim() !== '' ? Number(a) : a, y = typeof b === 'string' && b.trim() !== '' ? Number(b) : b;
  if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return null;
}
const same = (a, b) => a === b || compare(a, b) === 0;
function test(values, condition) {
  const { op } = condition, value = condition.value;
  switch (op) {
    case 'exists': return (value === false) !== (values.length > 0);
    case 'ne': return !values.some(item => same(item, value));
    case 'nin': return !values.some(item => condition.values.some(other => same(item, other)));
    case 'in': return values.some(item => condition.values.some(other => same(item, other)));
    case 'eq': return values.some(item => same(item, value));
    case 'contains': case 'startsWith': { const needle = String(value).toLowerCase(); return values.some(item => typeof item === 'string' && (op === 'contains' ? item.toLowerCase().includes(needle) : item.toLowerCase().startsWith(needle))); }
    default: return values.some(item => { const order = compare(item, value); return order !== null && (op === 'gt' ? order > 0 : op === 'gte' ? order >= 0 : op === 'lt' ? order < 0 : order <= 0); });
  }
}
function normalizeCondition(condition, label, nested) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw problem(label + ' must be a condition.');
  if (own(condition, 'anyOf')) {
    if (nested || Object.keys(condition).length !== 1 || !Array.isArray(condition.anyOf) || !condition.anyOf.length || condition.anyOf.length > 10) throw problem(label + '.anyOf must hold 1–10 plain conditions and nothing else (one level only).');
    return { anyOf: condition.anyOf.map((item, index) => normalizeCondition(item, label + '.anyOf[' + index + ']', true)) };
  }
  const field = fieldPath(condition.field, label + '.field');
  if (!OPS.includes(condition.op)) throw problem(label + '.op must be one of ' + OPS.join(', ') + '.');
  const scalar = item => item === null || ['string', 'number', 'boolean'].includes(typeof item) && (typeof item !== 'string' || item.length <= 200) && (typeof item !== 'number' || Number.isFinite(item));
  if (['in', 'nin'].includes(condition.op)) {
    if (!Array.isArray(condition.values) || !condition.values.length || condition.values.length > 100 || !condition.values.every(scalar)) throw problem(label + '.values must list 1–100 values for ' + condition.op + '.');
    return { field, op: condition.op, values: condition.values };
  }
  if (condition.op === 'exists') { if (condition.value !== undefined && typeof condition.value !== 'boolean') throw problem(label + '.value must be true or false for exists.'); return { field, op: 'exists', value: condition.value !== false }; }
  if (!own(condition, 'value') || !scalar(condition.value) || (['contains', 'startsWith'].includes(condition.op) && typeof condition.value !== 'string')) throw problem(label + '.value must be a single text, number, true/false or null value.');
  return { field, op: condition.op, value: condition.value };
}
function period(value, unit) {
  if (typeof value !== 'string' || !DAY.test(value.slice(0, 10))) return null;
  const day = value.slice(0, 10);
  if (unit === 'day') return day;
  if (unit === 'month') return day.slice(0, 7);
  if (unit === 'year') return day.slice(0, 4);
  if (unit === 'quarter') return day.slice(0, 4) + '-Q' + (Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1);
  const at = new Date(dayMs(day)), back = (at.getUTCDay() + 6) % 7; // weeks start on Monday
  return new Date(at.getTime() - back * 86400000).toISOString().slice(0, 10);
}
const AGING = Object.freeze(['current', '1-30', '31-60', '61-90', 'over-90', 'no-date']);
function aging(value, asOf) {
  const days = typeof value === 'string' ? daysBetween(value, asOf) : null;
  return days === null ? 'no-date' : days <= 0 ? 'current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : 'over-90';
}

// The request in a fixed shape; anything else is rejected before a read starts.
function normalize(input, { allowedEntities = null } = {}) {
  if (!input || typeof input !== 'object') throw problem('A query is required.');
  const mode = input.mode;
  if (!['find', 'aggregate', 'links'].includes(mode)) throw problem('mode must be find, aggregate or links.');
  const entities = Array.isArray(input.entities) ? [...new Set(input.entities)] : [];
  if (!entities.length || entities.length > ENTITIES.length || entities.some(entity => !ENTITIES.includes(entity))) throw problem('entities must list mirrored record types: ' + ENTITIES.join(', ') + '.');
  if (allowedEntities && entities.some(entity => !allowedEntities.includes(entity))) throw problem('This record type belongs to another specialist responsibility.', 403);
  if (input.where !== undefined && !Array.isArray(input.where)) throw problem('where must be a list of conditions.');
  const where = (input.where || []).map((condition, index) => normalizeCondition(condition, 'where[' + index + ']', false));
  if (where.length > 20) throw problem('Use at most 20 conditions.');
  const asOf = input.asOf === undefined ? null : input.asOf;
  if (asOf !== null && (typeof asOf !== 'string' || !DAY.test(asOf))) throw problem('asOf must be a YYYY-MM-DD date.');
  const unwind = input.unwind === undefined ? null : fieldPath(input.unwind, 'unwind');
  if (unwind && (DERIVED.includes(unwind) || unwind.includes('.'))) throw problem('unwind must name a top-level array field such as Line, LinkedTxn or CustomField.');
  const query = { mode, entities, where, unwind, asOf, cursor: input.cursor === undefined ? null : input.cursor };
  if (mode === 'find') {
    const fields = input.fields === undefined ? null : input.fields;
    if (fields !== null && (!Array.isArray(fields) || !fields.length || fields.length > 30)) throw problem('fields must list 1–30 field paths, or ["*"] for whole records.');
    query.fields = fields && fields.length === 1 && fields[0] === '*' ? '*' : fields ? fields.map((field, index) => fieldPath(field, 'fields[' + index + ']')) : null;
    query.sort = (input.sort || []).map((item, index) => ({ field: fieldPath(item?.field, 'sort[' + index + '].field'), direction: item?.direction === 'desc' ? -1 : 1 }));
    if (query.sort.length > 3) throw problem('Sort by at most three fields.');
    query.limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > LIMITS.rows) throw problem('limit must be 1–' + LIMITS.rows + '.');
  } else if (mode === 'aggregate') {
    const groupBy = input.groupBy || [];
    if (!Array.isArray(groupBy) || groupBy.length > 3) throw problem('groupBy takes at most three keys.');
    query.groupBy = groupBy.map((item, index) => {
      const field = fieldPath(item?.field, 'groupBy[' + index + '].field');
      if (item.period !== undefined && !PERIODS.includes(item.period)) throw problem('groupBy[' + index + '].period must be ' + PERIODS.join(', ') + '.');
      if (item.bucket !== undefined && item.bucket !== 'aging') throw problem('groupBy[' + index + '].bucket supports aging only.');
      if (item.period && item.bucket) throw problem('groupBy[' + index + '] takes a period or a bucket, not both.');
      return { field, period: item.period || null, bucket: item.bucket || null, name: field + (item.period ? ':' + item.period : item.bucket ? ':aging' : '') };
    });
    const metrics = input.metrics === undefined ? [{ op: 'count' }] : input.metrics;
    if (!Array.isArray(metrics) || !metrics.length || metrics.length > 8) throw problem('metrics must list 1–8 measures.');
    query.metrics = metrics.map((item, index) => {
      if (!METRICS.includes(item?.op)) throw problem('metrics[' + index + '].op must be ' + METRICS.join(', ') + '.');
      if (item.op === 'count') { if (item.field !== undefined) throw problem('count counts rows and takes no field.'); return { op: 'count', name: 'count' }; }
      const field = fieldPath(item.field, 'metrics[' + index + '].field');
      return { op: item.op, field, name: item.op + ':' + field };
    });
    if (new Set(query.metrics.map(item => item.name)).size !== query.metrics.length) throw problem('Each metric may be listed once.');
    const names = new Set([...query.groupBy.map(item => item.name), ...query.metrics.map(item => item.name)]);
    query.sort = (input.sort || []).map((item, index) => { if (!names.has(item?.field)) throw problem('sort[' + index + '].field must name a groupBy key or metric, for example ' + [...names][0] + '.'); return { field: item.field, direction: item.direction === 'desc' ? -1 : 1 }; });
    if (query.sort.length > 3) throw problem('Sort by at most three keys.');
    query.limit = input.limit === undefined ? 100 : input.limit;
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > LIMITS.groups) throw problem('limit must be 1–' + LIMITS.groups + '.');
  } else {
    if (unwind) throw problem('links mode does not unwind.');
    const ids = input.ids === undefined ? null : input.ids;
    if (ids !== null && (!Array.isArray(ids) || !ids.length || ids.length > LIMITS.roots || ids.some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item)))) throw problem('ids must list 1–' + LIMITS.roots + ' record ids.');
    if (ids && entities.length !== 1) throw problem('ids need exactly one entity type.');
    if (!ids && !where.length) throw problem('links needs ids or where conditions that pick the starting records.');
    query.ids = ids;
    query.depth = input.depth === undefined ? 2 : input.depth;
    if (!Number.isSafeInteger(query.depth) || query.depth < 1 || query.depth > LIMITS.depth) throw problem('depth must be 1–' + LIMITS.depth + '.');
  }
  for (const key of Object.keys(input)) if (!['mode', 'entities', 'where', 'unwind', 'asOf', 'cursor', 'fields', 'sort', 'limit', 'groupBy', 'metrics', 'ids', 'depth'].includes(key) || (mode !== 'find' && key === 'fields') || (mode !== 'aggregate' && ['groupBy', 'metrics'].includes(key)) || (mode !== 'links' && ['ids', 'depth'].includes(key)) || (mode === 'links' && ['sort', 'limit', 'cursor'].includes(key))) throw problem(key + ' is not used in ' + mode + ' mode.');
  return query;
}

function fingerprint(query) { const { cursor, ...rest } = query; return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16); }
function readCursor(query) {
  if (query.cursor === null) return 0;
  let value = null;
  try { value = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8')); } catch { value = null; }
  if (!value || value.q !== fingerprint(query) || !Number.isSafeInteger(value.o) || value.o < 0) throw problem('cursor belongs to a different query; repeat the same query with the cursor it returned.');
  return value.o;
}
const writeCursor = (query, offset) => Buffer.from(JSON.stringify({ o: offset, q: fingerprint(query) })).toString('base64url');

function createCompanyQuery({ Records, scope, freshness = () => null, allowedEntities = null, now = () => Date.now(), businessDate = () => require('./business-activity-preview').businessDate(new Date(now())), limits = LIMITS } = {}) {
  if (!Records || typeof Records.find !== 'function' || !scope?.realmId || !scope.environment || !scope.connectionId) throw new TypeError('Company query needs the mirror model and a concrete company scope.');
  const base = { environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, deleted: false };
  async function* scan(filter, select, budget) {
    const cursor = Records.find({ ...filter, ...base }).select(select).lean().maxTimeMS(limits.timeMs).batchSize(500).cursor();
    try {
      for await (const doc of cursor) {
        if (++budget.docs > limits.docs) throw problem('This query reads more than ' + limits.docs + ' records. Narrow it with entities or where conditions.', 422);
        if (now() > budget.deadline) throw problem('This query took longer than ' + limits.timeMs / 1000 + ' seconds. Narrow it with entities or where conditions.', 422);
        yield doc;
      }
    } finally { if (typeof cursor.close === 'function') await cursor.close().catch(() => {}); }
  }
  // Mirror-side narrowing only; every condition is re-checked in full after the read.
  function pushdown(query, entities) {
    const filter = { entity: { $in: entities } };
    for (const condition of query.where) {
      if (condition.field !== 'TxnDate' || !['eq', 'gt', 'gte', 'lt', 'lte'].includes(condition.op) || typeof condition.value !== 'string' || !DAY.test(condition.value)) continue;
      const range = filter['record.TxnDate'] || (filter['record.TxnDate'] = {});
      range[condition.op === 'eq' ? '$eq' : '$' + condition.op] = condition.value;
    }
    return filter;
  }
  // Payment dates per invoice/bill, from the mirrored payments that apply to them.
  async function paymentIndex(entities, budget) {
    const index = new Map(), payers = [...new Set(entities.flatMap(entity => entity === 'Invoice' ? ['Payment'] : entity === 'Bill' ? ['BillPayment'] : []))];
    if (!payers.length) return index;
    for await (const doc of scan({ entity: { $in: payers } }, 'entity qboId record.TxnDate record.Line', budget)) {
      const date = doc.record?.TxnDate;
      if (typeof date !== 'string' || !DAY.test(date)) continue;
      for (const link of leaves(pick(doc.record, ['Line', 'LinkedTxn']))) {
        const target = linkEntity(link?.TxnType);
        if (!target || typeof link.TxnId !== 'string') continue;
        const key = target + ':' + link.TxnId, prior = index.get(key);
        if (!prior || date > prior) index.set(key, date);
      }
    }
    return index;
  }
  function resolver(query, payments) {
    const asOf = query.asOf || businessDate();
    return (row, path) => {
      if (path === '_entity') return [row.entity];
      if (path === '_ageDays') return [daysBetween(row.record?.TxnDate, asOf)].filter(item => item !== null);
      if (PAYMENT_DERIVED.has(path)) {
        const record = row.record || {}, paid = Number(record.Balance) === 0 ? payments.get(row.entity + ':' + record.Id) || null : null;
        if (path === '_paidDate') return paid ? [paid] : [];
        if (path === '_daysToPay') return paid ? [daysBetween(record.TxnDate, paid)].filter(item => item !== null) : [];
        const late = Number(record.Balance) > 0 ? daysBetween(record.DueDate, asOf) : paid ? daysBetween(record.DueDate, paid) : null;
        return late === null ? [] : [late];
      }
      return leaves(pick(row.record, path.split('.')));
    };
  }
  const usesPayments = query => [...query.where.flatMap(item => item.anyOf ? item.anyOf : [item]), ...(query.sort || []), ...(query.groupBy || []), ...(query.metrics || []), ...(Array.isArray(query.fields) ? query.fields.map(field => ({ field })) : [])].some(item => PAYMENT_DERIVED.has(item.field));
  function selection(query) {
    if (query.mode === 'links' || query.fields === '*') return 'entity qboId lastObservedAt record';
    const paths = [...query.where.flatMap(item => item.anyOf ? item.anyOf : [item]), ...(query.sort || []), ...(query.groupBy || []), ...(query.metrics || []).filter(item => item.field), ...(query.fields || DEFAULT_FIELDS).map(field => ({ field }))].map(item => item.field);
    const tops = new Set(['Id']);
    for (const path of paths) { if (!DERIVED.includes(path)) tops.add(path.split('.')[0]); else if (path !== '_entity') ['Id', 'TxnDate', 'DueDate', 'Balance'].forEach(item => tops.add(item)); }
    if (query.unwind) tops.add(query.unwind.split('.')[0]);
    return 'entity qboId lastObservedAt ' + [...tops].map(top => 'record.' + top).join(' ');
  }
  // Each mirrored record, or each element of its unwound top-level array, as one row: the
  // unwound field holds that single element and the rest of the record is unchanged.
  function* rowsOf(doc, unwind) {
    if (!unwind) { yield doc; return; }
    const items = own(doc.record, unwind) && Array.isArray(doc.record[unwind]) ? doc.record[unwind] : [];
    for (const item of items) yield { ...doc, record: { ...doc.record, [unwind]: item } };
  }
  function sources(entities) {
    const view = freshness() || null, list = Array.isArray(view?.sources) ? view.sources : [];
    return { status: view?.status || 'unknown', lastSuccessAt: view?.lastSuccessAt || null,
      sources: entities.map(entity => { const row = list.find(item => item?.entity === entity); return { entity, status: row?.status || 'unknown', lastSuccessAt: row?.lastSuccessAt || null, freshUntil: row?.freshUntil || null }; }),
      note: view?.status === 'current' ? 'The synced copy is current.' : 'The synced copy is not fully current; changes made in QuickBooks since each source’s lastSuccessAt may be missing. Record lookups read QuickBooks live for types that are not current.' };
  }
  function matches(row, where, value) { return where.every(condition => condition.anyOf ? condition.anyOf.some(item => test(value(row, item.field), item)) : test(value(row, condition.field), condition)); }
  function display(value) { const items = value === undefined ? [] : value; return Array.isArray(items) ? items.length === 0 ? null : items.length === 1 ? items[0] : items.slice(0, 50) : items; }
  function project(row, query, value) {
    if (query.fields === '*') return { entity: row.entity, id: row.qboId, record: row.record };
    const out = { entity: row.entity, id: row.qboId };
    for (const field of query.fields || DEFAULT_FIELDS) {
      const picked = DERIVED.includes(field) ? value(row, field) : pick(row.record, field.split('.'));
      if (picked === undefined && !query.fields) continue;
      out[field] = display(picked);
    }
    return out;
  }
  function bounded(rows, offset, query, total) {
    const out = []; let bytes = 0, truncatedRows = 0;
    for (const row of rows) {
      let item = row, size = Buffer.byteLength(JSON.stringify(item));
      if (size > limits.rowBytes) { item = { entity: row.entity, id: row.id, truncated: 'This record is larger than one result row; request fewer fields.' }; size = Buffer.byteLength(JSON.stringify(item)); truncatedRows++; }
      if (out.length && bytes + size > limits.bytes) break;
      out.push(item); bytes += size;
    }
    const next = offset + out.length;
    return { rows: out, ...(truncatedRows ? { truncatedRows } : {}), returned: out.length, total, nextCursor: next < total ? writeCursor(query, next) : null };
  }

  async function find(query, budget) {
    const offset = readCursor(query), payments = usesPayments(query) ? await paymentIndex(query.entities, budget) : new Map(), value = resolver(query, payments);
    const found = []; let scannedRows = 0;
    for await (const doc of scan(pushdown(query, query.entities), selection(query), budget)) {
      for (const row of rowsOf(doc, query.unwind)) {
        if (++scannedRows > limits.rowsScanned) throw problem('This query reads more than ' + limits.rowsScanned + ' rows. Narrow it.', 422);
        if (!matches(row, query.where, value)) continue;
        found.push({ row, keys: query.sort.map(item => value(row, item.field)[0]) });
      }
    }
    found.sort((a, b) => {
      for (let index = 0; index < query.sort.length; index++) {
        const x = a.keys[index], y = b.keys[index];
        if (x === undefined || x === null || y === undefined || y === null) { if (x == null && y == null) continue; return x == null ? 1 : -1; }
        const order = compare(x, y);
        if (order) return order * query.sort[index].direction;
      }
      return a.row.entity < b.row.entity ? -1 : a.row.entity > b.row.entity ? 1 : (compare(a.row.qboId, b.row.qboId) || 0);
    });
    const page = found.slice(offset, offset + query.limit).map(item => project(item.row, query, value));
    return { mode: 'find', ...bounded(page, offset, query, found.length) };
  }

  async function aggregate(query, budget) {
    const offset = readCursor(query), payments = usesPayments(query) ? await paymentIndex(query.entities, budget) : new Map(), value = resolver(query, payments), asOf = query.asOf || businessDate();
    const groups = new Map(), totals = accumulator(query.metrics); let scannedRows = 0, matched = 0, multiValued = false;
    for await (const doc of scan(pushdown(query, query.entities), selection(query), budget)) {
      for (const row of rowsOf(doc, query.unwind)) {
        if (++scannedRows > limits.rowsScanned) throw problem('This query reads more than ' + limits.rowsScanned + ' rows. Narrow it.', 422);
        if (!matches(row, query.where, value)) continue;
        matched++;
        // A key field with several values (an un-unwound array) puts the row in each value's group.
        let keys = [[]];
        for (const key of query.groupBy) {
          let values = value(row, key.field);
          if (values.length > 1) multiValued = true;
          values = [...new Set((values.length ? values : [null]).map(item => item !== null && typeof item === 'object' ? JSON.stringify(item).slice(0, 200) : key.period ? period(item, key.period) : key.bucket ? aging(item, asOf) : item))];
          keys = keys.flatMap(prefix => values.map(item => [...prefix, item]));
        }
        totals.add(row, value);
        for (const key of keys) {
          const id = JSON.stringify(key);
          if (!groups.has(id)) { if (groups.size >= 20000) throw problem('This grouping produces more than 20000 groups. Group by fewer or coarser keys.', 422); groups.set(id, { key, metrics: accumulator(query.metrics) }); }
          groups.get(id).metrics.add(row, value);
        }
      }
    }
    const list = [...groups.values()].map(group => ({ key: Object.fromEntries(query.groupBy.map((item, index) => [item.name, group.key[index]])), ...group.metrics.result() }));
    const sort = query.sort.length ? query.sort : query.groupBy.map(item => ({ field: item.name, direction: 1 }));
    // Aging buckets sort in age order, not alphabetically.
    const sortValue = (group, field) => Object.hasOwn(group.key, field) ? field.endsWith(':aging') ? AGING.indexOf(group.key[field]) : group.key[field] : group[field];
    list.sort((a, b) => {
      for (const item of sort) {
        const x = sortValue(a, item.field), y = sortValue(b, item.field);
        if (x == null || y == null) { if (x == null && y == null) continue; return x == null ? 1 : -1; }
        const order = compare(x, y);
        if (order) return order * item.direction;
      }
      return 0;
    });
    const page = list.slice(offset, offset + query.limit), shaped = bounded(page, offset, query, list.length);
    return { mode: 'aggregate', groups: shaped.rows, returnedGroups: shaped.returned, totalGroups: list.length, nextCursor: shaped.nextCursor, matchedRows: matched, totals: totals.result(), ...(query.groupBy.some(item => item.bucket) ? { asOf } : {}), ...(multiValued ? { warning: 'A groupBy field had several values on one row, so that row counts in each value’s group. Unwind the array (for example unwind: "Line") to total each line once.' } : {}) };
  }
  function accumulator(metrics) {
    const state = metrics.map(metric => ({ metric, count: 0, sum: 0, n: 0, min: null, max: null, distinct: metric.op === 'countDistinct' ? new Set() : null }));
    return {
      add(row, value) {
        for (const item of state) {
          if (item.metric.op === 'count') { item.count++; continue; }
          const values = value(row, item.metric.field);
          if (item.distinct) { for (const one of values) if (item.distinct.size < 100000) item.distinct.add(typeof one === 'object' ? JSON.stringify(one) : String(one)); continue; }
          for (const one of values) {
            const number = typeof one === 'number' ? one : typeof one === 'string' && one.trim() !== '' && Number.isFinite(Number(one)) ? Number(one) : null;
            if (item.metric.op === 'min' || item.metric.op === 'max') { const candidate = number ?? one; if (candidate === null || typeof candidate === 'object') continue; if (item.min === null || compare(candidate, item.min) < 0) item.min = candidate; if (item.max === null || compare(candidate, item.max) > 0) item.max = candidate; continue; }
            if (number === null) continue;
            item.sum += number; item.n++;
          }
        }
      },
      result() {
        return Object.fromEntries(state.map(item => [item.metric.name, item.metric.op === 'count' ? item.count : item.distinct ? item.distinct.size : item.metric.op === 'sum' ? round(item.sum) : item.metric.op === 'avg' ? item.n ? round(item.sum / item.n) : null : item.metric.op === 'min' ? item.min : item.max]));
      },
    };
  }

  async function links(query, budget) {
    const summary = doc => { const record = doc.record || {}; return { entity: doc.entity, id: doc.qboId, docNumber: record.DocNumber || null, txnDate: record.TxnDate || null, party: record.CustomerRef?.name || record.VendorRef?.name || record.EntityRef?.name || null, totalAmt: record.TotalAmt ?? null, balance: record.Balance ?? null }; };
    const outgoing = doc => [...leaves(pick(doc.record, ['LinkedTxn'])).map(link => ({ link, via: 'LinkedTxn' })), ...leaves(pick(doc.record, ['Line', 'LinkedTxn'])).map(link => ({ link, via: 'Line.LinkedTxn' }))]
      .filter(item => item.link && typeof item.link.TxnId === 'string' && linkEntity(item.link.TxnType)).map(item => ({ key: linkEntity(item.link.TxnType) + ':' + item.link.TxnId, type: item.link.TxnType, via: item.via }));
    const value = resolver(query, new Map()), nodes = new Map(), edges = new Map(); let truncated = false;
    const roots = [];
    const rootFilter = query.ids ? { entity: query.entities[0], qboId: { $in: query.ids } } : pushdown(query, query.entities);
    for await (const doc of scan(rootFilter, 'entity qboId record', budget)) {
      if (query.where.length && !matches(doc, query.where, value)) continue;
      if (roots.length >= limits.roots) { truncated = true; break; }
      roots.push(doc);
    }
    roots.sort((a, b) => a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : (compare(a.qboId, b.qboId) || 0));
    const add = (doc, depth) => { const key = doc.entity + ':' + doc.qboId; if (nodes.has(key)) return false; if (nodes.size >= limits.nodes) { truncated = true; return false; } nodes.set(key, { ...summary(doc), depth, doc }); return true; };
    let frontier = roots.filter(doc => add(doc, 0));
    for (let depth = 1; depth <= query.depth && frontier.length && !truncated; depth++) {
      const next = [], wanted = new Map(), ids = new Set(frontier.map(doc => doc.qboId)), frontKeys = new Set(frontier.map(doc => doc.entity + ':' + doc.qboId));
      for (const doc of frontier) for (const out of outgoing(doc)) {
        edges.set(doc.entity + ':' + doc.qboId + '>' + out.key, { from: doc.entity + ':' + doc.qboId, to: out.key, txnType: out.type, via: out.via });
        if (!nodes.has(out.key)) { const [entity, id] = out.key.split(':'); if (!wanted.has(entity)) wanted.set(entity, new Set()); wanted.get(entity).add(id); }
      }
      for (const [entity, set] of wanted) for await (const doc of scan({ entity, qboId: { $in: [...set].slice(0, 500) } }, 'entity qboId record', budget)) if (add(doc, depth)) next.push(doc);
      // Records that point at the frontier (payments, deposits, bills received against a PO).
      for await (const doc of scan({ entity: { $in: TRANSACTIONS }, $or: [{ 'record.LinkedTxn.TxnId': { $in: [...ids] } }, { 'record.Line.LinkedTxn.TxnId': { $in: [...ids] } }] }, 'entity qboId record', budget)) {
        const hits = outgoing(doc).filter(out => frontKeys.has(out.key));
        if (!hits.length) continue;
        for (const hit of hits) edges.set(doc.entity + ':' + doc.qboId + '>' + hit.key, { from: doc.entity + ':' + doc.qboId, to: hit.key, txnType: hit.type, via: hit.via });
        if (add(doc, depth)) next.push(doc);
      }
      frontier = next;
    }
    const list = [...nodes.values()].map(({ doc, ...node }) => node), missing = [...new Set([...edges.values()].flatMap(edge => [edge.from, edge.to]).filter(key => !nodes.has(key)))];
    const out = { mode: 'links', roots: roots.length, nodes: list, edges: [...edges.values()].filter(edge => nodes.has(edge.from) || nodes.has(edge.to)).slice(0, 400), ...(missing.length ? { notInMirror: missing.slice(0, 50) } : {}), truncated };
    if (Buffer.byteLength(JSON.stringify(out)) > limits.bytes * 2) { out.nodes = list.slice(0, 40); out.edges = out.edges.filter(edge => out.nodes.some(node => node.entity + ':' + node.id === edge.from || node.entity + ':' + node.id === edge.to)).slice(0, 120); out.truncated = true; }
    return out;
  }

  async function run(input) {
    const query = normalize(input, { allowedEntities });
    const budget = { docs: 0, deadline: now() + limits.timeMs };
    let data;
    try { data = query.mode === 'find' ? await find(query, budget) : query.mode === 'aggregate' ? await aggregate(query, budget) : await links(query, budget); }
    catch (error) { if (error?.code === 50 || error?.codeName === 'MaxTimeMSExpired') throw problem('This query took longer than ' + limits.timeMs / 1000 + ' seconds. Narrow it with entities or where conditions.', 422); throw error; }
    return { success: true, data: { ...data, scannedRecords: budget.docs, source: 'synced copy (no QuickBooks request)', freshness: sources([...new Set([...query.entities, ...(usesPayments(query) ? query.entities.flatMap(entity => entity === 'Invoice' ? ['Payment'] : entity === 'Bill' ? ['BillPayment'] : []) : [])])]) } };
  }
  return { run };
}

module.exports = { createCompanyQuery, normalize, OPS, METRICS, PERIODS, DERIVED, LIMITS };
