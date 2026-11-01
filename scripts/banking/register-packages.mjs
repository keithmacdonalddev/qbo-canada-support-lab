#!/usr/bin/env node
// Registers local evidence only; no QBO client or database writer.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { createBankingWorkspaceService, createArtifactReader, hash } = require('../../backend/src/modules/banking-workspace-service');
const { createBankingAccountantTools } = require('../../backend/src/modules/banking-accountant-tools');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ROUTE = '/company/banking-workspace'; // api.js prepends /api
export const SAVINGS_ID = '07375dd6f1efdd11d4ef11c99dda172c31010b3d040c674e5b1c983f6696bb56';
export const DEFAULT_SOURCE = 'artifacts/goal-realization/job-ob-20261101';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => hash(a) === hash(b);
const observationRoot = 'artifacts/terra-live/qbo-ops-20261101-011242';
const observations = {
  upload: 'artifacts/terra-live/qbo-ops-20261101-010117/upload-result.png',
  match: observationRoot + '/register-matched.png',
  completion: observationRoot + '/reconciled.png',
  attachment: observationRoot + '/attachment.png',
  register: observationRoot + '/register-final.png',
  reported: observationRoot + '/reply.txt',
  rules: 'artifacts/terra-live/qbo-ops-20261101-010805/rules-disabled.png',
};

export function offlineWorkspace(scope, envelopes, readArtifact, now = () => new Date()) {
  const rows = new Map(), events = new Map(), user = { id: '2'.repeat(24), role: 'supervisor' };
  // Account adapters are explicitly offline stand-ins. Live BF4 rechecks the mirror.
  const accounts = new Map(envelopes.map(p => [p.accountId, {
    Id: p.accountId, AccountType: p.balanceConvention === 'card-amount-owed' ? 'Credit Card' : 'Bank',
    CurrencyRef: { value: p.accountCurrency },
  }]));
  const store = {
    assertReady: async () => {},
    transaction: async work => {
      const before = structuredClone([...rows]), beforeEvents = structuredClone([...events]);
      try { return await work(null); } catch (e) {
        rows.clear(); events.clear();
        for (const entry of before) rows.set(...entry);
        for (const entry of beforeEvents) events.set(...entry);
        throw e;
      }
    },
    fenceAccount: async () => {},
    get: async (_s, id) => rows.has(id) ? structuredClone(rows.get(id)) : null,
    list: async (_s, filter = {}) => [...rows.values()].filter(r => Object.entries(filter).every(([k,v]) => r[k] === v)).map(r => structuredClone(r)),
    putEvent: async row => { assert(!events.has(row._id) || events.get(row._id) === row.contentHash, 'Event revision content conflict'); events.set(row._id, row.contentHash); },
    insert: async row => { assert(!rows.has(row._id), 'Duplicate package'); rows.set(row._id, structuredClone(row)); },
    replace: async (_s, id, version, state) => {
      const row = rows.get(id);
      if (!row || row.stateVersion !== version) return false;
      row.state = structuredClone(state); row.stateVersion++; return true;
    },
  };
  const service = createBankingWorkspaceService({
    store, now, readArtifact, authorize: async () => {},
    resolveContext: async () => ({ environment: scope.environment, connection: { connected: true, ...scope } }),
    getAccount: async (_s, id) => accounts.get(id),
  });
  return { service, user, rows };
}

