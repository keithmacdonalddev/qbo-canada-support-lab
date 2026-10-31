'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, scope, operationId, hash } = require('./helpers/business-run-fixture');
test('runs a saved plan in order and advances the real period only after full evidence', async () => {
  const h = harness(), result = await h.execute();
  assert.equal(result.complete, true); assert.equal(result.state, 'verified'); assert.equal(result.completedRecords, 3); assert.equal(h.writes, 3); assert.equal(h.run().leaseToken, null);
  assert.equal(h.calendar().verifiedThrough, '2026-10-06'); assert.equal(h.calendar().currentOperationId, null); assert.equal(h.writer().operationId, null);
  assert.deepEqual(h.dispatchCalls.map(row => row.key), h.entries.map(row => row.step.logicalKey));
  const again = await h.execute(); assert.equal(again.complete, true); assert.equal(h.writes, 3); assert.equal(h.dispatchCalls.length, 3);
});
test('pages a complete operation beyond the first fifty activities', async () => {
  const h = harness(55), result = await h.execute(); assert.equal(result.complete, true); assert.equal(h.writes, 55); assert.deepEqual(h.pages, [0, 50]);
});
test('missing named period evidence leaves the business date unchanged and resumes without recreating', async () => {
  const h = harness(); h.evidenceReady = false;
  const pending = await h.execute(); assert.equal(pending.state, 'awaiting-evidence'); assert.equal(pending.complete, false); assert.equal(h.calendar().verifiedThrough, '2026-10-05'); assert.equal(h.run().leaseToken, null);
  h.evidenceReady = true; const result = await h.execute(); assert.equal(result.complete, true); assert.equal(h.writes, 3); assert.equal(h.dispatchCalls.length, 3);
});
test('period store rejects fabricated or incomplete report evidence despite a prepared flag', async () => {
  const h = harness(), prepare = h.prepareEvidence;
  h.prepareEvidence = async () => { await prepare(); h.proof.assertions = []; return { prepared: true }; };
  const result = await h.execute(); assert.equal(result.complete, false); assert.equal(h.calendar().verifiedThrough, '2026-10-05'); assert.equal(h.run().status, 'blocked');
});
test('existing earlier activities are verified and never sent to creation dispatch', async () => {
  const h = harness(); h.entries[0].kind = 'existing'; h.saveStep(h.entries[0].step.logicalKey); const result = await h.execute();
  assert.equal(result.complete, true); assert.deepEqual(h.graphCalls, [h.entries[0].step.logicalKey]); assert.equal(h.dispatchCalls.length, 2);
});
test('a failed existing-record check blocks later work without advancing the cursor', async () => {
  const h = harness(); h.entries[0].kind = 'existing'; h.graphFail = true;
  const result = await h.execute(); assert.equal(result.complete, false); assert.equal(h.run().nextOrdinal, 0); assert.equal(h.dispatchCalls.length, 0); assert.equal(h.calendar().verifiedThrough, '2026-10-05');
});
test('two concurrent workers cannot execute the same operation', async () => {
  const h = harness(); const results = await Promise.allSettled([h.execute(), h.execute()]);
  assert.ok(results.some(row => row.status === 'fulfilled' && row.value.complete)); assert.equal(h.writes, 3); assert.equal(h.dispatchCalls.length, 3);
});
test('uncertain dispatch retains its position and barrier without continuing later activities', async () => {
  const h = harness(); h.onDispatch = async (key, options) => { assert.equal(options.recoveryOnly, undefined); h.writer().unresolved = { logicalKey: key }; return { state: 'recovery_required', complete: false }; };
  const result = await h.execute(); assert.equal(result.state, 'recovery_required'); assert.equal(result.complete, false); assert.equal(h.run().nextOrdinal, 0); assert.equal(h.dispatchCalls.length, 1); assert.ok(h.writer().unresolved);
});
test('cancellation after saved dispatch preserves progress and resumes the saved record', async () => {
  const h = harness(), controller = new AbortController();
  h.onDispatch = async key => { h.saveStep(key); controller.abort(); return { state: 'saved', complete: false }; };
  const interrupted = await h.execute({ signal: controller.signal }); assert.equal(interrupted.state, 'interrupted'); assert.equal(h.run().nextOrdinal, 0); assert.equal(h.writes, 1); assert.equal(h.run().leaseToken, null);
  h.onDispatch = null; assert.equal((await h.execute()).complete, true); assert.equal(h.writes, 3);
});
test('stop settles outstanding receipt using recovery-only dispatch before declaring stopped', async () => {
  const h = harness(); await h.periods.reserve(operationId, scope); h.calendar().stopRequested = true; h.writer().unresolved = { logicalKey: h.entries[0].step.logicalKey };
  const result = await h.execute(); assert.equal(result.state, 'stopped'); assert.equal(result.complete, false); assert.equal(h.dispatchCalls.length, 1); assert.equal(h.dispatchCalls[0].recoveryOnly, true); assert.equal(h.writes, 0); assert.equal(h.writer().unresolved, null);
});
test('unsettled stopped request remains recovery-required rather than falsely stopped', async () => {
  const h = harness(); await h.periods.reserve(operationId, scope); h.calendar().stopRequested = true; h.writer().unresolved = { logicalKey: h.entries[0].step.logicalKey };
  h.onDispatch = async (_key, options) => { assert.equal(options.recoveryOnly, true); return { state: 'recovery_required', complete: false }; };
  const result = await h.execute(); assert.equal(result.state, 'recovery_required'); assert.equal(h.run().status, 'blocked'); assert.ok(h.writer().unresolved);
});
test('lost period completion acknowledgement repairs durable receipt without recreating records', async () => {
  const h = harness(), finish = h.periods.finish; h.periods.finish = async (...args) => { await finish(...args); throw new Error('completion acknowledgement lost'); };
  const result = await h.execute(); assert.equal(result.complete, true); assert.equal(h.writes, 3); assert.equal(h.calendar().revision, 2);
});
test('an old completed operation remains complete after a later period advances', async () => {
  const h = harness(); await h.execute(); h.calendar().verifiedThrough = '2026-10-07'; h.calendar().revision = 3; h.calendar().lastVerifiedOperationId = 'd'.repeat(24);
  const result = await h.execute(); assert.equal(result.complete, true); assert.equal(h.writes, 3);
});
test('preview-only and already-cancelled requests cannot reserve or send', async () => {
  const h = harness(); h.run().status = 'previewed'; assert.equal((await h.execute()).state, 'approval_required'); assert.equal(h.dispatchCalls.length, 0); assert.equal(h.calendar().currentOperationId, null);
  h.run().status = 'approved'; const signal = new AbortController(); signal.abort(); assert.equal((await h.execute({ signal: signal.signal })).state, 'interrupted'); assert.equal(h.calendar().currentOperationId, null);
});

