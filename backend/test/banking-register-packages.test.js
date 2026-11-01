'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const load = import(pathToFileURL(path.join(root, 'scripts/banking/register-packages.mjs')));
const hasReal = require('node:fs').existsSync(path.join(root, 'artifacts/goal-realization/job-ob-20261101/replay-result.json'));
const realTest = (name, fn) => test(name, { skip: !hasReal && 'Private real banking replay artifacts unavailable' }, fn);
const real = hasReal ? load.then(async m => {
  const plan = await m.loadPlan(), saved = await m.savingsEvidence(plan);
  return { m, plan, saved };
}) : Promise.resolve(null);
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const run = (args, cwd = root) => new Promise(resolve => execFile(process.execPath, args, {
  cwd, windowsHide: true, timeout: 60000, maxBuffer: 20 * 1024 * 1024,
}, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));

realTest('real 324 account-month index: 317 READY validate individually; 208 register in order, 109 blocked by 7 skipped drafts', async t => {
  const { plan } = await real;
  assert.equal(plan.ready.length, 317); assert.equal(plan.drafts.length, 7);
  assert.equal(plan.offline.rows.size, 208); assert.equal(plan.deferred.length, 109);
  for (let i = 1; i < plan.ready.length; i++) assert.ok(plan.ready[i-1].envelope.period <= plan.ready[i].envelope.period);
  assert.equal(plan.drafts.filter(p => p.blockers.length).length, 7);
  t.diagnostic('Real bytes: manifest hashes, CSV dates/amounts, PDF hashes, row crosswalks and carry-forward validated by banking-workspace-service.register.');
});

realTest('real Savings Transfer591 evidence replays import -> review -> match without claiming missing native report', async () => {
  const { m, plan, saved } = await real, r = await m.replaySavings(plan, saved);
  assert.deepEqual(r.bodies.map(c => c.body.action), ['start','uploaded','reviewed','matched']);
  assert.equal(r.current.summary.uploaded, true);
  assert.equal(r.current.summary.matched, 1);
  assert.equal(r.current.summary.reconciled, false);
  assert.match(saved.limitation, /report/);
  assert.deepEqual(Object.values(r.current.evidence.rows)[0].matched.qboRefs, [{ entity: 'Transfer', id: '591' }]);
  assert.match(r.bodies[1].body.nativeConfirmation, /local observation key/);
  assert.match(r.bodies[3].body.reason, /Reconciled through/);
  assert.equal(r.current.evidence.imports.length, 1);
});

realTest('production reconciliation validator refuses to label retained completion screenshot as native report', async () => {
  const { m, plan, saved } = await real, r = await m.replaySavings(plan, saved);
  const pkg = r.current, a = saved.assets;
  await assert.rejects(r.workspace.service.recordReconciliation(r.workspace.user, pkg.id, {
    requestId: 'missing-native-report', expectedVersion: pkg.stateVersion, action: 'reconciled',
    accountId: pkg.accountId, accountCurrency: pkg.accountCurrency, period: pkg.period,
    evidence: a.register.evidence, report: a.register.evidence, completion: a.completion.evidence,
    statementAttachment: a.attachment.evidence, openingMinor: 0, closingMinor: 100000,
    differenceMinor: 0, outstandingItems: [],
  }), /completed native report/);
});