export async function loadPlan({ root = ROOT, source = DEFAULT_SOURCE } = {}) {
  const sourceRoot = path.resolve(root, source);
  const index = JSON.parse(await fs.readFile(path.join(sourceRoot, 'replay-result.json'), 'utf8'));
  assert(index.version === 1 && Array.isArray(index.periods), 'Unsupported replay index');
  const sourceReader = createArtifactReader(path.join(sourceRoot, 'packages'));
  const ready = [], drafts = [], seen = new Set();
  for (const p of index.periods) {
    assert(typeof p.ready === 'boolean' && !seen.has(p.packageId), 'Ambiguous readiness or duplicate package id');
    seen.add(p.packageId);
    if (!p.ready) { drafts.push({ id: p.packageId, accountId: p.accountId, period: p.period, blockers: p.blockers }); continue; }
    const mf = p.files.filter(f => f.kind === 'manifest');
    assert(mf.length === 1, 'One retained manifest required');
    let envelope;
    // Exact production BF6 manifest -> BF4 conversion, rather than a second schema.
    await createBankingAccountantTools({
      readArtifact: sourceReader,
      workspace: { register: async (_user, value) => { envelope = value; } },
    }).execute(null, 'prepareBankingPackage', { manifest: { path: mf[0].path, sha256: mf[0].sha256 } });
    const manifest = JSON.parse((await sourceReader({ path: mf[0].path, sha256: mf[0].sha256 })).toString('utf8'));
    assert(same(envelope.scope, index.scope) && manifest.readyForNativeWork === true && envelope.blockers.length === 0, 'READY package scope/readiness mismatch');
    assert(manifest.packageId === p.packageId && envelope.accountId === p.accountId && envelope.period === p.period, 'Index/manifest identity mismatch');
    ready.push({ id: p.packageId, envelope, manifestHash: mf[0].sha256 });
  }
  ready.sort((a,b) => a.envelope.period.localeCompare(b.envelope.period) || a.envelope.accountId.localeCompare(b.envelope.accountId, undefined, { numeric: true }) || a.envelope.revision - b.envelope.revision);
  const offline = offlineWorkspace(index.scope, ready.map(p => p.envelope), sourceReader);
  const deferred = [];
  for (const p of ready) {
    const one = offlineWorkspace(index.scope, [p.envelope], sourceReader);
    const checked = await one.service.register(one.user, p.envelope);
    assert(checked.id === p.id, 'Production package hash differs from index');
    p.contentHash = checked.contentHash;
    try { await offline.service.register(offline.user, p.envelope); }
    catch (error) {
      if (!/Opening balance does not carry forward/.test(error.message)) throw error;
      p.registrationBlocker = 'Missing draft/history carry-forward: opening ' + p.envelope.openingMinor + ' does not equal latest eligible prior closing';
      deferred.push({ id: p.id, accountId: p.envelope.accountId, period: p.envelope.period, reason: p.registrationBlocker });
    }
  }
  return { scope: index.scope, ready, drafts, deferred, sourceRoot, sourceReader, offline };
}

async function retainedObservation(root, scope, accountId, source, note, strength = 'screen observed') {
  const base = await fs.realpath(path.join(root, 'artifacts'));
  const file = await fs.realpath(path.resolve(root, source));
  assert(file.startsWith(base + path.sep), 'Evidence source escapes project artifacts');
  const bytes = await fs.readFile(file);
  const digest = sha(bytes), stat = await fs.stat(file);
  return {
    source, bytes, artifact: { path: hash(scope) + '/' + accountId + '/terra-evidence/' + digest + path.extname(file), sha256: digest },
    evidence: { strength, observedAt: stat.mtime.toISOString(), note },
  };
}