test('empty periods still collect proof and complete without writes', async () => {
  const h = harness(0); h.evidenceReady = false;
  assert.equal((await h.execute()).state, 'awaiting-evidence');
  h.evidenceReady = true; assert.equal((await h.execute()).complete, true);
  assert.equal(h.writes, 0); assert.equal(h.dispatchCalls.length, 0);
});
test('evidence failure after all records resumes evidence rather than restarting activities', async () => {
  const h = harness(), prepare = h.prepareEvidence;
  h.prepareEvidence = async () => { throw new Error('report read failed'); };
  const first = await h.execute(); assert.equal(first.complete, false); assert.equal(h.run().status, 'blocked'); assert.equal(h.run().nextOrdinal, 3);
  h.prepareEvidence = prepare; assert.equal((await h.execute()).complete, true);
  assert.equal(h.writes, 3); assert.equal(h.dispatchCalls.length, 3);
});

test('a worker replaced immediately before completion cannot advance the period', async () => {
  const h = harness(), finish = h.periods.finish;
  h.periods.finish = async (...args) => {
    h.run().leaseToken = 'replacement-worker-00000001';
    h.run().leaseExpiresAt = new Date(h.clock + 600000);
    return finish(...args);
  };
  await assert.rejects(h.execute(), /worker lease/);
  assert.equal(h.calendar().verifiedThrough, '2026-10-05');
  assert.equal(h.run().status, 'awaiting-evidence'); assert.equal(h.writes, 3);
});

test('cancellation as a successful opening check resolves never claims a worker lease', async () => {
  const h = harness(), controller = new AbortController(); let claims = 0;
  const run = require('../src/modules/business-operation-runner').createBusinessOperationRunner({state:{...h.state,claim:async(...args)=>{claims++;return h.state.claim(...args);}},plans:h.plans,steps:h.steps,dispatch:h.dispatch,periods:h.periods,prepareEvidence:h.prepareEvidence,validateOpening:async()=>{controller.abort();}});
  const result = await run(scope,operationId,{signal:controller.signal});
  assert.equal(result.state,'interrupted'); assert.equal(claims,0); assert.equal(h.run().leaseToken == null,true,'No worker lease was claimed'); assert.equal(h.run().status,'reserved'); assert.equal(h.writes,0); assert.equal(h.writer().operationId,operationId);
});

