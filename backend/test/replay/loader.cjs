'use strict';
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const COLLECTIONS = ['operationruns','operationsteps','operationplans','operationintents','operationevidences',
  'businessreplayevidences','generalwriteruns','qbowritereceipts','companysyncrecords','businessauthorities','blueprintversions',
  'businesscandidates','businesscalendars','companywritepolicies','businessagents','businessbaselines','generaldaycloses','auditlogs'];
const MAX_ROWS = 20000, MAX_BYTES = 192 * 1024 * 1024;
function normalize(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value?._bsontype === 'Binary') return Buffer.from(value.value());
  if (value?._bsontype === 'ObjectId') return value.toHexString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,normalize(v)]));
  return value;
}
async function loadStored({ root, since, ops = [], deadline = Date.now() + 510000 }) {
  const { createRequire } = require('node:module'), req = createRequire(root + '/backend/package.json');
  req('dotenv').config({ path: root + '/.env', quiet: true });
  const mongoose = req('mongoose');
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  const connection = mongoose.createConnection(req(root + '/backend/src/config').mongoUri, {
    autoIndex: false, autoCreate: false, readPreference: 'primary', maxPoolSize: 3,
    serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 15000
  });
  const data = {}, capturedAt = new Date(); let totalBytes = 0;
  try {
    await connection.asPromise();
    const read = async (name, filter, projection) => {
      if (!COLLECTIONS.includes(name) || Date.now() >= deadline) throw Object.assign(Error(), { code: 'REPLAY_READ_BUDGET' });
      const rows = [], cursor=connection.db.collection(name).find(filter, { projection, maxTimeMS: 10000 }).limit(MAX_ROWS + 1).batchSize(100);
      try {
        for await (const row of cursor) {
          if(Date.now()>=deadline)throw Object.assign(Error(),{code:'REPLAY_READ_BUDGET'});
          if(rows.length>=MAX_ROWS)throw Object.assign(Error(),{code:'REPLAY_ROW_LIMIT'});
          totalBytes+=Buffer.byteLength(JSON.stringify(row));
          if(totalBytes>MAX_BYTES)throw Object.assign(Error(),{code:'REPLAY_BYTE_LIMIT'});
          rows.push(normalize(row));
        }
      } finally { await cursor.close(); }
      return rows;
    };
    const selection = { createdAt: { $gte: new Date(since), $lte: capturedAt } };
    if (ops.length) selection._id = { $in: ops.map(id => new mongoose.Types.ObjectId(id)) };
    data.operationruns = await read('operationruns', selection);
    data.generalwriteruns = await read('generalwriteruns', { ...selection, ...(ops.length ? { _id: { $in: ops } } : {}) });
    const selected=[...data.operationruns,...data.generalwriteruns].map(r=>String(r._id));
    const scopes = [...new Map([...data.operationruns,...data.generalwriteruns].map(r => {
      const s = { environment: r.environment, realmId: r.realmId, connectionId: r.connectionId };
      return [JSON.stringify(s), s];
    })).values()];
    if (!scopes.length) return { data, missing: ops, selected: [], capturedAt, since, captureHash: digest([]) };
    // Only scoped operational stores. Never read connections, users, tokens or keys.
    const filter = { $or: scopes.map(s => ({ ...s, connectionId: new mongoose.Types.ObjectId(s.connectionId) })) };
    const names = COLLECTIONS.filter(n => n!=='auditlogs');
    let next = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < names.length) {
        const name = names[next++];
        const projection = name === 'businessagents' ? { environment:1,realmId:1,connectionId:1,sync:1,grant:1,ownerId:1,cadence:1,createdAt:1,updatedAt:1 } : undefined;
        data[name] = await read(name, name === 'businessreplayevidences' ? { ...filter, operationIds: { $in: selected } } : filter, projection);
      }
    }));
    const auditIds = new Set();
    for(const row of [...data.operationruns,...(data.qbowritereceipts||[]),...(data.businesscandidates||[]),...(data.businessauthorities||[])])for(const id of [row.approval?.auditId,row.auditId,row.startAuditId,row.resultAuditId])if(/^[a-f0-9]{24}$/.test(String(id||'')))auditIds.add(String(id));
    // Audit ids come only from these scoped operational records.
    data.auditlogs=await read('auditlogs',{_id:{$in:[...auditIds].map(id=>new mongoose.Types.ObjectId(id))}},{userId:1,actorUserId:1,realmId:1,action:1,actionType:1,outcome:1,inputParams:1,afterState:1,beforeState:1,createdAt:1});
    const missing = ops.filter(id => !selected.includes(id));
    const bytes = Buffer.byteLength(JSON.stringify(data));
    if (bytes > MAX_BYTES) throw Object.assign(Error(), { code: 'REPLAY_BYTE_LIMIT' });
    return { data, missing, selected, capturedAt, since, captureHash: digest(data), bytes };
  } finally { await connection.close(); }
}
module.exports = { loadStored, normalize, digest };