export async function savingsEvidence(plan, { root = ROOT, nativeReport } = {}) {
  const p = plan.ready.find(p => p.id === SAVINGS_ID);
  assert(p, 'Exact Savings October 2026 package missing');
  const e = p.envelope;
  assert(e.accountId === '1150040007' && e.period === '2026-10' && e.accountCurrency === 'CAD' && e.openingMinor === 0 && e.closingMinor === 100000 && e.rows.length === 1 && e.files.filter(f => f.kind === 'csv').length === 1, 'Savings evidence no longer fits package');
  assert(e.events[0].source.entity === 'Transfer' && e.events[0].source.id === '591' && e.events[0].amountMinor === 100000 && e.events[0].bookDate === '2026-10-02', 'Expected Transfer591 changed');
  const assets = {};
  for (const [key, source] of Object.entries(observations)) {
    const note = key === 'reported' ? 'Terra-reported historical completion; retained reply, not a screen observation.' : key === 'register'
      ? 'Terra-reported plus screen observed: Savings reconciled through 31/10/2026; ending CAD1,000.00. Terra reports the transfer is R. The retained viewport clips the status column.'
      : 'Terra-reported plus retained screen observed: Savings October 2026 ' + key + '. Source: ' + source;
    const item = await retainedObservation(root, plan.scope, e.accountId, source, note, key === 'reported' ? 'operator attested' : 'screen observed');
    item.evidence.artifact = item.artifact; assets[key] = item;
  }
  if (nativeReport) {
    const d = JSON.parse(await fs.readFile(path.resolve(root, nativeReport), 'utf8'));
    assert(d.accountId === e.accountId && d.period === e.period && typeof d.note === 'string' && d.note.trim() && Number.isFinite(Date.parse(d.observedAt)) && Date.parse(d.observedAt) <= Date.now(), 'Native report descriptor needs Savings account/month, observation time and note');
    assert(typeof d.path === 'string' && !path.isAbsolute(d.path) && !d.path.split(/[\\/]/).includes('..') && d.path.startsWith('artifacts/'), 'Native report must be a retained project artifact');
    const item = await retainedObservation(root, plan.scope, e.accountId, d.path, d.note, 'native report retained');
    assert(item.bytes.subarray(0,5).toString() === '%PDF-' && item.artifact.sha256 === d.sha256, 'Retain the exact native QBO reconciliation PDF and SHA-256');
    assert(!e.files.some(f => f.sha256 === item.artifact.sha256), 'Simulated statement is not a native reconciliation report');
    item.evidence.artifact = item.artifact; item.evidence.observedAt = d.observedAt; assets.report = item;
  }
  return { package: p, assets, limitation: assets.report ? null : 'Native reconciliation report PDF not retained. Completion and attachment observed; BF4 reconciled state requires the native report. Keep BANKING_OPERATOR_ENABLED off until supplied.' };
}

export function savingsCommands(pkg, saved) {
  const { assets } = saved, file = pkg.snapshot.files.find(f => f.kind === 'csv'), row = pkg.snapshot.rows[0];
  const fields = { fileId: file.fileId, fileHash: file.sha256, attemptId: 'terra-savings-202610-upload', accountId: pkg.accountId, accountCurrency: pkg.accountCurrency };
  const command = (label, suffix, action, evidence, more = {}) => ({ label, suffix, body: { requestId: 'ba-savings-202610-' + label, expectedVersion: pkg.stateVersion, action, evidence: structuredClone(evidence), ...more } });
  const history = pkg.evidence.history || [];
  const ev = key => structuredClone(assets[key].evidence);
  const commands = [
    command('start', 'imports', 'start', ev('upload'), fields),
    command('uploaded', 'imports', 'uploaded', ev('upload'), {
      ...fields, observedCount: 1,
      nativeConfirmation: 'Terra imported one CAD1,000.00 row dated 05/10/2026. Native bank-feed id was not displayed; nativeRowId is a local observation key, not a QBO id. Auto-post Deposit11232 was undone, then row matched Transfer591.',
      nativeRows: [{ rowId: row.rowId, nativeRowId: 'terra-observed-savings-202610-row1' }],
    }),
    command('reviewed', 'rows', 'reviewed', ev('match'), { rowId: row.rowId, decision: 'match', reason: 'Terra reviewed existing Transfer591, book date 02/10/2026; CSV settlement date 05/10/2026. No new Deposit.' }),
    command('matched', 'rows', 'matched', ev('match'), {
      rowId: row.rowId, qboRefs: [{ entity: 'Transfer', id: '591' }],
      reason: 'Terra-reported match; register shows one transfer. Later observations: ' + observations.completion + ', ' + observations.attachment + ', ' + observations.register + '. Terra reports R; screenshot shows Reconciled through 31/10/2026 and CAD1,000.00; status column clipped.',
    }),
  ];
  if (assets.report) commands.push(command('reconciled', 'reconciliation', 'reconciled', ev('register'), {
    accountId: pkg.accountId, accountCurrency: pkg.accountCurrency, period: pkg.period,
    report: ev('report'), completion: ev('completion'), statementAttachment: ev('attachment'),
    openingMinor: 0, closingMinor: 100000, differenceMinor: 0, outstandingItems: pkg.snapshot.outstandingItems,
  }));
  for (let i = 0; i < history.length; i++) {
    assert(commands[i], 'Savings has additional evidence; inspect before continuing');
    const replay = structuredClone(commands[i].body);
    replay.expectedVersion = history[i].decision.expectedVersion;
    assert(same(replay, history[i].decision), 'Savings evidence differs; inspect without overwriting');
  }
  return commands.slice(history.length);
}

