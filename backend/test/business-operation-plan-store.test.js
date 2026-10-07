'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessOperationPlanStore, validateOperationCandidate } = require('../src/modules/business-operation-plan-store');
const { createBusinessCompilationRuntime } = require('../src/modules/business-compilation-runtime');
const { createBusinessStepStore } = require('../src/modules/business-step-store');
const { compileBusinessTransaction } = require('../src/modules/business-transaction-compiler');
const { hash, canonical } = require('../src/modules/business-calendar');
const { fixture, scope, now, clone } = require('./helpers/business-transaction-fixtures');
const actorId = 'd'.repeat(24);
function candidate(earlier = false) {
  const po = fixture('PurchaseOrder'), bill = fixture('Bill');
  if (earlier) { po.step.txnDate = '2026-10-05'; po.approve(); }
  bill.step.dependencies = [{ logicalKey: po.step.logicalKey, entity: 'PurchaseOrder', fingerprint: hash(po.step) }];
  bill.step.details.references = [{ logicalKey: po.step.logicalKey, entity: 'PurchaseOrder' }]; bill.approve();
  return { version: 1, scope: clone(scope), businessKey: 'flagship', blueprintId: 'e'.repeat(24), blueprintHash: hash('blueprint'), baselineHash: hash('baseline'), openingDate: '2026-10-01', fromDate: '2026-10-06', throughDate: '2026-10-06', expectedCursor: '2026-10-05', expectedRevision: 1,
    requiredAssertions: [{ key: 'trial-balance', evidenceType: 'accrual-ledger', currency: 'CAD', basis: 'Accrual' }],
    entries: [{ kind: 'create', step: bill.step, policy: bill.policy }, { kind: earlier ? 'existing' : 'create', step: po.step, policy: po.policy }] };
}
function matches(row, filter) { return row && Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && '$in' in value ? value.$in.includes(row[key]) : value && typeof value === 'object' && '$gte' in value ? row[key] >= value.$gte && row[key] < value.$lt : row[key] === value); }
function harness(value = candidate()) {
  const h = { plans: new Map(), intents: new Map(), runs: new Map(), audits: new Map(), steps: new Map(), current: value, allowed: true, clock: now, candidateLoads: 0, fences: 0 };
  function model(key) {
    const query = (filter, many) => { let sort, limit = Infinity, session; const q = {
      select() { return q; }, maxTimeMS(value) { assert.equal(value, 3000); return q; }, session(value) { session = value; return q; }, sort(value) { sort = value; return q; }, limit(value) { limit = value; return q; },
      async lean() { assert.ok(session); let rows = [...h[key].values()].filter(row => matches(row, filter)); if (sort) rows.sort((a, b) => a.ordinal - b.ordinal); rows = rows.slice(0, limit); return clone(many ? rows : rows[0] || null); },
    }; return q; };
    const create = async (rows, options) => { assert.ok(options.session); if (h.failInsert === key) throw new Error('storage unavailable'); for (const row of rows) { if (h[key].has(row._id)) throw new Error('duplicate key'); h[key].set(row._id, clone(row)); } return rows; };
    return { findOne: filter => query(filter, false), find: filter => query(filter, true), create, insertMany: create,
      findOneAndUpdate(filter, change, options) { return { lean: async () => { assert.ok(options.session); const row = [...h[key].values()].find(row => matches(row, filter)); if (!row) return null; Object.assign(row, clone(change.$set)); return clone(row); } }; } };
  }
  let queue = Promise.resolve();
  const transaction = work => { const result = queue.then(async () => { const before = clone({ plans: h.plans, intents: h.intents, runs: h.runs, audits: h.audits, fences: h.fences }); let output;
    try { output = await work({ test: true }); } catch (error) { Object.assign(h, before); throw error; }
    if (h.loseReply) { h.loseReply = false; throw new Error('commit reply lost'); } return output;
  }); queue = result.catch(() => {}); return result; };
  h.deps = { Plans: model('plans'), Intents: model('intents'), Runs: model('runs'), Steps: model('steps'), transaction, now: () => h.clock,
    assertReady: async () => { if (h.notReady) throw new Error('storage not prepared'); },
    authorize: async () => { if (!h.allowed) throw new Error('permission revoked'); return { actorId: h.actorId || actorId }; },
    loadCandidate: async (requestedScope, candidateHash, session) => { assert.ok(session); h.candidateLoads++; if (h.failLoad) throw new Error('candidate expired'); return clone(h.current); },
    checkCurrent: async args => { assert.ok(args.session); h.fences++; if (h.failFence) throw new Error('baseline or policy changed'); return { scope: args.scope, operationId: args.operationId, planHash: args.planHash, actorId: args.actorId, expectedRevision: args.manifest.expectedRevision, fenceHash: hash('current activation and calendar'), ...h.fenceChange }; },
    writeAudit: async (eventKey, details, session) => { assert.ok(session); if (h.failAudit) throw new Error('audit unavailable'); const result = { id: String(h.audits.size + 1), eventKey }; h.audits.set(eventKey, { ...result, details }); return result; },
  };
  h.store = createBusinessOperationPlanStore(h.deps); h.request = { requestKey: 'operation-prepare-1', candidateHash: hash(h.current) };
  h.prepare = () => h.store.prepare(scope, h.request);
  return h;
}
test('saved operation preserves exact policy and dependency-first order for the compiler and period receipt', async () => {
  const h = harness(), saved = await h.prepare(), page = await h.store.page(scope, saved.operationId);
  assert.equal(saved.status, 'previewed'); assert.equal(h.runs.size, 1); assert.equal(h.plans.size, 1); assert.equal(h.intents.size, 2); assert.equal(h.audits.size, 1);
  assert.deepEqual(page.entries.map(row => row.step.entity), ['PurchaseOrder', 'Bill']); assert.equal(page.nextOffset, null);
  const intent = await h.store.loadIntent(scope, saved.operationId, page.entries[0].step.logicalKey), f = fixture('PurchaseOrder');
  const compiled = compileBusinessTransaction({ ...f, step: intent.step, policy: intent.policy }); assert.equal(compiled.intentHash, intent.fingerprint);
  const run = h.runs.get(saved.operationId);
  assert.equal(run.expectedRecordSetHash, hash(page.entries.map(row => ({ logicalKey: row.step.logicalKey, entity: row.step.entity, fingerprint: hash(row.step), relationships: row.step.dependencies.map(link => link.logicalKey).sort() })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey))));
  page.entries[0].step.details.lines[0].quantity = 999;
  assert.notEqual((await h.store.loadIntent(scope, saved.operationId, intent.logicalKey)).step.details.lines[0].quantity, 999);
});
test('lost preparation acknowledgement reuses exact durable operation without reloading an expired candidate', async () => {
  const h = harness(); h.loseReply = true; await assert.rejects(h.prepare(), /reply lost/); h.failLoad = true;
  const result = await h.prepare(); assert.equal(result.reused, true); assert.equal(h.candidateLoads, 1); assert.equal(h.runs.size, 1); assert.equal(h.audits.size, 1);
});
test('concurrent preparation retries have one operation and conflicting request content cannot reuse it', async () => {
  const h = harness(), results = await Promise.all([h.prepare(), h.prepare()]); assert.equal(results[0].operationId, results[1].operationId); assert.equal(h.runs.size, 1);
  h.request.candidateHash = hash('changed'); await assert.rejects(h.prepare(), /different work/); assert.equal(h.runs.size, 1);
});
test('plan, intents, run and audit roll back together on any storage failure', async () => {
  for (const failure of ['plans', 'intents', 'runs', 'audit']) { const h = harness(); if (failure === 'audit') h.failAudit = true; else h.failInsert = failure; await assert.rejects(h.prepare()); for (const key of ['plans', 'intents', 'runs', 'audits']) assert.equal(h[key].size, 0); }
});
test('approval fences exact saved plan and retains audit receipt across lost responses', async () => {
  const h = harness(), saved = await h.prepare(); h.loseReply = true;
  await assert.rejects(h.store.approve(scope, saved.operationId, saved.planHash), /reply lost/);
  assert.equal(h.runs.get(saved.operationId).status, 'approved'); assert.equal(h.audits.size, 2);
  h.failFence = true; const retry = await h.store.approve(scope, saved.operationId, saved.planHash); assert.equal(retry.reused, true); assert.equal(h.fences, 1);
});
test('changed baseline, incomplete entries, altered plan and audit failure cannot approve a run', async () => {
  for (const change of [h => { h.failFence = true; }, h => { h.fenceChange = { planHash: hash('other') }; }, h => { h.fenceChange = { expectedRevision: 2 }; }, h => { h.failAudit = true; }, h => { h.intents.delete(h.intents.keys().next().value); }, h => { [...h.plans.values()][0].manifest.throughDate = '2026-10-07'; }]) {
    const h = harness(), saved = await h.prepare(); change(h); await assert.rejects(h.store.approve(scope, saved.operationId, saved.planHash)); assert.equal(h.runs.get(saved.operationId).status, 'previewed'); assert.equal(h.audits.size, 1); assert.equal(h.fences, 0);
  }
});
test('missing preparation, revoked roles and foreign company scope fail closed', async () => {
  const h = harness(); h.notReady = true; await assert.rejects(h.prepare(), /not prepared/); h.notReady = false;
  const saved = await h.prepare(); h.allowed = false; await assert.rejects(h.store.page(scope, saved.operationId), /permission/); await assert.rejects(h.store.approve(scope, saved.operationId, saved.planHash), /permission/);
  h.allowed = true; for (const foreign of [{ ...scope, realmId: '456' }, { ...scope, environment: 'production' }, { ...scope, connectionId: 'f'.repeat(24) }]) await assert.rejects(h.store.page(foreign, saved.operationId));
  assert.equal(h.runs.get(saved.operationId).status, 'previewed');
});
test('approval rechecks actor identity inside its transaction', async () => {
  const h = harness(), saved = await h.prepare(); let calls = 0; h.deps.authorize = async () => ({ actorId: ++calls === 1 ? actorId : 'f'.repeat(24) });
  const store = createBusinessOperationPlanStore(h.deps); await assert.rejects(store.approve(scope, saved.operationId, saved.planHash), /actor changed/); assert.equal(h.audits.size, 1);
});
test('paged saved intents are stable, bounded and reject missing or changed pages', async () => {
  const h = harness(), saved = await h.prepare(); const first = await h.store.page(scope, saved.operationId, 0, 1), second = await h.store.page(scope, saved.operationId, first.nextOffset, 1);
  assert.equal(first.nextOffset, 1); assert.equal(second.nextOffset, null); assert.notEqual(first.entries[0].step.logicalKey, second.entries[0].step.logicalKey);
  await assert.rejects(h.store.page(scope, saved.operationId, 0, 101), /bounded/);
  const row = [...h.intents.values()][0]; row.step.details.lines[0].amountCents += 1;
  await assert.rejects(h.store.page(scope, saved.operationId), /amounts changed/);
});
test('missing, substituted and out-of-scope policies or reference identities reject preparation', async () => {
  for (const change of [c => { c.scope.realmId = '456'; }, c => { c.entries[0].policy.status = 'draft'; }, c => { c.entries[0].policy.country = 'US'; }, c => { c.entries[0].step.references[0].status = 'unverified'; }, c => { c.entries[0].step.references[0].syncToken = '01'; }, c => { c.entries[0].step.detailsHash = hash('changed'); }, c => { c.requiredAssertions = []; }]) {
    const c = candidate(); change(c); assert.throws(() => validateOperationCandidate(c, scope, now));
  }
});
test('dependency fingerprints must identify the complete earlier and current record closure', () => {
  const c = candidate(true), result = validateOperationCandidate(c, scope, now); assert.equal(result.manifest.recordCount, 2); assert.equal(result.manifest.createCount, 1);
  for (const change of [c => { c.entries.pop(); }, c => { c.entries[0].step.dependencies[0].fingerprint = hash('other intent'); c.entries[0].policy.stepHash = hash(c.entries[0].step); }, c => { c.entries.push(clone(c.entries[0])); }, c => { c.entries[1].step.txnDate = '2026-10-07'; c.entries[1].policy.stepHash = hash(c.entries[1].step); }]) { const altered = candidate(true); change(altered); assert.throws(() => validateOperationCandidate(altered, scope, now)); }
});
test('unrelated prior records are not silently adopted into the operation', () => {
  const c = candidate(); const f = fixture('Estimate'); f.step.txnDate = '2026-10-05'; f.approve(); c.entries.push({ kind: 'existing', step: f.step, policy: f.policy }); assert.throws(() => validateOperationCandidate(c, scope, now), /unrelated/);
});
test('periods cannot skip the cursor, predate opening, exceed 31 days or include future dates', () => {
  for (const change of [c => { c.expectedCursor = '2026-10-04'; }, c => { c.expectedCursor = null; }, c => { c.openingDate = '2026-10-06'; }, c => { c.fromDate = '2026-09-01'; c.expectedCursor = '2026-08-31'; c.openingDate = '2026-01-01'; }, c => { c.throughDate = '2026-10-07'; }]) { const c = candidate(); change(c); assert.throws(() => validateOperationCandidate(c, scope, now)); }
  const c = candidate(); c.expectedCursor = null; c.openingDate = c.fromDate; assert.doesNotThrow(() => validateOperationCandidate(c, scope, now));
});
test('candidate hash binds what the server loader actually returns and route bodies cannot inject activities', async () => {
  const h = harness(); h.current.businessKey = 'changed'; await assert.rejects(h.prepare(), /candidate changed/); assert.equal(h.runs.size, 0);
  await assert.rejects(h.store.prepare(scope, { ...h.request, entries: [] }), /exact server candidate/);
});
test('earlier activity intents can be read for verification but cannot be claimed for creation', async () => {
  const h = harness(candidate(true)), saved = await h.prepare(), page = await h.store.page(scope, saved.operationId), earlier = page.entries.find(row => row.kind === 'existing');
  let claims = 0;
  const stepStore = createBusinessStepStore({ Steps: { findOne() { claims++; throw new Error('unexpected step write'); } }, loadIntent: h.store.loadIntent, authorize: async () => ({ actorId }), assertReady: async () => {}, transaction: async work => work({}), fence: async () => { claims++; }, writeAudit: async () => {}, loadRecovery: async () => {}, loadReadback: async () => {} });
  await assert.rejects(stepStore.claim(scope, saved.operationId, earlier.step.logicalKey), /cannot be recreated/); assert.equal(claims, 0);
  const intent = await h.store.loadIntent(scope, saved.operationId, earlier.step.logicalKey); assert.equal(intent.kind, 'existing'); assert.equal(intent.fingerprint, hash(earlier.step));
});
test('immutable run metadata cannot diverge from the saved plan', async () => {
  const h = harness(), saved = await h.prepare(); h.runs.get(saved.operationId).baselineHash = hash('other baseline'); await assert.rejects(h.store.page(scope, saved.operationId), /differs/);
});
test('saved plan preparation is deterministic under candidate entry order', () => {
  const c = candidate(), reversed = clone(c); reversed.entries.reverse();
  assert.equal(validateOperationCandidate(c, scope, now).planHash, validateOperationCandidate(reversed, scope, now).planHash);
});
test('empty calendar periods have an explicit zero-record plan and still require report assertions', async () => {
  const c = candidate(); c.entries = []; const h = harness(c), saved = await h.prepare(); assert.equal(h.intents.size, 0); assert.equal(h.runs.get(saved.operationId).recordCount, 0);
  const page = await h.store.page(scope, saved.operationId); assert.equal(page.nextOffset, null); assert.deepEqual(page.entries, []); assert.equal(h.runs.get(saved.operationId).requiredAssertions.length, 1);
});

