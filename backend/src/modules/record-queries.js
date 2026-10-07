'use strict';
const { date } = require('./business-calendar');
const ENTITIES = Object.freeze(['Customer', 'Invoice', 'Payment', 'CreditMemo', 'Bill', 'BillPayment', 'VendorCredit', 'Vendor', 'Item', 'Account', 'JournalEntry', 'Estimate', 'Deposit', 'SalesReceipt', 'RefundReceipt', 'Purchase', 'PurchaseOrder', 'Transfer', 'TimeActivity']);
const LISTS = new Set(['Customer', 'Vendor', 'Item', 'Account']);
const NO_NUMBER = new Set(['Transfer', 'TimeActivity', 'Payment', 'Deposit']);
const ALIASES = { billpaymentcheck: 'BillPayment', billpaymentcreditcard: 'BillPayment', receivepayment: 'Payment', expense: 'Purchase', check: 'Purchase', creditcardcredit: 'Purchase' };
function invalid(message) { return Object.assign(new Error(message), { recordInputError: true }); }
function canonicalType(value) { return typeof value === 'string' ? ENTITIES.find(type => type.toLowerCase() === value.toLowerCase()) || (Object.hasOwn(ALIASES, value.toLowerCase()) ? ALIASES[value.toLowerCase()] : null) : null; }
function identity(type, id) {
  const entity = canonicalType(type);
  if (!entity || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw invalid('Choose a supported record and valid record ID.');
  return { entity, id };
}
function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw invalid('Record paging values are invalid.');
  return Number(value);
}
function searchQuery(input) {
  if (Object.keys(input).some(key => !['type', 'q', 'limit', 'offset', 'from', 'through', 'active'].includes(key))) throw invalid('Unsupported record search option.');
  if (!ENTITIES.includes(input.type)) throw invalid('Choose a supported kind of record.');
  const type = input.type, isList = LISTS.has(type);
  const limit = integer(input.limit, 50, 1, 100), offset = integer(input.offset, 0, 0, 1000000);
  const filters = [];
  if (input.q !== undefined && (typeof input.q !== 'string' || input.q.length > 120 || /[\u0000-\u001f]/.test(input.q))) throw invalid('Use a search of at most 120 characters.');
  const text = (input.q || '').trim();
  if (text) {
    if (NO_NUMBER.has(type)) throw invalid('This kind of record does not support document-number search. Use dates instead.');
    const field = isList ? (['Item', 'Account'].includes(type) ? 'Name' : 'DisplayName') : 'DocNumber';
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    filters.push(field + " LIKE '%" + escaped + "%'");
  }
  for (const key of ['from', 'through']) if (input[key] !== undefined) {
    if (isList) throw invalid('Date filters apply to transactions only.');
    try { date(input[key]); } catch { throw invalid('Choose valid transaction dates.'); }
    filters.push('TxnDate ' + (key === 'from' ? '>=' : '<=') + " '" + input[key] + "'");
  }
  if (input.from && input.through && input.from > input.through) throw invalid('The start date must be on or before the end date.');
  if (isList) {
    const active = input.active || 'all';
    if (!['all', 'active', 'inactive'].includes(active)) throw invalid('Choose all, active or inactive records.');
    filters.push(active === 'all' ? 'Active IN (true, false)' : 'Active = ' + (active === 'active' ? 'true' : 'false'));
  } else if (input.active !== undefined) throw invalid('Active status applies to lists only.');
  const order = isList ? (['Item', 'Account'].includes(type) ? 'Name' : 'DisplayName') : 'TxnDate DESC';
  return { type, limit, offset, query: 'SELECT * FROM ' + type + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ' ORDERBY ' + order + ', Id ASC STARTPOSITION ' + (offset + 1) + ' MAXRESULTS ' + (limit + 1) };
}
function pageResult(result, request) {
  const response = result?.QueryResponse;
  if (!response || typeof response !== 'object' || Array.isArray(response) || (response[request.type] !== undefined && !Array.isArray(response[request.type]))) throw new Error('Invalid record query response');
  if (response.startPosition != null && Number(response.startPosition) !== request.offset + 1) throw new Error('Unexpected record page position');
  if (response.Warnings && (typeof response.Warnings !== 'object' || Object.keys(response.Warnings).length)) throw new Error('Record query returned warnings');
  const values = response[request.type] || [];
  if (values.length > request.limit + 1 || values.some(record => !record || (typeof record.Id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(record.Id))) || new Set(values.map(record => record.Id)).size !== values.length) throw new Error('Invalid record query rows');
  const records = values.slice(0, request.limit), hasMore = values.length > request.limit;
  return { type: request.type, records, count: records.length, offset: request.offset, limit: request.limit, hasMore, nextOffset: hasMore ? request.offset + request.limit : null, observedAt: new Date().toISOString(), snapshot: false };
}
module.exports = { ENTITIES, canonicalType, identity, searchQuery, pageResult, integer, invalid };
