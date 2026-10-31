'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessReportReader } = require('../src/modules/business-report-evidence');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { fixture, period } = require('./helpers/business-report-fixtures');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, actorId = 'b'.repeat(24), ownerId = 'c'.repeat(24);
function harness() {
  const h = { clock: Date.parse('2026-10-06T12:00:00.000Z'), reports: fixture({ critical: true }), calls: [], accounts: [{ Id: '1', SyncToken: '0', AccountType: 'Accounts Receivable' }, { Id: '2', SyncToken: '0', AccountType: 'Accounts Payable' }], reads: 0 };
  h.reports.TrialBalance.Rows.Row[0].ColData[0].id = '1'; h.reports.TrialBalance.Rows.Row[1].ColData[0].id = '2';
  h.client = Object.create(QBOClient.prototype);
  Object.assign(h.client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    h.calls.push(options); if (h.onRead) await h.onRead(options);
    const url = new URL(options.url), name = url.pathname.split('/').at(-1);
    if (name === 'query') return { status: 200, json: h.accountResponse || { QueryResponse: { Account: h.accounts, startPosition: 1, maxResults: h.accounts.length } } };
    return { status: 200, json: structuredClone(h.reports[name]) };
  } } });
  h.access = { authorize: async (_scope, action) => { assert.deepEqual(_scope, scope); assert.equal(action, 'operations.verify'); if (h.revoked) throw new Error('permission revoked'); h.reads++; return { actorId, ownerId: h.ownerChanged && h.reads > 1 ? 'd'.repeat(24) : ownerId }; }, resolveClient: async () => h.client };
  h.read = options => createBusinessReportReader({ access: h.access, now: () => h.clock })(scope, period, options);
  return h;
}
test('retains full scoped report sources with reproducible hash and named checks', async () => {
  const h = harness(), result = await h.read();
  assert.equal(result.evaluation.status, 'checks-passed'); assert.equal(h.calls.length, 8); assert.ok(h.calls.every(row => row.method === 'GET'));
  assert.ok(h.calls.some(row => decodeURIComponent(row.url).includes('Active IN (true, false)')));
  const { sourceHash, evaluation, ...source } = result; assert.equal(sourceHash, hash(source)); assert.equal(Object.keys(source.reports).length, 7);
});
test('wrong company or substituted transport is rejected before provider access', async () => {
  for (const mutate of [h => { h.client.connection.realmId = '456'; }, h => { h.client.connection.userId = actorId; }, h => { h.client.query = async () => ({}); }, h => { h.client.connection.status = 'inactive'; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.read(), /client/); assert.equal(h.calls.length, 0);
  }
});
test('missing or wrong-scope report totals cannot pass required checks', async () => {
  const h = harness(); h.reports.TrialBalance.Header.Currency = 'USD'; const result = await h.read(); assert.equal(result.evaluation.checks[0].status, 'unverified');
});
test('complete account observation rejects projected, repeated, warning or truncated pages', async () => {
  for (const response of [{ QueryResponse: { Account: [{ Id: '1' }], startPosition: 1 } }, { QueryResponse: { Account: [{ Id: '1', SyncToken: '0', AccountType: 'Bank' }, { Id: '1', SyncToken: '0', AccountType: 'Bank' }], startPosition: 1 } }, { QueryResponse: {}, warnings: [] }, { QueryResponse: { Account: [], totalCount: 1 } }]) {
    const h = harness(); h.accountResponse = response; await assert.rejects(h.read(), /account/i);
  }
});
test('revoked or changed authority discards already-observed sources', async () => {
  const h = harness(); h.onRead = async () => { h.revoked = true; }; await assert.rejects(h.read(), /revoked/);
  const changed = harness(); changed.ownerChanged = true; await assert.rejects(changed.read(), /authority changed/);
});
test('cancelled reads do not start provider calls and late results are discarded', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(); await assert.rejects(h.read({ signal: controller.signal }), /cancelled/); assert.equal(h.calls.length, 0);
  const late = harness(); late.onRead = async () => { late.clock += 180001; }; await assert.rejects(late.read(), /three minutes/);
});

test('present non-array account values and report warnings are never accepted as complete', async () => {
  for (const Account of [null, false, 0, {}]) { const h = harness(); h.accountResponse = { QueryResponse: { Account } }; await assert.rejects(h.read(), /Account pagination/); }
  const h = harness(); h.reports.TrialBalance.Warning = 'partial'; await assert.rejects(h.read(), /warnings/);
});