test('candidate wrapper fields cannot overwrite server-owned company, plan or ordinal identity', async () => {
  const c = candidate();
  for (const entry of c.entries) Object.assign(entry, { _id: 'f'.repeat(24), contractVersion: 99, environment: 'production', realmId: '999', connectionId: 'f'.repeat(24), planId: 'f'.repeat(24), planHash: hash('other'), ordinal: 99 });
  const h = harness(c), saved = await h.prepare(), page = await h.store.page(scope, saved.operationId);
  assert.equal(page.entries.length, 2);
  for (const row of h.intents.values()) { assert.equal(row.contractVersion, 1); assert.equal(row.realmId, scope.realmId); assert.equal(row.environment, scope.environment); assert.equal(row.connectionId, scope.connectionId); assert.notEqual(row._id, 'f'.repeat(24)); assert.notEqual(row.planId, 'f'.repeat(24)); assert.equal(row.planHash, saved.planHash); assert.ok(row.ordinal < 2); }
});

test('reused preparation and approval reject damaged durable intent sets without reloading candidates', async () => {
  for (const approved of [false, true]) {
    const h = harness(), saved = await h.prepare();
    if (approved) await h.store.approve(scope, saved.operationId, saved.planHash);
    h.failLoad = true; h.intents.delete(h.intents.keys().next().value);
    await assert.rejects(h.prepare(), /activities are missing/);
    if (approved) await assert.rejects(h.store.approve(scope, saved.operationId, saved.planHash), /activities are missing/);
    assert.equal(h.candidateLoads, 1);
  }
});