function apiFor(h, m, calls, failAfter) {
  return async (method, route, body) => {
    calls.push({ method, route, body });
    let value;
    if (method === 'GET') return route === m.ROUTE ? { ...await h.service.list(h.user), operatorLoop: { enabled: false } } : h.service.detail(h.user, route.split('/').pop());
    if (route === m.ROUTE + '/packages') value = await h.service.register(h.user, body);
    else {
      const parts = route.split('/'), suffix = parts.pop(), id = parts.pop();
      value = await h.service[{ imports: 'recordImport', rows: 'recordRow', reconciliation: 'recordReconciliation' }[suffix]](h.user, id, body);
    }
    if (failAfter?.(body)) throw new Error('Offline injected lost response AFTER saved action');
    return value;
  };
}
realTest('full real plan via same service path: register 208, defer 109, skip by content hash on repeat, retain single import/match', async () => {
  const { m, plan, saved } = await real;
  const bytes = new Map(Object.values(saved.assets).map(a => [a.artifact.path, a.bytes]));
  const reader = a => bytes.has(a.path) ? Promise.resolve(bytes.get(a.path)) : plan.sourceReader(a);
  const h = m.offlineWorkspace(plan.scope, plan.ready.map(p => p.envelope), reader);
  const calls = [], api = apiFor(h, m, calls);
  const first = await m.registerPlan(plan, saved, api);
  assert.equal(first.registered.length, 208); assert.equal(first.savings.matched, 1);
  assert.equal(first.savings.workspaceReconciled, false);
  const count = calls.length;
  const second = await m.registerPlan(plan, saved, api);
  assert.equal(second.skipped.length, 208); assert.equal(second.registered.length, 0);
  assert.equal(calls.slice(count).filter(c => c.method === 'POST').length, 0);
});
realTest('lost uploaded response resumes existing history without duplicating accepted upload', async () => {
  const { m, plan, saved } = await real;
  const p = saved.package, small = { ...plan, ready: [p] };
  const bytes = new Map(Object.values(saved.assets).map(a => [a.artifact.path, a.bytes]));
  const h = m.offlineWorkspace(plan.scope, [p.envelope], a => bytes.has(a.path) ? Promise.resolve(bytes.get(a.path)) : plan.sourceReader(a));
  const calls = [];
  await assert.rejects(m.registerPlan(small, saved, apiFor(h, m, calls, b => b?.action === 'uploaded')), /lost response/);
  const before = calls.length;
  const result = await m.registerPlan(small, saved, apiFor(h, m, calls));
  assert.equal(result.savings.matched, 1);
  assert.deepEqual(calls.slice(before).filter(c => c.method === 'POST').map(c => c.body.action), ['reviewed','matched']);
});
realTest('hash collision and truncated inventory stop before any POST', async () => {
  const { m, plan, saved } = await real;
  for (const value of [{ truncated: true, packages: [] }, { truncated: false, operatorLoop: { enabled: false }, packages: [{ id: plan.ready[0].id, contentHash: '0'.repeat(64) }] }]) {
    let posts = 0;
    await assert.rejects(m.registerPlan(plan, saved, async method => { if (method === 'POST') posts++; return value; }), /inventory|hash mismatch/);
    assert.equal(posts, 0);
  }
});
realTest('optional native report path validates complete reconciliation command offline (test report explicitly synthetic)', async t => {
  const { m, plan, saved } = await real;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-report-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const reportBytes = Buffer.from('%PDF-1.4\nSYNTHETIC TEST NATIVE REPORT ADAPTER\n');
  const artifact = { path: saved.assets.register.artifact.path.replace(/[^/]+$/, 'synthetic-native-report.pdf'), sha256: digest(reportBytes) };
  const supplied = { ...saved, assets: { ...saved.assets, report: { bytes: reportBytes, artifact, evidence: {
    strength: 'native report retained', observedAt: '2026-11-01T04:00:00Z',
    note: 'Synthetic test adapter only; no native live report is present.', artifact,
  } } }, limitation: null };
  const result = await m.replaySavings(plan, supplied);
  assert.equal(result.current.summary.reconciled, true);
  assert.equal(result.bodies.at(-1).suffix, 'reconciliation');
  // A generated simulated statement is never accepted as a native report.
  const statement = saved.package.envelope.files.find(f => f.kind === 'statement');
  await fs.writeFile(path.join(dir, 'descriptor.json'), JSON.stringify({
    path: m.DEFAULT_SOURCE + '/packages/' + statement.path, sha256: statement.sha256,
    accountId: '1150040007', period: '2026-10', observedAt: '2026-11-01T04:00:00Z', note: 'Wrong report',
  }));
  await assert.rejects(m.savingsEvidence(plan, { nativeReport: path.join(dir, 'descriptor.json') }), /Simulated statement/);
});

