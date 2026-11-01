'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSettlementEvents } = require('../src/modules/bank-settlement-engine');
const { buildBankStatementEvidence } = require('../src/modules/bank-statement-evidence');
const openingEvidence = require('./fixtures/bank-opening-history-evidence.json');
const { generateBankStatementPackages } = require('../src/modules/bank-statement-package');
const { createBankingWorkspaceService } = require('../src/modules/banking-workspace-service');
const history = require('./fixtures/bank-settlement-history.json');
const clone = value => structuredClone(value);
let ui, httpReply, httpRequest;
test.before(async () => {
  const { build } = await import('rolldown');
  const front = path.resolve(__dirname, '../../frontend/src');
  const result = await build({
    input: 'bf5-test-entry', write: false, platform: 'node',
    external: id => !id.startsWith('.') && !path.isAbsolute(id) && !id.startsWith('@/') && id !== 'bf5-test-entry',
    transform: { jsx: { runtime: 'automatic' } },
    plugins: [{ name: 'bf5-offline-entry', resolveId(id) {
      if (id === 'bf5-test-entry') return id;
      if (process.env.BL2_UI_ROOT && id === './BankingResume') return path.join(front, 'components/banking/BankingResume.jsx');
      if (id.startsWith('@/')) return path.join(front, id.slice(2)) + '.js';
    }, load(id) {
      if (process.env.BL2_UI_ROOT) {
        const map = { 'BankingWorkspace.jsx': 'components/banking/BankingWorkspace.jsx', 'BankingResume.jsx': 'components/banking/BankingResume.jsx', 'banking.js': 'api/banking.js' };
        for (const [name, relative] of Object.entries(map)) if (id === path.join(front, relative)) return require('node:fs').readFileSync(path.join(process.env.BL2_UI_ROOT, name), 'utf8');
      }
      if (id === 'bf5-test-entry') return 'export * from ' + JSON.stringify(path.join(front, 'api/banking.js')) + '; export {BankingAccountPeriodView} from ' + JSON.stringify(path.join(front, 'components/banking/BankingAccountPeriod.jsx')) + '; export {BankingWorkspaceView} from ' + JSON.stringify(path.join(front, 'components/banking/BankingWorkspace.jsx'));
      if (id.endsWith('.css')) return { code: '', moduleType: 'js' };
    } }],
    output: { format: 'cjs' },
  });
  const filename = path.join(__dirname, 'bf5-offline-compiled.cjs'), compiled = new Module(filename, module);
  compiled.filename = filename; compiled.paths = module.paths;
  const axios = require('axios'), previousAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async config => { httpRequest = config; return { data: httpReply, status: 200, statusText: 'OK', headers: {}, config }; };
  try { compiled._compile(result.output.find(part => part.type === 'chunk').code, filename); } finally { axios.defaults.adapter = previousAdapter; }
  ui = compiled.exports;
});
const markup = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
function memoryService() {
  const packages = new Map(), artifacts = new Map(), scope = history.scope;
  const store = { assertReady: async () => {}, transaction: async work => work('memory'), fenceAccount: async () => {}, putEvent: async () => {},
    get: async (_scope, id) => packages.has(id) ? clone(packages.get(id)) : null,
    list: async (_scope, filters = {}) => [...packages.values()].filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)).map(clone),
    insert: async row => packages.set(row._id, clone(row)),
    replace: async (_scope, id, version, state) => { const row = packages.get(id); if (row.stateVersion !== version) return false; row.state = clone(state); row.stateVersion++; return true; },
  };
  const service = createBankingWorkspaceService({ store, now: () => new Date('2026-11-01T12:00:00Z'),
    resolveContext: async () => ({ environment: scope.environment, connection: { connected: true, connectionId: scope.connectionId, realmId: scope.realmId } }),
    authorize: async () => {}, getAccount: async (_scope, id) => history.accounts.find(account => account.id === id),
    readArtifact: async file => { const bytes = artifacts.get(file.path); assert.ok(bytes, 'Retained exact artifact'); return bytes; },
  });
  return { service, artifacts };
}
let replay;
async function storedHistory() {
  if (replay) return replay;
  const built = buildBankStatementEvidence(history, openingEvidence), data = built.dataset, generated = generateBankStatementPackages(data, { balanceEvidence: built.evidence }), h = memoryService(), user = { id: '2'.repeat(24) }, details = [];
  assert.equal(buildSettlementEvents(history).depositLinks.length, data.depositLinks.length);
  // Replay the production converters, persistence admission and detail serialization.
  // All stores are injected memory. No Mongo, QBO, providers or running app are used.
  for (const pkg of generated.packages) {
    for (const artifact of pkg.artifacts) h.artifacts.set(artifact.path, artifact.bytes);
    const saved = await h.service.register(user, pkg.envelope);
    details.push(await h.service.detail(user, saved.id));
  }
  replay = { data, generated, details, list: await h.service.list(user) };
  return replay;
}
test('real stored history: 324 BF4 account-months render separate stages and exact real record amounts', async t => {
  const { data, details, list } = await storedHistory();
  assert.equal(details.length, 324); assert.equal(data.depositLinks.length, 1385);
  assert.equal(details.filter(pkg => pkg.snapshot.blockers.length).length, 7);
  assert.equal(details.filter(pkg => !pkg.snapshot.blockers.length).length, 317);
  for (const pkg of details) {
    const state = ui.bankingPeriodState(pkg);
    assert.equal(state.stages[0].done, true); assert.equal(state.stages[3].done, false);
    assert.equal(state.stages[1].value, pkg.summary.uploadRequired ? 'Not confirmed' : 'Not required');
    const html = markup(ui.BankingAccountPeriodView, { pkg, accountName: 'Account #' + pkg.accountId });
    assert.match(html, /Not completed/); assert.match(html, /No native run evidence retained/);
    for (const reason of state.blockers) assert.ok(html.includes(reason.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')), reason);
  }
  for (const [entity, id, minor, legs] of [['Invoice','486',5000,1],['Payment','26',342349,1],['CreditCardPayment','483',null,2],['Transfer','343',null,2],['Transfer','345',null,2]]) {
    const found = details.flatMap(pkg => pkg.snapshot.events).filter(event => event.source.entity === entity && event.source.id === id);
    assert.equal(found.length, legs); if (minor !== null) assert.equal(found[0].amountMinor, minor);
  }
  assert.equal(details.flatMap(pkg => pkg.snapshot.events).filter(event => event.source.entity === 'JournalEntry' && event.source.id === '200').length, 0);
  assert.equal(list.qboCalls, 0);
  const html = markup(ui.BankingWorkspaceView, { data: list, loadedAt: '12:00', onRefresh() {} });
  assert.match(html, /324 account-months/); assert.match(html, /Next action.*blocked reason/); assert.match(html, /Not completed/);
  t.diagnostic('Replayed retained source ids 486/26/483/343/345 through OB/BF1 → BF2 → BF4 → BF5; 324 period views, 317 ready and seven blocked, 1385 deposit links; JE200 has no native cash.');
});
test('Terra evidence remains reported, screenshot reference retained, interrupted imports cannot imply upload', async () => {
  const pkg = clone((await storedHistory()).details.find(row => row.summary.uploadRequired));
  const ev = { strength: 'screen observed', observedAt: '2026-11-01T04:00:00Z', note: 'Import outcome uncertain', artifact: { path: 'retained/run/screen.png', sha256: 'a'.repeat(64) }, automation: { runId: 'terra-run-1', step: 'confirm-import', screenshotPath: 'retained/run/screen.png', outcome: 'interrupted' } };
  pkg.evidence.imports = [{ attemptId: 'attempt-1', status: 'interrupted', fileId: pkg.snapshot.files[0].fileId, fileHash: pkg.snapshot.files[0].sha256, accountId: pkg.accountId, accountCurrency: pkg.accountCurrency, evidence: [ev] }];
  pkg.evidence.rows[pkg.snapshot.rows[0].rowId].reviewed = { decision: 'pending', reason: 'Ambiguous native match', evidence: { ...ev, strength: 'operator attested', automation: undefined } };
  pkg.summary.reviewed = 1;
  const html = markup(ui.BankingAccountPeriodView, { pkg, accountName: 'Test bank' });
  for (const text of ['Terra-reported', 'terra-run-1', 'screen.png', 'not been independently verified', 'operator attested', 'Ambiguous native match', 'Interrupted import', 'Not confirmed', 'Not completed']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('src="retained/run/screen.png"'));
  assert.equal(ui.bankingPeriodState(pkg).stages[3].done, false);
});
test('native report, synced record and attestation labels remain distinct; revised history stays visible', async () => {
  const pkg = clone((await storedHistory()).details[0]);
  pkg.summary.needsReview = true; pkg.summary.reconciled = true;
  pkg.evidence.reconciled = { report: { strength: 'native report retained', note: 'Completed report retained', artifact: { path: 'reports/native.pdf', sha256: 'b'.repeat(64) } } };
  pkg.evidence.rows = { r1: { synced: [{ strength: 'synced record observed', entity: 'Purchase', id: '99', recordHash: 'c'.repeat(64) }] } };
  const html = markup(ui.BankingAccountPeriodView, { pkg, accountName: 'Test bank' });
  for (const text of ['History needs review', 'Evidence retained', 'native report retained', 'synced record observed', 'reports/native.pdf']) assert.ok(html.includes(text), text);
});
test('latest revisions, quiet months and exact currency amounts do not invent work or round money', async () => {
  const { details } = await storedHistory(), quiet = details.find(pkg => !pkg.summary.uploadRequired);
  assert.equal(ui.bankingPeriodState(quiet).stages[1].value, 'Not required');
  assert.match(markup(ui.BankingAccountPeriodView, { pkg: quiet, accountName: 'Quiet bank' }), /No CSV upload required/);
  const old = { ...quiet, revision: 1 }, next = { ...quiet, id: 'revised', revision: 2 };
  assert.deepEqual(ui.currentBankingPackages([next, old]), [next]);
  assert.equal(ui.bankMoney(342349, 'CAD'), 'CAD 3,423.49');
  assert.equal(ui.bankMoney(Number.MAX_SAFE_INTEGER, 'USD'), 'USD 90,071,992,547,409.91');
});
test('initial, empty, stale, unavailable and truncated views tell the user what happened', () => {
  assert.match(markup(ui.BankingWorkspaceView, { loading: true }), /Loading account-month packages/);
  assert.match(markup(ui.BankingWorkspaceView, { data: { packages: [] } }), /No banking packages yet/);
  assert.match(markup(ui.BankingWorkspaceView, { data: { packages: [] }, error: 'Offline' }), /Saved view may be out of date/);
  assert.match(markup(ui.BankingWorkspaceView, { error: 'Banking is not available on this server yet' }), /not available on this server/);
  assert.match(markup(ui.BankingWorkspaceView, { data: { packages: [], truncated: true } }), /Coverage is incomplete/);
});

test('read API rejects misrouted responses and altered file bytes; downloads keep server-owned scope', async t => {
  const priorStorage = global.localStorage;
  global.localStorage = { getItem: () => null };
  t.after(() => { if (priorStorage === undefined) delete global.localStorage; else global.localStorage = priorStorage; });
  httpReply = '<html>Vite fallback</html>';
  await assert.rejects(ui.bankingApi.list(), /did not return a banking workspace/);
  httpReply = { data: { packages: [] } };
  assert.deepEqual(await ui.bankingApi.list(), { packages: [] });
  assert.equal(httpRequest.url, '/company/banking-workspace');
  httpReply = { data: { id: 'other', snapshot: {}, evidence: {} } };
  await assert.rejects(ui.bankingApi.detail('expected'), /requested banking package/);
  const bytes = 'retained simulated statement', file = { fileId: 'statement', sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
  httpReply = new Blob([bytes]);
  assert.equal(await (await ui.bankingApi.file('package', file)).text(), bytes);
  assert.equal(httpRequest.url, '/company/banking-workspace/packages/package/files/statement');
  assert.equal(httpRequest.params, undefined);
  httpReply = new Blob(['changed']);
  await assert.rejects(ui.bankingApi.file('package', file), /file has changed/);
});

test('BF7 journal displays observed versus Terra-reported checks and refuses another package scope', async () => {
  const pkg = (await storedHistory()).details[0];
  const status = { packageId: pkg.id, accountId: pkg.accountId, period: pkg.period, blocked: true,
    reasons: [{ runId: 'stopped-1', period: pkg.period, status: 'blocked', reason: 'Native account is ambiguous' }],
    steps: [{ runId: 'observed-1', scope: pkg.snapshot.scope, packageId: pkg.id, accountId: pkg.accountId, period: pkg.period, step: { type: 'review' }, status: 'completed', verification: { status: 'observed', checks: [{ rowId: 'r1', status: 'observed', basis: 'synced record observed' }] } },
      { runId: 'reported-1', scope: pkg.snapshot.scope, packageId: pkg.id, accountId: pkg.accountId, period: pkg.period, step: { type: 'upload' }, status: 'completed', verification: { status: 'Terra-reported only' }, screen: { artifact: { path: 'upload.png', sha256: 'a'.repeat(64) } } }],
  };
  const html = markup(ui.BankingAccountPeriodView, { pkg, accountName: 'Test bank', operatorStatus: status });
  for (const text of ['Observed', 'Terra-reported only', 'Native account is ambiguous', 'observed-1', 'upload.png', 'synced record observed']) assert.ok(html.includes(text), text);
  const wrong = clone(status); wrong.steps[0].scope.realmId = 'other';
  assert.equal(ui.bankingOperatorStatus(pkg, wrong), null);
  assert.equal(ui.bankingOperatorStatus(pkg, { ...status, packageId: 'other' }), null);
});

test('BL2 real stop reason, auto retry limit and owner resolution form appear in the workspace',()=>{
 const fixture=require('./fixtures/banking-bl-real-stop.json');
 const loop={paused:true,canResume:true,packageId:fixture.result.packageId,at:fixture.journal.startedAt,reason:fixture.result.reason,requiresInspection:false,automaticRetry:{eligible:true,attempts:1,maxAttempts:3,reason:'Operator contract changed; retry after process-exit verification'}};
 const html=markup(ui.BankingWorkspaceView,{data:{packages:[],operatorLoop:loop},onRefresh(){}});
 for(const label of ['Scheduled banking is paused','ID-backed rules inspection','Automatic retries: 1 of 3','How was this stop resolved?','Resume banking'])assert.ok(html.includes(label),label);
 assert.match(html,/<textarea[^>]*required/);assert.match(html,/<button[^>]*disabled[^>]*>Resume banking/);
 const unsafe=markup(ui.BankingWorkspaceView,{data:{packages:[],operatorLoop:{...loop,requiresInspection:true}},onRefresh(){}});assert.match(unsafe,/Saved inspection reference/);assert.match(unsafe,/Accepted or uncertain actions/);
 const reader=markup(ui.BankingWorkspaceView,{data:{packages:[],operatorLoop:{...loop,canResume:false}}});assert.ok(!reader.includes('Resume banking'));assert.match(reader,/company owner/);
});
test('BL2 API sends only package and recorded resolution to authenticated company route',async t=>{
 const prior=global.localStorage;global.localStorage={getItem:()=>null};t.after(()=>{if(prior===undefined)delete global.localStorage;else global.localStorage=prior;});
 httpReply={data:{resolved:true,packageId:'exact-package'}};
 const resolution={reason:'Visible-rule contract fixed'};assert.deepEqual(await ui.bankingApi.resume('exact-package',resolution),{resolved:true,packageId:'exact-package'});assert.equal(httpRequest.method,'post');assert.equal(httpRequest.url,'/company/banking-workspace/operator/resume');assert.deepEqual(JSON.parse(httpRequest.data),{packageId:'exact-package',resolution});
 httpReply='<html>fallback</html>';await assert.rejects(ui.bankingApi.resume('exact-package',resolution),/did not confirm/);
});