function needsCheckFixture(dependent = false) {
  const h = harness(), first = h.entries[0].step.logicalKey;
  if (dependent) {
    const plan = h.data.Plans[0], child = h.entries[1].step;
    child.dependencies = [{ logicalKey: first, entity: h.entries[0].step.entity, fingerprint: hash(h.entries[0].step) }];
    plan.manifest.records[1].relationships = [first]; plan.manifest.records[1].fingerprint = hash(child);
    h.run().planHash = hash(plan.manifest); plan.planHash = h.run().planHash; h.run().approval.planHash = h.run().planHash;
    const page = h.plans.page; h.plans.page = async (...args) => ({ ...await page(...args), planHash: h.run().planHash });
  }
  h.steps.evidence = async (_scope, _op, key) => h.data.Steps.find(row => row.logicalKey === key) || { state: 'unrecorded' };
  h.fixed = false;
  h.onDispatch = async key => {
    const row = h.saveStep(key);
    if (key === first && !h.fixed) { row.state = 'needs-check'; row.verification = { status: 'needs-check' }; return { state: 'needs-check', complete: false }; }
    return { state: 'verified', complete: true };
  };
  return h;
}
test('persistent saved mismatch retains its check while all independent records finish', async () => {
  const h = needsCheckFixture(), result = await h.execute();
  assert.equal(result.state, 'needs-check'); assert.equal(result.complete, false); assert.equal(result.completedRecords, 2);
  assert.equal(h.writes, 3); assert.equal(h.run().nextOrdinal, 3); assert.equal(h.run().deferredSteps.length, 1); assert.equal(result.recheckAvailable, true);
  assert.equal(h.calendar().verifiedThrough, '2026-10-05'); assert.equal(h.run().leaseToken, null);
  h.fixed = true; assert.equal((await h.execute()).complete, true); assert.equal(h.writes, 3); assert.equal(h.dispatchCalls.length, 4); assert.equal(h.run().deferredSteps.length, 0);
});
test('only dependants are held and a later automatic check releases them without replaying saved records', async () => {
  const h = needsCheckFixture(true), result = await h.execute();
  assert.equal(result.state, 'needs-check'); assert.equal(result.completedRecords, 1); assert.equal(h.writes, 2);
  assert.deepEqual(h.dispatchCalls.map(row => row.key), [h.entries[0].step.logicalKey, h.entries[2].step.logicalKey]);
  assert.deepEqual(h.run().deferredSteps.map(row => row.reason), ['needs-check', 'dependency']);
  assert.equal(h.data.Steps.some(row => row.logicalKey === h.entries[1].step.logicalKey), false);
  h.fixed = true; h.evidenceReady = false;
  assert.equal((await h.execute()).state, 'awaiting-evidence'); assert.equal(h.writes, 3); assert.equal(h.run().deferredSteps.length, 0);
});
test('day-close refuses retained checks even if a collector claims to have prepared evidence', async () => {
  const h = needsCheckFixture(); await h.execute(); const claimed = await h.state.claim(scope, operationId);
  h.entries.forEach(entry => h.saveStep(entry.step.logicalKey));
  await h.prepareEvidence(); // Even a fabricated all-pass collector cannot waive retained checks.
  await assert.rejects(h.periods.finish(operationId, scope, { leaseToken: claimed.leaseToken }), /unresolved|proof|evidence|verif/i);
  assert.equal(h.calendar().verifiedThrough, '2026-10-05');
});
test('a proven wrong posting or rejected write stops independent work', async () => {
  for (const kind of ['wrong-posting', 'rejected']) {
    const h = harness(); h.onDispatch = async key => {
      if (kind === 'rejected') return { state: 'rejected', complete: false };
      h.saveStep(key); throw Object.assign(new Error('Wrong account proven'), { code: 'BUSINESS_BOOK_RISK' });
    };
    const result = await h.execute(); assert.equal(result.complete, false); assert.equal(h.run().status, 'blocked'); assert.equal(h.dispatchCalls.length, 1); assert.equal(h.run().nextOrdinal, 0);
  }
});

test('failed pre-dispatch parent verification holds only that sibling and resumes through the real writer gate', async () => {
  const h = needsCheckFixture(true), first = h.entries[0].step.logicalKey, child = h.entries[1].step;
  h.writerFence = require('../src/modules/business-writer-fence').createBusinessWriterFence({ ...h.models, assertIntegration: async () => {}, now: () => h.clock });
  let rechecking = false;
  h.onDispatch = async key => {
    if (key === child.logicalKey && !rechecking) { const parent = h.data.Steps.find(row => row.logicalKey === first); parent.state = 'needs-check'; parent.verification = { status: 'needs-check' }; return { state: 'dependency-held', complete: false }; }
    if (key === child.logicalKey) await h.transaction(session => h.writerFence.fenceStep({ scope, intent: { ...scope, operationId, planHash: h.run().planHash, logicalKey: child.logicalKey, fingerprint: hash(child), entity: child.entity, dependencies: child.dependencies }, actorId: 'c'.repeat(24), phase: 'claim', runLeaseToken: h.run().leaseToken, session }));
    h.saveStep(key); return { state: 'verified', complete: true };
  };
  const result = await h.execute(); assert.equal(result.state, 'needs-check'); assert.equal(h.writes, 2); assert.equal(h.run().deferredSteps.length, 2);
  rechecking = true; h.evidenceReady = false;
  assert.equal((await h.execute()).state, 'awaiting-evidence'); assert.equal(h.writes, 3); assert.equal(h.run().deferredSteps.length, 0);
});
test('persistent checks on a later execution return a check action without blocking the batch', async () => {
  const h = needsCheckFixture(true); await h.execute(); const result = await h.execute();
  assert.equal(result.state, 'needs-check'); assert.equal(h.run().deferredSteps.length, 2); assert.equal(h.writes, 2); assert.equal(h.run().status, 'awaiting-evidence');
});