realTest('CLI dry-run lists exact full API paths and bodies; no auth helper or staging artifacts', async () => {
  const r = await run(['scripts/banking/register-packages.mjs', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  const rows = r.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.filter(r => r.type === 'would-post-unless-hash-registered').length, 208);
  assert.equal(rows.filter(r => r.type === 'defer-ready-carry-forward').length, 109);
  assert.equal(rows.filter(r => r.type === 'skip-draft').length, 7);
  assert.equal(rows.filter(r => r.type === 'would-post-if-missing').length, 4);
  assert.ok(rows.filter(r => r.method).every(r => r.path.startsWith('/api/company/banking-workspace/packages')));
});
test('api transport reuses helper, passes prefix once and saves bodies without leaking stdout; rejects other routes', async t => {
  const m = await load, dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-helper-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'artifacts/luna/tmp'), { recursive: true });
  await fs.writeFile(path.join(dir, 'artifacts/luna/tmp/api.js'), [
    "const fs=require('node:fs');",
    "fs.writeFileSync(process.env.API_OUT,JSON.stringify({data:{method:process.argv[2],path:process.argv[3]}}));",
    "console.log('200 (saved)');",
  ].join('\n'));
  const request = m.apiTransport({ root: dir, directory: dir });
  assert.deepEqual(await request('GET', m.ROUTE), { method: 'GET', path: '/company/banking-workspace' });
  await assert.rejects(request('POST', '/qbo/anything', {}), /Disallowed/);
});


realTest('enabled or unknown native loop refuses registration before any POST', async () => {
  const { m, plan, saved } = await real;
  for (const operatorLoop of [undefined, { enabled: true }]) {
    let posts = 0;
    await assert.rejects(m.registerPlan(plan, saved, async method => {
      if (method === 'POST') posts++;
      return { packages: [], truncated: false, operatorLoop };
    }), /observed disabled/);
    assert.equal(posts, 0);
  }
});
realTest('pre-existing later statement refuses backfill before any POST', async () => {
  const { m, plan, saved } = await real;
  let posts = 0;
  await assert.rejects(m.registerPlan(plan, saved, async method => {
    if (method === 'POST') posts++;
    return { packages: [{ id: saved.package.id, contentHash: saved.package.contentHash, accountId: '1150040007', period: '2026-10' }], operatorLoop: { enabled: false }, truncated: false };
  }), /Backfill/);
  assert.equal(posts, 0);
});
realTest('completed Savings must retain exact Transfer591 outcome and no needs-review flag', async () => {
  const { m, plan, saved } = await real, r = await m.replaySavings(plan, saved);
  const current = r.current, small = { ...plan, ready: [saved.package] };
  for (const mutate of [
    p => { p.summary.needsReview = true; },
    p => { p.evidence.rows[p.snapshot.rows[0].rowId].matched.qboRefs = [{ entity: 'Deposit', id: '11232' }]; },
  ]) {
    const wrong = structuredClone(current);
    wrong.summary.reconciled = true;
    wrong.evidence.reconciled = { openingMinor: 0, closingMinor: 100000, differenceMinor: 0 };
    mutate(wrong);
    await assert.rejects(m.registerPlan(small, saved, async (_method, route) => route === m.ROUTE ? {
      packages: [wrong], operatorLoop: { enabled: false }, truncated: false,
    } : wrong), /inspect/);
  }
});
realTest('artifact staging writes immutable namespaced bytes; rejects destination junction escape', async t => {
  const { m, plan, saved } = await real;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-stage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'project'), escaped = path.join(dir, 'outside');
  await fs.mkdir(path.join(local, 'artifacts/banking'), { recursive: true });
  await fs.mkdir(escaped);
  const small = { ...plan, ready: [saved.package] };
  await m.stageArtifacts(small, saved, { root: local });
  await m.stageArtifacts(small, saved, { root: local }); // exact existing bytes accepted
  const f = saved.package.envelope.files[0];
  assert.equal(digest(await fs.readFile(path.join(local, 'artifacts/banking', f.path))), f.sha256);
  const bad = path.join(dir, 'badproject');
  await fs.mkdir(path.join(bad, 'artifacts/banking'), { recursive: true });
  const namespace = f.path.split('/')[0];
  await fs.symlink(escaped, path.join(bad, 'artifacts/banking', namespace), 'junction');
  await assert.rejects(m.stageArtifacts(small, saved, { root: bad }), /junction escapes/);
  assert.equal((await fs.readdir(escaped)).filter(n => n.endsWith('.csv')).length, 0);
});
