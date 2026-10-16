'use strict';
const { hash } = require('../../src/modules/business-calendar');
const C = require('../../src/modules/report-evidence-contract');
const { createDefinitionsService } = require('../../src/modules/rebuild-definitions');
const { createBusinessRuntimeAccess } = require('../../src/modules/business-runtime-access');
const { createReportEvidenceService } = require('../../src/modules/report-evidence-service');
const ownerId = 'b'.repeat(24), actorId = 'c'.repeat(24), scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) };
const clone = value => structuredClone(value);
function field(row, key) { return key.split('.').reduce((value, part) => value?.[part], row); }
function matches(row, filter) { return row && Object.entries(filter).every(([key, want]) => { if (key === '$or') return want.some(value => matches(row, value)); const actual = field(row, key); if (want instanceof Date) return new Date(actual).getTime() === want.getTime(); if (want && typeof want === 'object') return Object.entries(want).every(([op, value]) => op === '$lt' ? actual < value : op === '$in' ? value.includes(actual) : op === '$exists' ? (actual !== undefined) === value : false); return actual === want; }); }
function fixture() {
  const h = { scope: clone(scope), clock: Date.parse('2026-10-15T20:00:00.000Z'), connected: true, user: { id: ownerId }, qboCalls: 0, queries: [], data: { Users: [{ _id: ownerId, role: 'agent', connectionSwitchVersion: 4 }, { _id: actorId, role: 'agent' }], Connections: [{ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }], Memberships: [{ _id: 'd'.repeat(24), userId: ownerId, realmId: scope.realmId, role: 'lab-owner', status: 'active' }, { _id: 'e'.repeat(24), userId: actorId, realmId: scope.realmId, role: 'reviewer', status: 'active' }], Audits: [] } };
  h.models = Object.fromEntries(Object.keys(h.data).map(name => {
    const query = (filter, many) => {
      let sort = {}, limit = Infinity, populated = [];
      const q = { select() { return q; }, session() { return q; }, maxTimeMS(value) { if (value !== 3000) throw Error('Unexpected fixture query budget'); return q; }, hint(value) { if (JSON.stringify(value) !== JSON.stringify({userId:1,realmId:1,createdAt:-1})) throw Error('Wrong fixture index'); if (h.failHint) throw Error('Fixture index unavailable'); return q; }, sort(value) { sort = value; return q; }, limit(value) { limit = value; return q; }, skip() { return q; }, populate(value) { populated.push(value); return q; }, lean() { return q; }, async fetch() {
        if (h.onRead) await h.onRead(name, filter); if (h.failQuery === name) throw Error('Fixture read unavailable');
        let rows = h.data[name].filter(row => matches(row, filter)); rows.sort((a,b) => { for (const [key, direction] of Object.entries(sort)) { if (field(a,key) < field(b,key)) return -direction; if (field(a,key) > field(b,key)) return direction; } return 0; }); rows = clone(rows.slice(0,limit)); h.queries.push({ name, filter: clone(filter), limit, returned: rows.length });
        if (populated.includes('userId')) for (const row of rows) row.userId = { _id: row.userId, displayName: 'Fixture Owner' };
        return many ? rows : rows[0] || null;
      }, then(resolve,reject) { return q.fetch().then(resolve,reject); } }; return q;
    };
    return [name, { findOne: filter => query(filter,false), findById: id => query({_id:id},false), find: filter => query(filter,true), countDocuments: async filter => h.data[name].filter(row => matches(row,filter)).length,
      async updateOne(filter, update, options) { if (!options.session.inTransaction()) throw Error('Missing fixture transaction'); const row = h.data[name].find(value => matches(value,filter)); if (!row) return {matchedCount:0}; for (const [key,value] of Object.entries(update.$inc||{})) row[key] = (row[key]||0)+value; return {matchedCount:1}; },
      async create(rows, options) { if (!options.session.inTransaction()) throw Error('Missing fixture transaction'); if (h.failCreate === name) throw Error('Fixture write unavailable'); for (const row of rows) { if (h.data[name].some(value => value._id === row._id)) throw Error('Fixture duplicate ID'); h.data[name].push(clone(row)); } return clone(rows); }
    }];
  }));
  let queue = Promise.resolve();
  h.transaction = work => { const result = queue.then(async () => { if (h.beforeTransaction) { const callback=h.beforeTransaction;h.beforeTransaction=null;await callback(); } const before=h.data;h.data=clone(h.data);let value;try { value=await work({inTransaction:()=>true}); } catch(error) { h.data=before;throw error; } if(h.loseReply){h.loseReply=false;throw Error('Fixture lost commit acknowledgement');}return value; });queue=result.catch(()=>{});return result; };
  const original=createDefinitionsService(), summary=original.getSummary(); h.catalogHash=summary.hashes.catalog; h.reports=clone(original.listReports({offset:0,limit:1000}).items);
  h.definitions={getSummary:()=>({...summary,hashes:{...summary.hashes,catalog:h.catalogHash}}),listReports:()=>({items:clone(h.reports)})};
  h.accessFor=input=>createBusinessRuntimeAccess({...input,...h.models,environment:()=>h.scope.environment,createClient:async()=>{h.qboCalls++;throw Error('Manual evidence must never resolve a QBO client');}});
  h.service=createReportEvidenceService({models:h.models,connection:{},transaction:h.transaction,definitions:h.definitions,accessFor:h.accessFor,resolveContext:async()=>({environment:h.scope.environment,connection:{connected:h.connected,...h.scope,companyName:'Fixture Harbour Business'}}),now:()=>h.clock,assertReady:async()=>{if(h.notReady)C.fail('Fixture company storage is not prepared.');}});
  h.request=(key='report.balance-sheet', nonce='11111111-1111-4111-8111-111111111111')=>{const d=h.reports.find(row=>row.key===key);return{requestKey:nonce,scopeHash:hash(h.scope),catalogHash:h.catalogHash,reportKey:key,period:{fromDate:'2026-09-01',throughDate:'2026-09-30'},basis:'Accrual',filters:'No filters',observedOn:'2026-10-15',checks:Object.fromEntries(C.LEVELS.map(level=>[level,{status:level==='availability'?'passed':'not-checked',note:level==='availability'?'Owner opened the exact period and checked the visible company.':''}])),assertions:C.assertionDefinitions(d).map(row=>({key:row.key,status:'not-checked',note:''})),source:{reference:'Fixture September report export',procedure:'Owner opened the report for the displayed company and exact dates.',finding:'The report opened for the stated dates; the other evidence levels were not checked.'},confirmManual:true};};
  return h;
}
module.exports={fixture,scope,ownerId,actorId,matches};
