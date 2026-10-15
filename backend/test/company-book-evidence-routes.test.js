'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), http = require('node:http');
const { fixture, scope, ownerId } = require('./helpers/business-governance-fixture');
const { createCurrentAccountGuard } = require('../src/middleware/currentAccount');
const { issueToken } = require('../src/modules/auth-token');
const { createQboRouter } = require('../src/routes/qbo');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
async function routes(t, work) {
  const h = fixture(), account = {_id:ownerId,email:'report-reader@fixture.invalid',role:'agent',authVersion:0};
  for (const [name, file] of [['Users','User'],['Connections','Connection'],['Memberships','CompanyMembership']]) t.mock.method(require('../src/models/'+file), 'findOne', filter => h.models[name].findOne(filter));
  t.mock.method(require('../src/modules/qbo-client'), 'createQBOClient', async () => h.client);
  const app = express(); app.use(express.json()); app.use('/api',createCurrentAccountGuard({loadAccount:async()=>({...account})}));
  app.use('/api/qbo',createQboRouter({Connections:h.models.Connections})); app.use('/api/company',require('../src/routes/company'));
  const server = http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:'+server.address().port, token = issueToken(account);
  const request = (path,options={}) => fetch(origin+path,{headers:{authorization:'Bearer '+token},...options});
  try { await work(h,request); } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}
const period = '/api/company/book-evidence?fromDate=2026-10-01&throughDate=2026-10-06';
test('authenticated status and book results use the same current connection ID and keep full report sources private', async t=>routes(t,async(h,request)=>{
  const connection = h.data.Connections[0]; connection.refreshToken = 'fixture-token'; connection.refreshTokenExpiresAt = new Date(Date.now()+86400000); connection.tokenExpiresAt = new Date(Date.now()+3600000);
  h.data.Memberships[0].role = 'reviewer';
  const response = await request('/api/qbo/status'); assert.equal(response.status,200); const status = await response.json(); assert.equal(status.connectionId,scope.connectionId);
  const read = await request(period); assert.equal(read.status,200); assert.equal(read.headers.get('cache-control'),'no-store'); const body = await read.json();
  assert.equal(body.data.connectionId,status.connectionId); assert.equal(body.data.environment,status.environment); assert.equal(body.data.reportCoverage.required,7); assert.equal(body.data.reportCoverage.complete,true);
  assert.equal(h.posts,0); assert.equal(h.events.filter(event=>event.path.includes('/reports/')).length,7); assert.equal(body.data.sources,undefined); assert.equal(body.data.accounts,undefined); assert.equal(body.data.reports[5].Rows,undefined); assert.doesNotMatch(JSON.stringify(body),/fixture-token|gzip-canonical-json|refreshToken/);
  assert.equal((await request(period,{headers:{}})).status,401);
}));
test('report permission, revocation and connection changes stop actual route reads', async t=>routes(t,async(h,request)=>{
  h.data.Memberships[0].role='reviewer'; h.data.Memberships[0].permissionOverrides=['-reports.read'];
  // Invalid overrides fail closed; use suspended membership for an ordinary denial too.
  assert.equal((await request(period)).status,403); assert.equal(h.reads,0); h.data.Memberships[0].permissionOverrides=[]; h.data.Memberships[0].status='suspended'; assert.equal((await request(period)).status,403); assert.equal(h.reads,0);
  h.data.Memberships[0].status='active'; h.onGet=async()=>{h.data.Connections[0]._id='e'.repeat(24);}; const changed=await request(period); assert.equal(changed.status,409); assert.ok(h.reads<=2); assert.equal(h.posts,0);
}));
test('public report parameters, oversized detail and upstream authorization stay bounded and never expire the app session',async t=>routes(t,async(h,request)=>{
  for(const query of ['?realmId=456','?fromDate=2026-02-30','?throughDate=2026-10-01&throughDate=2026-10-02']) assert.equal((await request('/api/company/book-evidence'+query)).status,400);
  assert.equal(h.reads,0); const original=h.client.oauthClient.makeApiCall;
  h.client.oauthClient.makeApiCall=async()=>({status:401,json:{Fault:{Error:[{Message:'Fixture upstream denied'}]}}}); const denied=await request(period); assert.equal(denied.status,502); assert.equal((await denied.json()).qboStatus,401);
  h.client.oauthClient.makeApiCall=async options=>{const result=await original(options);if(options.url.includes('/reports/GeneralLedger'))result.json.Rows.Row=[{ColData:[{value:'x'.repeat(6000001)},{value:''}]}];return result;};
  const large=await request(period); assert.equal(large.status,409); assert.equal((await large.json()).code,'BUSINESS_REPORT_UNVERIFIED'); assert.equal(h.posts,0);
}));