test('compilation accepts projected dependency identities from the real plan loader with retained metadata', async () => {
  const value = candidate(); Object.assign(value.entries[0].step.dependencies[0], { source: 'managed-operation', state: 'verified' }); value.entries[0].policy.stepHash = hash(value.entries[0].step);
  const h = harness(value), saved = await h.prepare(); await h.store.approve(scope, saved.operationId, saved.planHash);
  const key = value.entries[0].step.logicalKey, intent = await h.store.loadIntent(scope, saved.operationId, key);
  assert.equal(intent.step.dependencies[0].source, 'managed-operation'); assert.equal(intent.dependencies[0].source, undefined);
  let graphReached = false;
  const reader = createBusinessCompilationRuntime({ scope, operationId: saved.operationId, planHash: saved.planHash,
    access: { authorize: async () => ({ actorId, ownerId: 'c'.repeat(24) }), resolveClient: async () => { throw new Error('Unexpected provider call'); } }, plans: h.store,
    steps: { verifyGraph: async () => { graphReached = true; throw new Error('Dependency graph verification reached'); }, evidence: async () => null },
    verification: { readRecord: async () => null, readFence: async () => null }, assertReady: async () => {}, now: () => now,
  });
  await assert.rejects(reader({ scope, operationId: saved.operationId, logicalKey: key, intent }), /Dependency graph verification reached/); assert.equal(graphReached, true);
});

