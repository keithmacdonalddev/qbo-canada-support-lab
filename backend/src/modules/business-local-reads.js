'use strict';
// The business accountant's record lookups (lookupCustomer, lookupInvoice, searchEntities,
// getEntityDetail, getTransactionChain) answered from the app's synced copy of the company
// (CompanySyncRecord) instead of metered QuickBooks reads. Results keep the live tools' shapes.
// A lookup answers locally only when every record type it reads is mirrored and its sync source
// is current; otherwise answer() returns { live: reason } and the caller reads QuickBooks.
// The legacy AI command center keeps its live handlers (ai-tools.js) unchanged.
const { ENTITIES } = require('./business-agent-sync');
const { VALID_ENTITY_TYPES, SINGLETON_TYPES, compactRecord, SEARCH_RULES } = require('./ai-tools');

const { PEOPLE_TYPES, NAME_SEARCH_TYPES, LIST_TYPES, UNSEARCHABLE_TEXT_TYPES, SORTABLE_LIST_TYPES, CUSTOMER_TXN_TYPES, VENDOR_TXN_TYPES, ACCOUNT_TYPES, ITEM_TYPES } = SEARCH_RULES;
const LOCAL_NAMES = Object.freeze(['lookupCustomer', 'lookupInvoice', 'searchEntities', 'getEntityDetail', 'getTransactionChain']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, QBO_ID_RE = /^\d+$/, TIME_MS = 5000, CHAIN_NODES = 60;
// QBO LinkedTxn.TxnType values that name a mirrored entity differently.
const LINK_TYPES = Object.freeze({ BillPaymentCheck: 'BillPayment', BillPaymentCreditCard: 'BillPayment', ReceivePayment: 'Payment', Check: 'Purchase', Expense: 'Purchase', CreditCardCharge: 'Purchase', CreditCardCredit: 'Purchase' });
// Text is matched as a literal, case-insensitive substring, like the live LIKE '%text%'.
const literal = text => String(text).replace(/[\u0000-\u001f]/g, ' ').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contains = text => ({ $regex: literal(text), $options: 'i' });

function createLocalReads({ Records, scope, freshness = () => null } = {}) {
  if (!Records || typeof Records.find !== 'function' || !scope?.realmId || !scope.environment || !scope.connectionId) throw new TypeError('Local reads need the mirror model and a concrete company scope.');
  const base = { environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, deleted: false };
  const sourceOf = entity => { const view = freshness(); return Array.isArray(view?.sources) ? view.sources.find(row => row?.entity === entity) || null : null; };
  // null when the type can be answered locally, else the reason it cannot.
  function unavailable(entity) {
    if (!ENTITIES.includes(entity)) return entity + ' records are not part of the synced copy';
    const source = sourceOf(entity);
    if (!source || source.status === 'waiting') return entity + ' records are not synchronized yet';
    if (source.status !== 'current') return 'the ' + entity + ' sync is ' + source.status + (source.lastSuccessAt ? ' (last complete ' + source.lastSuccessAt + ')' : '');
    return null;
  }
  const stamp = entities => ({ answeredBy: 'synced-copy', note: 'Answered from the app’s synced copy; no QuickBooks request was made.', syncedAt: Object.fromEntries(entities.map(entity => [entity, sourceOf(entity)?.lastSuccessAt || null])) });
  const list = (filter, { sort = { changedAt: -1, qboId: 1 }, skip = 0, limit }) => Records.find({ ...filter, ...base }).select('entity qboId record').sort(sort).skip(skip).limit(limit).maxTimeMS(TIME_MS).lean();
  const one = (entity, qboId) => Records.findOne({ entity, qboId: String(qboId), ...base }).select('entity qboId record').maxTimeMS(TIME_MS).lean();

  async function lookupCustomer(input) {
    if (!String(input.name || '').trim()) return { success: false, error: 'Customer name is required' };
    const rows = await list({ entity: 'Customer', 'record.DisplayName': contains(input.name), 'record.Active': { $ne: false } }, { limit: 20 });
    const customers = rows.map(row => row.record);
    return { success: true, data: { count: customers.length, customers: customers.map(c => ({ id: c.Id, displayName: c.DisplayName, balance: c.Balance, email: c.PrimaryEmailAddr?.Address || null, phone: c.PrimaryPhone?.FreeFormNumber || null, active: c.Active })) } };
  }
  async function lookupInvoice(input) {
    const docNumber = String(input.docNumber || '').trim(), customerName = String(input.customerName || '').trim();
    if (!docNumber && !customerName) return { success: false, error: 'At least one of docNumber or customerName is required' };
    const rows = await list({ entity: 'Invoice', ...(docNumber ? { 'record.DocNumber': contains(docNumber) } : {}), ...(customerName ? { 'record.CustomerRef.name': contains(customerName) } : {}) }, { limit: 20 });
    return { success: true, data: { count: rows.length, invoices: rows.map(({ record: inv }) => ({ id: inv.Id, docNumber: inv.DocNumber, txnDate: inv.TxnDate, totalAmt: inv.TotalAmt, balance: inv.Balance, customerRef: inv.CustomerRef, dueDate: inv.DueDate, linkedTxns: inv.LinkedTxn || [] })) } };
  }
  // The live tool's structured filters, with its validation messages, as mirror conditions.
  function conditions(type, filters) {
    if (filters === undefined || filters === null) return { filter: {} };
    if (typeof filters !== 'object' || Array.isArray(filters)) return { error: 'filters must be an object' };
    const isList = LIST_TYPES.includes(type), filter = {};
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      const onlyFor = (allowed, label) => (allowed ? null : `The ${key} filter applies to ${label} only, not ${type}.`);
      let problem = null;
      if (key === 'active') { problem = onlyFor(isList, 'lists') || (['active', 'inactive', 'all'].includes(value) ? null : 'active must be active, inactive or all'); if (!problem) filter.active = value; }
      else if (key === 'accountType') { problem = onlyFor(type === 'Account', 'Account') || (ACCOUNT_TYPES.includes(value) ? null : `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`); if (!problem) filter['record.AccountType'] = value; }
      else if (key === 'itemType') { problem = onlyFor(type === 'Item', 'Item') || (ITEM_TYPES.includes(value) ? null : `itemType must be one of: ${ITEM_TYPES.join(', ')}`); if (!problem) filter['record.Type'] = value; }
      else if (key === 'txnDateFrom' || key === 'txnDateTo') { problem = onlyFor(!isList, 'transactions') || (DATE_RE.test(String(value)) ? null : `${key} must be YYYY-MM-DD`); if (!problem) (filter['record.TxnDate'] ||= {})[key === 'txnDateFrom' ? '$gte' : '$lte'] = String(value); }
      else if (key === 'customerId' || key === 'vendorId') {
        const allowed = key === 'customerId' ? CUSTOMER_TXN_TYPES : VENDOR_TXN_TYPES;
        problem = onlyFor(allowed.includes(type), allowed.join(', ')) || (QBO_ID_RE.test(String(value)) ? null : `${key} must be a QBO Id`);
        if (!problem) filter[key === 'customerId' ? 'record.CustomerRef.value' : 'record.VendorRef.value'] = String(value);
      } else problem = `Unsupported filter ${String(key).slice(0, 40)}. Use active, accountType, itemType, txnDateFrom, txnDateTo, customerId or vendorId.`;
      if (problem) return { error: problem };
    }
    // Lists default to active records, as QuickBooks queries do.
    const active = filter.active; delete filter.active;
    if (isList && active !== 'all') filter['record.Active'] = active === 'inactive' ? false : { $ne: false };
    return { filter };
  }
  async function searchEntities(input) {
    const { type } = input;
    if (!VALID_ENTITY_TYPES.includes(type)) return { success: false, error: `Invalid entity type "${type}". Must be one of: ${VALID_ENTITY_TYPES.join(', ')}` };
    const limit = Math.min(Math.max(Math.floor(Number(input.limit)) || 10, 1), 100), startPosition = Math.max(Math.floor(Number(input.startPosition)) || 1, 1);
    if (SINGLETON_TYPES.includes(type)) { const rows = await list({ entity: type }, { limit: 1 }); return { success: true, data: { type, count: rows.length, records: rows.map(row => row.record) } }; }
    const { filter, error } = conditions(type, input.filters);
    if (error) return { success: false, error };
    const text = String(input.query || '').trim();
    if (text && !UNSEARCHABLE_TEXT_TYPES.includes(type)) filter['record.' + (PEOPLE_TYPES.includes(type) ? 'DisplayName' : NAME_SEARCH_TYPES.includes(type) ? 'Name' : 'DocNumber')] = contains(text);
    const sortable = !LIST_TYPES.includes(type) || SORTABLE_LIST_TYPES.includes(type);
    // One extra row shows whether another page exists.
    const rows = await list({ entity: type, ...filter }, { sort: sortable ? { changedAt: -1, qboId: 1 } : { qboId: 1 }, skip: startPosition - 1, limit: limit + 1 });
    const records = rows.slice(0, limit).map(row => compactRecord(row.record));
    return { success: true, data: { type, count: records.length, startPosition, order: sortable ? 'most recently updated first' : 'by record id', nextStartPosition: rows.length > limit ? startPosition + limit : null, records } };
  }
  async function getEntityDetail(input) {
    const { type, id } = input;
    if (!VALID_ENTITY_TYPES.includes(type)) return { success: false, error: `Invalid entity type "${type}". Must be one of: ${VALID_ENTITY_TYPES.join(', ')}` };
    if (SINGLETON_TYPES.includes(type)) { const [row] = await list({ entity: type }, { limit: 1 }); return row ? { success: true, data: { type, id: row.record.Id ?? null, record: row.record } } : { live: 'the synced copy has no ' + type + ' record' }; }
    if (!QBO_ID_RE.test(String(id))) return { success: false, error: `Invalid ${type} Id: ${String(id).slice(0, 40)}` };
    const row = await one(type, id);
    // A record missing from a current copy may be newer than the last change read: ask QuickBooks.
    return row ? { success: true, data: { type, id, record: row.record } } : { live: type + ' ' + id + ' is not in the synced copy' };
  }
  async function getTransactionChain(input) {
    const { entityType, entityId } = input;
    if (!VALID_ENTITY_TYPES.includes(entityType) || SINGLETON_TYPES.includes(entityType)) return { success: false, error: `Invalid entity type "${entityType}". Must be one of: ${VALID_ENTITY_TYPES.filter(t => !SINGLETON_TYPES.includes(t)).join(', ')}` };
    if (!QBO_ID_RE.test(String(entityId))) return { success: false, error: `Invalid ${entityType} Id: ${String(entityId).slice(0, 40)}` };
    const visited = new Set(), nodes = [], edges = [], types = new Set(); let truncated = false;
    // Every node must come from a current mirrored source, or the whole chain is read live.
    async function trace(type, id) {
      const key = type + ':' + id;
      if (visited.has(key)) return null;
      if (visited.size >= CHAIN_NODES) { truncated = true; return null; }
      visited.add(key);
      const reason = unavailable(type);
      if (reason) return reason;
      const row = await one(type, id);
      if (!row) return key + ' is not in the synced copy';
      types.add(type); nodes.push({ entity: type, id: String(id), data: row.record });
      const links = [...(row.record.LinkedTxn || []).map(link => [link, 'LinkedTxn']), ...(row.record.Line || []).flatMap(line => (line?.LinkedTxn || []).map(link => [link, 'LineLinkedTxn']))];
      for (const [link, linkType] of links) {
        if (!link || typeof link.TxnId !== 'string') continue;
        const target = LINK_TYPES[link.TxnType] || link.TxnType;
        edges.push({ from: key, to: target + ':' + link.TxnId, linkType });
        const problem = await trace(target, link.TxnId);
        if (problem) return problem;
      }
      return null;
    }
    const problem = await trace(entityType, String(entityId));
    if (problem) return { live: problem };
    return { success: true, data: { nodes, edges, ...(truncated ? { truncated: true, note: 'The chain was cut at ' + CHAIN_NODES + ' records.' } : {}) }, types: [...types] };
  }

  const handlers = { lookupCustomer, lookupInvoice, searchEntities, getEntityDetail, getTransactionChain };
  const typeOf = (name, input) => name === 'lookupCustomer' ? 'Customer' : name === 'lookupInvoice' ? 'Invoice' : name === 'getTransactionChain' ? input.entityType : input.type;
  // { result } answered locally (with result.source), or { live: reason } for the caller to read QuickBooks.
  async function answer(name, input = {}) {
    if (!LOCAL_NAMES.includes(name)) return { live: 'this tool reads QuickBooks directly' };
    const type = typeOf(name, input), reason = VALID_ENTITY_TYPES.includes(type) ? unavailable(type) : null;
    if (reason) return { live: reason };
    const value = await handlers[name](input);
    if (value.live) return { live: value.live };
    const { types, ...result } = value;
    return { result: { ...result, source: stamp(types || [type].filter(item => VALID_ENTITY_TYPES.includes(item))) } };
  }
  return { answer, unavailable };
}

module.exports = { createLocalReads, LOCAL_NAMES };
