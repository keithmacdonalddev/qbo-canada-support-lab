'use strict';
// Advisory choices only. Preparation, compilation and dispatch still read selected
// records from QuickBooks; this client must never be used as verification evidence.
const { scoped } = require('./qbo-write-contract');
const ENTITIES = new Set(['Account', 'TaxCode', 'Preferences', 'Customer', 'Vendor', 'Employee', 'Item', 'Invoice', 'Bill', 'Estimate', 'Payment', 'PurchaseOrder', 'SalesReceipt', 'JournalEntry']);
function createActivityChoiceClient({ scope, Records = require('../models/CompanySyncRecord'), Agents = require('../models/BusinessAgent'), now = () => Date.now(), signal }) {
  scope = scoped(scope);
  const snapshots = new Map();
  const source = { kind: 'synced-copy', provisional: true, unavailable: [], completedAt: {}, missingRecords: 0, note: 'Choices use the synchronized copy. Selected records are rechecked in QuickBooks before saving.' };
  let sources;
  const check = () => signal?.throwIfAborted();
  async function rows(entity) {
    check();
    if (!ENTITIES.has(entity)) throw new Error('Unsupported advisory record type.');
    if (!snapshots.has(entity)) snapshots.set(entity, (async () => {
      sources ||= Agents.findOne(scope).select('sync.sources').maxTimeMS(3000).lean();
      const syncSource = (await sources)?.sync?.sources?.[entity], completed = Date.parse(syncSource?.lastSuccessAt);
      const ageLimit = Math.min(86400000, Math.max(300000, (Number(syncSource?.everyMs) || 60000) * 2));
      if (syncSource?.status !== 'current' || !syncSource.generation || !Number.isFinite(completed) || completed > now() || now() - completed > ageLimit) throw new Error('The synchronized ' + entity + ' choices are unavailable; preparation will recheck selected records.');
      const found = await Records.find({ ...scope, entity, deleted: false, generation: syncSource.generation }).select('qboId record').sort({ qboId: 1 }).limit(16001).maxTimeMS(3000).lean();
      check();
      if (found.length > 16000 || found.some(row => !row.record || row.record.Id !== row.qboId || row.record.sparse === true || row.record.status === 'Deleted')) throw new Error('The synchronized choices are incomplete.');
      source.completedAt[entity] = new Date(completed).toISOString();
      return found.map(row => structuredClone(row.record));
    })());
    try { return await snapshots.get(entity); }
    catch (error) { if (!source.unavailable.includes(entity)) source.unavailable.push(entity); throw error; }
  }
  async function query(text) {
    check();
    const match = /^SELECT \* FROM (Account|TaxCode|Preferences|Customer|Vendor|Employee|Item)(?: WHERE Active IN \(true, false\))?(?: STARTPOSITION ([1-9][0-9]*) MAXRESULTS ([1-9][0-9]*))?$/.exec(text);
    if (!match) throw new Error('Only fixed advisory list queries are supported.');
    const [, entity, start = '1', size = '1000'] = match, list = await rows(entity);
    const offset = Number(start) - 1, count = Number(size);
    if (!Number.isSafeInteger(offset) || count > 1000) throw new Error('Unsupported advisory page.');
    return { QueryResponse: { [entity]: structuredClone(list.slice(offset, offset + count)), startPosition: offset + 1, maxResults: Math.min(count, Math.max(0, list.length - offset)) } };
  }
  async function read(entity, id) {
    check();
    const canonical = [...ENTITIES].find(name => name.toLowerCase() === entity.toLowerCase());
    if (!canonical || !/^[0-9]{1,30}$/.test(id)) throw new Error('Choose an exact advisory record.');
    try { const record = (await rows(canonical)).find(row => row.Id === id); if (!record) source.missingRecords++; return record ? { [canonical]: structuredClone(record) } : {}; }
    catch (error) { check(); return {}; } // Missing choices never trigger a provider scan.
  }
  return { query, read, apiCall: async (method, endpoint) => {
    if (method !== 'GET' || !/^[a-z]+\/[0-9]{1,30}$/.test(endpoint)) throw new Error('Advisory choices support entity reads only.');
    const [entity, id] = endpoint.split('/'); return read(entity, id);
  }, source };
}
module.exports = { createActivityChoiceClient };