async function savedHistoryFixture() {
  const h = harness(), saved = await h.prepare(); await h.store.approve(scope, saved.operationId, saved.planHash);
  const page = await h.store.page(scope, saved.operationId);
  for (const [index, entry] of page.entries.entries()) {
    const step = entry.step;
    h.steps.set(step.logicalKey, { contractVersion: 1, ...scope, operationId: saved.operationId, planHash: saved.planHash, logicalKey: step.logicalKey, fingerprint: hash(step), entity: step.entity, dependencies: step.dependencies.map(link => ({ logicalKey: link.logicalKey, fingerprint: link.fingerprint, entity: link.entity })), state: 'verified', revision: 4, qboId: String(1000 + index) });
  }
  return { h, saved, bill: page.entries.find(entry => entry.step.entity === 'Bill'), po: page.entries.find(entry => entry.step.entity === 'PurchaseOrder') };
}
test('history follows original approved dependencies and policies without regenerating changed business settings', async () => {
  const { h, saved, bill, po } = await savedHistoryFixture(); h.current.entries[0].step.details.lines[0].quantity = 999; h.failLoad = true;
  const result = await h.store.history(scope, [bill.step.logicalKey]);
  assert.deepEqual(result.entries.map(row => row.logicalKey), [po.step.logicalKey, bill.step.logicalKey]);
  assert.deepEqual(result.entries[0].step, po.step); assert.deepEqual(result.entries[1].policy, bill.policy);
  assert.equal(result.entries[1].operationId, saved.operationId); assert.equal(result.requiresCurrentReadback, true); assert.deepEqual(result.missing, []);
  const { sourceHash, ...source } = result; assert.equal(sourceHash, hash(source)); assert.equal(h.candidateLoads, 1); assert.equal(h.audits.size, 2);
  result.entries[0].step.details.lines[0].quantity = 900;
  assert.deepEqual((await h.store.history(scope, [po.step.logicalKey])).entries[0].step, po.step);
});
test('history distinguishes no local receipt from absence in QBO and rejects old-connection ownership', async () => {
  const { h, po } = await savedHistoryFixture(), unknown = hash('no local receipt');
  const result = await h.store.history(scope, [po.step.logicalKey, unknown]); assert.deepEqual(result.missing, [unknown]); assert.equal(result.provesAbsence, undefined); assert.equal(result.entries.length, 1);
  await assert.rejects(h.store.history({ ...scope, connectionId: 'f'.repeat(24) }, [po.step.logicalKey]), /earlier or different/);
  const other = await h.store.history({ ...scope, realmId: '456' }, [po.step.logicalKey]); assert.equal(other.entries.length, 0); assert.deepEqual(other.missing, [po.step.logicalKey]);
});
test('history rejects changed approvals, manifests, original policies, step identities and missing ancestors', async () => {
  for (const change of [
    ({ h, saved }) => { h.runs.get(saved.operationId).approval = null; },
    ({ h }) => { [...h.plans.values()][0].manifest.baselineHash = hash('other baseline'); },
    ({ h }) => { [...h.intents.values()][0].policy.evidenceHash = hash('other policy'); },
    ({ h, bill }) => { h.steps.get(bill.step.logicalKey).fingerprint = hash('different intent'); },
    ({ h, po }) => { h.steps.delete(po.step.logicalKey); },
    ({ h, po }) => { h.steps.get(po.step.logicalKey).qboId = null; },
    ({ h, bill }) => { h.steps.get(bill.step.logicalKey).dependencies[0].fingerprint = hash('changed parent'); },
  ]) { const f = await savedHistoryFixture(); change(f); await assert.rejects(f.h.store.history(scope, [f.bill.step.logicalKey])); }
});
test('history refuses duplicate physical ownership before returning saved records', async () => {
  const { h, bill } = await savedHistoryFixture(), copied = clone(h.steps.get(bill.step.logicalKey)); copied.logicalKey = hash('another activity'); h.steps.set(copied.logicalKey, copied);
  await assert.rejects(h.store.history(scope, [bill.step.logicalKey, copied.logicalKey]), /same QuickBooks record/);
});
test('history rechecks current actor outside the snapshot and cannot finish after revocation', async () => {
  const { h, po } = await savedHistoryFixture();
  const store = createBusinessOperationPlanStore({ ...h.deps, readOnly: true, transaction: async work => { const result = await h.deps.transaction(work); h.allowed = false; return result; } });
  await assert.rejects(store.history(scope, [po.step.logicalKey]), /permission revoked/);
});
test('history has bounded roots, rejects cancellation and enforces its overall deadline', async () => {
  const { h, po } = await savedHistoryFixture();
  await assert.rejects(h.store.history(scope, Array.from({ length: 1001 }, (_, i) => hash(i))), /1,000/);
  await assert.rejects(h.store.history(scope, [po.step.logicalKey, po.step.logicalKey]), /distinct/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(h.store.history(scope, [po.step.logicalKey], { signal: controller.signal }), /cancelled/);
  const store = createBusinessOperationPlanStore({ ...h.deps, readOnly: true, authorize: async () => { h.clock += 30001; return { actorId }; } });
  await assert.rejects(store.history(scope, [po.step.logicalKey]), /time budget/);
});

test('history cancellation returns while readiness, authorization or transaction acknowledgement is stalled', { timeout: 5000 }, async () => {
  for (const stage of ['assertReady', 'authorize', 'transaction', 'acknowledgement']) {
    const { h, po } = await savedHistoryFixture(); let entered, release, authCalls = 0;
    const called = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const deps = { ...h.deps, readOnly: true, authorize: async (...args) => { authCalls++; return h.deps.authorize(...args); } };
    if (stage === 'acknowledgement') deps.transaction = async work => { const result = await h.deps.transaction(work); entered(); await gate; return result; };
    else { const original = deps[stage]; deps[stage] = async (...args) => { entered(); await gate; return original(...args); }; }
    const store = createBusinessOperationPlanStore(deps), controller = new AbortController();
    const pending = store.history(scope, [po.step.logicalKey], { signal: controller.signal }); await called;
    controller.abort(); await assert.rejects(pending, /cancelled/); const before = authCalls; release(); await new Promise(resolve => setImmediate(resolve));
    // A started authorization adapter may finish, but no subsequent authority stage runs.
    assert.ok(authCalls <= before + (stage === 'authorize' ? 1 : 0)); assert.equal(h.audits.size, 2);
  }
});
test('late original-run query cannot start a plan read after caller cancellation', { timeout: 5000 }, async () => {
  const { h, po } = await savedHistoryFixture(); let entered, release, planReads = 0;
  const called = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const runFind = h.deps.Runs.findOne, planFind = h.deps.Plans.findOne;
  h.deps.Runs.findOne = filter => { const query = runFind(filter), lean = query.lean; query.lean = async () => { entered(); await gate; return lean(); }; return query; };
  h.deps.Plans.findOne = filter => { planReads++; return planFind(filter); };
  const store = createBusinessOperationPlanStore({ ...h.deps, readOnly: true }), controller = new AbortController();
  const pending = store.history(scope, [po.step.logicalKey], { signal: controller.signal }); await called;
  controller.abort(); await assert.rejects(pending, /cancelled/); release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(planReads, 0);
});

test('invalid retained approval is reported as local history failure rather than QBO rejection', async () => {
  const { h, saved, po } = await savedHistoryFixture(); h.runs.get(saved.operationId).approval = null;
  await assert.rejects(h.store.history(scope, [po.step.logicalKey]), error => error.code === 'BUSINESS_PLAN_UNVERIFIED' && error.status === 409);
});

test('assembled preview enters saved plan persistence and compiler without changing its final identity', async () => {
  const { candidateFixture } = require('./helpers/business-operation-candidate-fixture');
  const { assembleBusinessOperation, bindApprovedOperationPolicies } = require('../src/modules/business-operation-candidate');
  const f = candidateFixture(), assembly = assembleBusinessOperation(f), bound = bindApprovedOperationPolicies(assembly, f.policies(assembly), f.now);
  const h = harness(bound.candidate), saved = await h.prepare();
  assert.equal(saved.planHash, bound.planHash); assert.equal(h.runs.get(saved.operationId).status, 'previewed');
  assert.equal(h.runs.get(saved.operationId).approval, null);
  const page = await h.store.page(scope, saved.operationId);
  assert.equal(canonical(page.entries.map(row => ({ kind: row.kind, step: row.step, policy: row.policy }))), canonical(bound.candidate.entries));
  const po = bound.candidate.entries[0], intent = await h.store.loadIntent(scope, saved.operationId, po.step.logicalKey);
  const compiled = compileBusinessTransaction({ ...fixture('PurchaseOrder'), step: intent.step, policy: intent.policy });
  assert.equal(compiled.intentHash, hash(po.step));
});
test('original history retains business lineage for subsequent candidate assembly', async () => {
  const { h, po } = await savedHistoryFixture();
  const history = await h.store.history(scope, [po.step.logicalKey]);
  assert.equal(history.entries[0].businessKey, h.current.businessKey);
});