export async function replaySavings(plan, saved) {
  const reads = new Map(Object.values(saved.assets).map(a => [a.artifact.path, a.bytes]));
  const reader = async a => {
    if (!reads.has(a.path)) return plan.sourceReader(a);
    const bytes = reads.get(a.path); assert(sha(bytes) === a.sha256, 'Evidence hash mismatch'); return bytes;
  };
  const h = offlineWorkspace(plan.scope, [saved.package.envelope], reader);
  let current = await h.service.register(h.user, saved.package.envelope);
  const bodies = [];
  while (true) {
    const next = savingsCommands(current, saved)[0]; if (!next) break;
    bodies.push(next);
    const method = { imports: 'recordImport', rows: 'recordRow', reconciliation: 'recordReconciliation' }[next.suffix];
    current = await h.service[method](h.user, current.id, next.body);
  }
  return { bodies, current, workspace: h };
}

async function copyImmutable(bytes, destination, base) {
  assert(destination.startsWith(base + path.sep), 'Artifact destination escapes banking storage');
  let parent = base;
  for (const segment of path.relative(base, path.dirname(destination)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, segment);
    try { await fs.mkdir(parent); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    assert(!(await fs.lstat(parent)).isSymbolicLink() && (await fs.realpath(parent)).startsWith(base + path.sep), 'Artifact destination junction escapes banking storage');
  }
  const existing = await fs.lstat(destination).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  assert(!existing?.isSymbolicLink(), 'Artifact destination may not be a symlink');
  try { await fs.writeFile(destination, bytes, { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; assert(sha(await fs.readFile(destination)) === sha(bytes), 'Existing artifact differs; refusing overwrite'); }
}
export async function stageArtifacts(plan, saved, { root = ROOT } = {}) {
  const artifactBase = await fs.realpath(path.join(root, 'artifacts'));
  await fs.mkdir(path.join(artifactBase, 'banking'), { recursive: true });
  const destination = await fs.realpath(path.join(artifactBase, 'banking'));
  assert(destination.startsWith(artifactBase + path.sep), 'Banking root escapes project artifacts');
  for (const p of plan.ready) for (const f of p.envelope.files) await copyImmutable(await plan.sourceReader({ path: f.path, sha256: f.sha256 }), path.join(destination, f.path), destination);
  for (const a of Object.values(saved.assets)) await copyImmutable(a.bytes, path.join(destination, a.artifact.path), destination);
}

export function apiTransport({ root = ROOT, directory, timeoutMs = 30000 } = {}) {
  let sequence = 0;
  return async (method, route, body) => {
    assert((method === 'GET' && (route === ROUTE || new RegExp('^' + ROUTE + '/packages/[a-f0-9]{64}$').test(route))) ||
      (method === 'POST' && (route === ROUTE + '/packages' || new RegExp('^' + ROUTE + '/packages/[a-f0-9]{64}/(imports|rows|reconciliation)$').test(route))), 'Disallowed registration route');
    const stem = path.join(directory, String(++sequence));
    if (body) await fs.writeFile(stem + '-body.json', JSON.stringify(body));
    const args = [path.join(root, 'artifacts/luna/tmp/api.js'), method, route, ...(body ? [stem + '-body.json'] : [])];
    const output = await new Promise((resolve, reject) => execFile(process.execPath, args, {
      cwd: root, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
      env: { ...process.env, API_OUT: stem + '-response.json' },
    }, (error, stdout) => error ? reject(new Error('api.js failed/timed out; inspect retained request/response. No automatic retry.')) : resolve(stdout)));
    const status = Number(output.match(/^(\d{3})\s/)?.[1]);
    assert(status >= 200 && status < 300, 'Local banking API HTTP ' + (status || 'unknown') + '; inspect retained response. No automatic retry.');
    const response = JSON.parse(await fs.readFile(stem + '-response.json', 'utf8'));
    assert(response.data, 'Banking API response has no data');
    return response.data;
  };
}
export async function registerPlan(plan, saved, request, onProgress = () => {}) {
  const inventory = await request('GET', ROUTE);
  assert(!inventory.truncated && Array.isArray(inventory.packages), 'Complete registered inventory required');
  assert(inventory.operatorLoop?.enabled === false, 'Banking loop must be observed disabled before registration');
  const existing = new Map(inventory.packages.map(p => [p.id, p]));
  for (const p of plan.ready) if (existing.has(p.id)) assert(existing.get(p.id).contentHash === p.contentHash, 'Registered package hash mismatch: ' + p.id);
  const projected = new Map(existing), actions = [];
  // Plan the complete action set before any POST. Existing history can bridge a
  // gap that was absent in the offline source; unchanged deferrals stay deferred.
  for (const p of plan.ready) {
    if (existing.has(p.id)) { actions.push({ type: 'skip', p }); continue; }
    const prior = [...projected.values()].filter(old => old.accountId === p.envelope.accountId && old.period < p.envelope.period).sort((a,b) => b.period.localeCompare(a.period) || b.revision - a.revision)[0];
    if (prior && prior.closingMinor !== p.envelope.openingMinor) {
      actions.push({ type: 'defer', p, reason: { id: p.id, accountId: p.envelope.accountId, period: p.envelope.period, priorPackageId: prior.id, priorClosingMinor: prior.closingMinor, openingMinor: p.envelope.openingMinor, reason: 'Carry-forward gap after skipped draft/history; native inspection required' } });
      continue;
    }
    assert(!inventory.packages.some(old => old.accountId === p.envelope.accountId && old.period > p.envelope.period), 'Backfill would mark an existing later statement needs-review; inspect before registration');
    actions.push({ type: 'register', p });
    projected.set(p.id, { id: p.id, accountId: p.envelope.accountId, period: p.envelope.period, revision: p.envelope.revision, closingMinor: p.envelope.closingMinor });
  }
  const result = { registered: [], skipped: [], drafts: plan.drafts, deferred: [], savings: {
    terraReportedReconciled: true, observedCompletion: true, workspaceReconciled: false,
    limitation: saved.limitation, evidencePaths: observations,
  } };
  for (const action of actions) {
    const { p } = action;
    if (action.type === 'skip') { result.skipped.push(p.id); onProgress('skip', p); continue; }
    if (action.type === 'defer') { result.deferred.push(action.reason); onProgress('defer', p); continue; }
    const value = await request('POST', ROUTE + '/packages', p.envelope);
    assert(value.id === p.id && value.contentHash === p.contentHash, 'Registered response hash mismatch');
    result.registered.push(p.id); onProgress('registered', p);
  }
  let current = await request('GET', ROUTE + '/packages/' + SAVINGS_ID);
  assert(current.contentHash === saved.package.contentHash, 'Savings registered content changed');
  assert(!current.summary.needsReview && !current.evidence.supersededBy, 'Savings revised or superseded; inspect before recording evidence');
  if (current.summary.reconciled) {
    const file = current.snapshot.files.find(f => f.kind === 'csv');
    const matched = current.evidence.rows[current.snapshot.rows[0].rowId]?.matched;
    const rec = current.evidence.reconciled;
    assert(current.summary.uploaded && current.evidence.imports.some(i => i.status === 'uploaded' && i.fileId === file.fileId && i.fileHash === file.sha256) && same(matched?.qboRefs, [{ entity: 'Transfer', id: '591' }]) && rec?.openingMinor === 0 && rec?.closingMinor === 100000 && rec?.differenceMinor === 0, 'Completed Savings evidence differs; inspect immutable state');
    result.savings.workspaceReconciled = true; result.savings.uploaded = true; result.savings.matched = 1; result.savings.limitation = null; return result;
  }
  while (true) {
    const next = savingsCommands(current, saved)[0]; if (!next) break;
    current = await request('POST', ROUTE + '/packages/' + SAVINGS_ID + '/' + next.suffix, next.body);
  }
  result.savings.workspaceReconciled = current.summary.reconciled;
  result.savings.uploaded = current.summary.uploaded; result.savings.matched = current.summary.matched;
  return result;
}
export async function main(argv = process.argv.slice(2)) {
  const options = { dryRun: false, source: DEFAULT_SOURCE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (['--source', '--native-report'].includes(argv[i])) { assert(argv[i+1] && !argv[i+1].startsWith('--'), 'Missing option value'); options[argv[i].slice(2)] = argv[++i]; }
    else throw new Error('Usage: node scripts/banking/register-packages.mjs [--dry-run] [--source directory] [--native-report descriptor.json]');
  }
  const plan = await loadPlan({ source: options.source });
  const saved = await savingsEvidence(plan, { nativeReport: options['native-report'] });
  const replay = await replaySavings(plan, saved);
  console.log(JSON.stringify({ type: 'offline-validation', ready: plan.ready.length, drafts: plan.drafts.length, deferred: plan.deferred.length, savings: replay.current.summary, limitation: saved.limitation }));
  for (const p of plan.drafts) console.log(JSON.stringify({ type: 'skip-draft', ...p }));
  if (options.dryRun) {
    for (const p of plan.ready) console.log(JSON.stringify({ type: p.registrationBlocker ? 'defer-ready-carry-forward' : 'would-post-unless-hash-registered', method: 'POST', path: '/api' + ROUTE + '/packages', packageId: p.id, contentHash: p.contentHash, reason: p.registrationBlocker, body: p.envelope }));
    for (const c of replay.bodies) console.log(JSON.stringify({ type: 'would-post-if-missing', method: 'POST', path: '/api' + ROUTE + '/packages/' + SAVINGS_ID + '/' + c.suffix, body: c.body }));
    return { ready: plan.ready.length, drafts: plan.drafts.length, limitation: saved.limitation };
  }
  await stageArtifacts(plan, saved);
  const directory = await fs.mkdtemp(path.join(ROOT, 'artifacts/banking/registration-'));
  const result = await registerPlan(plan, saved, apiTransport({ directory }), (type, p) => console.log(JSON.stringify({ type, packageId: p.id, period: p.envelope.period })));
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ type: 'result', file: path.relative(ROOT, path.join(directory, 'result.json')), registered: result.registered.length, skipped: result.skipped.length, savings: result.savings }));
  if (!result.savings.workspaceReconciled || result.deferred.length) process.exitCode = 2;
  return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(() => {
  console.error('Registration stopped. Inspect retained inputs/API receipts; no automatic retry. Credentials and raw errors withheld.');
  process.exitCode = 1;
});