test('baseline report purpose is fixed by trusted composition and cannot authorize operation verification', async () => {
  const h = harness(), actions = [];
  h.access.authorize = async (_scope, action) => { actions.push(action); assert.equal(action, 'baseline.capture'); return { actorId, ownerId }; };
  const read = createBusinessReportReader({ access: h.access, now: () => h.clock, purpose: 'baseline' });
  const result = await read(scope, period, { purpose: 'operation', action: 'operations.verify' });
  assert.equal(result.evaluation.status, 'checks-passed'); assert.equal(actions.length, 26); assert.ok(actions.every(action => action === 'baseline.capture'));
  assert.throws(() => createBusinessReportReader({ access: h.access, purpose: 'arbitrary' }), /purpose/);
});

test('first401 or429 preserves the original error and stops a sibling waiting on token preparation',async()=>{
 const original=console.error;console.error=()=>{};try{for(const status of [401,429]){
  const h=harness();let preparations=0,secondEntered,release;const second=new Promise(resolve=>{secondEntered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  h.client.ensureFreshToken=async()=>{if(++preparations===1)await second;else{secondEntered();await held;}};
  h.client.oauthClient.makeApiCall=async options=>{h.calls.push(options);return{status,headers:{intuit_tid:'fixture-first-failure'},json:{Fault:{Error:[{Message:'Fixture read refused'}]}}};};
  try{await assert.rejects(h.read(),error=>error.status===status&&error.intuit_tid==='fixture-first-failure');assert.equal(h.calls.length,1);}
  finally{release();await new Promise(setImmediate);}
  assert.equal(h.calls.length,1,'the delayed sibling cannot enter SDK after failure');
 }}finally{console.error=original;}
});
test('authority, company and deadline are checked after token preparation before the first SDK entry',async()=>{
 for(const mutate of [h=>{h.revoked=true;},h=>{h.client.connection.realmId='456';},h=>{h.clock+=180001;}]){const h=harness();h.client.ensureFreshToken=async()=>mutate(h);await assert.rejects(h.read());assert.equal(h.calls.length,0);}
});
test('a complete4000-account observation makes exactly twelve controlled SDK requests without changing source shape',async()=>{
 const h=harness(),admitted=[],records=Array.from({length:4000},(_,i)=>({Id:String(i+1),SyncToken:'0',AccountType:i===0?'Accounts Receivable':i===1?'Accounts Payable':'Bank'}));
 h.client.oauthClient.makeApiCall=async options=>{h.calls.push(options);const url=new URL(options.url),name=url.pathname.split('/').at(-1);if(name!=='query')return{status:200,json:structuredClone(h.reports[name])};const query=url.searchParams.get('query'),start=Number(query.match(/STARTPOSITION (\d+)/)[1]),Account=records.slice(start-1,start+999);return{status:200,json:{QueryResponse:{Account,startPosition:start,maxResults:Account.length,totalCount:Account.length}}};};
 const source=await createBusinessReportReader({access:h.access,now:()=>h.clock,onAttempt:count=>admitted.push(count)})(scope,period);assert.equal(h.calls.length,12);assert.deepEqual(admitted,Array.from({length:12},(_,i)=>i+1));assert.equal(source.accounts.length,4000);assert.ok(h.calls.every(options=>options.maxRetries===1));
 const {sourceHash,evaluation,...raw}=source;assert.equal(Object.keys(raw).sort().join(','),'accounts,observedAt,period,reports,scope,startedAt,version');assert.equal(hash(raw),sourceHash);
});

test('invoice approval reads only relevant reports and never requests unavailable payables or cash flow',async()=>{
 const h=harness(),{approvalReportNames,evaluateApprovalReportSources}=require('../src/modules/business-report-source');
 const requiredReports=approvalReportNames({activityBatch:{},records:[{entity:'Invoice'}]});
 h.access.authorize=async()=>({actorId,ownerId});h.onRead=options=>{assert.ok(!/AgedPayables|CashFlow/.test(options.url));};
 delete h.reports.AgedPayables;delete h.reports.CashFlow;
 const result=await createBusinessReportReader({access:h.access,now:()=>h.clock,purpose:'preparation',requiredReports})(scope,period);
 assert.equal(h.calls.length,6);assert.equal(result.evaluation.status,'checks-passed');assert.equal(result.evaluation.reportCoverage.required,5);assert.ok(result.evaluation.checks.some(check=>check.key==='receivables'));
 const raw=require('../src/modules/business-report-source').unpackReport('TrialBalance',result.reports.TrialBalance,3);raw.Header.Currency='USD';result.reports.TrialBalance=require('../src/modules/business-report-source').packReport('TrialBalance',raw,3);assert.notEqual(evaluateApprovalReportSources(result,requiredReports).status,'checks-passed');
});
test('nonposting approval transports no financial reports or account query',async()=>{
 const h=harness();h.access.authorize=async()=>({actorId,ownerId});const result=await createBusinessReportReader({access:h.access,now:()=>h.clock,purpose:'preparation',requiredReports:[]})(scope,period);assert.equal(h.calls.length,0);assert.equal(result.evaluation.status,'checks-passed');
});
