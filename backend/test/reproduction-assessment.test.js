'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../src/modules/reproduction-assessment-contract');
const { createCaseAssessment, readAssessment } = require('../src/modules/reproduction-assessment');
const { hash } = require('../src/modules/business-calendar');
const clone = value => JSON.parse(JSON.stringify(value));
const { scenario, serviceFixture } = require('./helpers/case-assessment-fixture');
function rebind(f) { f.state.requestContract = { ...C.contractFrom(f.definition, f.state.requestSources), auditId: 'interpret-audit' }; for (const check of f.state.checks) check.origin.contractHash = f.state.requestContract.contentHash; }
test('server derives setup and symptom direction independently of the executor proposal', () => {
  const f = scenario();
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'reproduced');
  f.state.checks[1].actual = 0; f.state.checks[1].passed = false;
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'not_reproduced');
  const setup = scenario('setup'); assert.equal(C.verdict(setup.proof(), setup.review()).outcome, 'completed');
});
test('setup success never substitutes for an omitted or unavailable symptom', () => {
  const f = scenario(); f.state.checks.pop();
  const result = C.verdict(f.proof(), f.review()); assert.equal(result.outcome, 'unverified'); assert.equal(result.setupComplete, true);
  const missing = f.review(); missing.coverage = 'missing';
  assert.equal(C.verdict(f.proof(), missing).outcome, 'unverified');
});
test('predicate reversal, record-exists substitution and wrong channels cannot prove the reported measurement', () => {
  const f = scenario(); f.state.checks[1].operator = 'not_equal'; f.state.checks[1].passed = true;
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'unverified');
  f.state.checks[1].operator = 'equal'; f.definition.requirements[1].channel = 'screen'; rebind(f);
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'unverified');
  const invalid = f.review(); invalid.requirements[1].relevance = 'unsupported';
  assert.equal(C.verdict(f.proof(), invalid).outcome, 'unverified');
});
test('mixed multiple symptoms stay unverified and missing evidence overrides a mismatch', () => {
  const f = scenario(), third = clone(f.definition.requirements[1]); third.id = 'r3'; third.label = 'Another reported symptom'; f.definition.requirements.push(third);
  rebind(f);
  f.state.checks.push(f.check(third.label, 'Balance', 0, 20));
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'unverified');
  f.state.checks[1].available = false;
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'unverified');
});
test('final requirements reject historical, stale, old-revision and pre-write checks', () => {
  for (const mode of ['historical', 'age', 'revision', 'before-write']) {
    const f = scenario();
    if (mode === 'historical') f.state.checks[1].historical = true;
    if (mode === 'age') f.state.checks[1].checkedAt = new Date(f.clock - 16 * 60000);
    if (mode === 'revision') f.state.checks[1].revision = 0;
    if (mode === 'before-write') f.state.checks[1].checkedAt = new Date(f.clock - 3000);
    assert.equal(C.verdict(f.proof(), f.review()).outcome, 'unverified', mode);
  }
});
test('explicit intermediate ordering is checked and supplemental measurements cannot hide failures', () => {
  const f = scenario(); f.definition.requirements[0].timing = 'intermediate'; f.definition.requirements[1].after = ['r1'];
  rebind(f); f.state.checks[0].historical = true;
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'reproduced');
  f.state.checks[0].checkedAt = new Date(f.clock - 500);
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'unverified');
  const g = scenario(); g.state.checks.push(g.check(g.state.checks[1].label, 'Line.0.Amount', 0, 20));
  assert.equal(C.verdict(g.proof(), g.review()).outcome, 'not_reproduced');
  const hidden = g.review(); hidden.requirements[1].checkIds = ['c2'];
  assert.equal(C.verdict(g.proof(), hidden).outcome, 'unverified');
});
test('a later reading of the same measurement resolves its earlier failure while both remain retained', () => {
  const f = scenario(); f.state.checks[1].actual = 0; f.state.checks[1].passed = false; f.state.checks[1].revision = 0;
  f.state.checks.push(f.check(f.state.checks[1].label, 'Balance', 20, 20));
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'reproduced');
});
test('source spans, ordering, strict schema and full evidence budgets fail closed', () => {
  const f = scenario(), bad = clone(f.definition);
  bad.requirements[1].sources[0].end = f.message.length + 1; assert.throws(() => C.contractFrom(bad, f.state.requestSources), /invented/);
  bad.requirements[1].sources[0].end -= 1; bad.requirements[0].after = ['r2']; assert.throws(() => C.contractFrom(bad, f.state.requestSources), /ordering/);
  assert.throws(() => C.parse('{"extra":true} trailing'), /strict JSON/);
  assert.throws(() => C.parse('x'.repeat(32769)), /size/);
  f.state.checks[0].actual = 'x'.repeat(500001); assert.throws(f.proof, /budget/);
});
test('complete normalized evidence excludes contacts and raw notes without clipping monetary measurements', () => {
  const f = scenario(); f.state.checks[0].actual = 'x'.repeat(900);
  const proof = f.proof(); assert.equal(proof.payload.checks[0].actual.length, 900);
  assert.equal(proof.payload.actions[0].input.record.PrimaryEmailAddr, undefined);
  assert.equal(proof.payload.actions[0].input.record.PrivateNote, undefined);
  assert.equal(JSON.stringify(proof).includes('private@example.invalid'), false);
  assert.equal(proof.payload.actions[0].input.record.TotalAmt, 120);
});
test('invented references, incomplete constraint ledgers, unknown writes and pending approvals deny success', () => {
  const f = scenario(), invented = f.review(); invented.requirements[0].checkIds = ['c999'];
  assert.throws(() => C.verdict(f.proof(), invented), /invented evidence/);
  for (const mutation of [() => { f.state.outcomeUnknown = true; }, () => { f.state.outcomeUnknown = false; f.plan.steps[0].status = 'executing'; }, () => { f.plan.steps[0].status = 'completed'; f.plan.steps[0].approval = { state: 'needed' }; }]) {
    mutation(); assert.equal(C.verdict(f.proof(), f.review()).outcome, 'unverified');
  }
});
test('typed Continue preserves the exact source hash while an actual amendment adds original text', () => {
  const f = scenario(), same = C.requestSources(f.session, { continueSaved: true, requestId: 'continue-123456789', actorId: 'owner' });
  assert.equal(same.contentHash, f.state.requestSources.contentHash);
  const next = C.requestSources(f.session, { message: 'Use a final balance of 25 instead.', requestId: 'amendment-123456789', actorId: 'owner' });
  assert.equal(next.payload.entries.length, 2); assert.notEqual(next.contentHash, same.contentHash);
  assert.equal(f.state.requestSources.payload.entries.length, 1);
});
test('fresh independent assessment is audit/source/receipt bound and public reads call no provider', async () => {
  const f = await serviceFixture(); const result = await f.api.reviewFinish({ deadline: f.clock + 30000 }); f.state.outcome = result.outcome;
  assert.equal(result.outcome, 'reproduced'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].inferenceOnly, true); assert.equal(f.calls[0].maxOutputBytes, 32768); assert.ok(f.calls[0].signal);
  assert.equal((await readAssessment(f.session, f.plan, f.loadAudit)).valid, true); assert.equal(f.calls.length, 1);
  f.plan.steps[0].result.data.id = '101'; assert.equal((await readAssessment(f.session, f.plan, f.loadAudit)).valid, false);
});
test('lost audit, changed checks, owner decision and scope changes invalidate retained review', async () => {
  for (const mode of ['audit', 'checks', 'decision', 'scope']) {
    const f = await serviceFixture(); const result = await f.api.reviewFinish({ deadline: f.clock + 30000 }); f.state.outcome = result.outcome;
    if (mode === 'audit') f.audits.delete(f.state.assessment.auditId);
    if (mode === 'checks') f.state.checks[1].actual = 0;
    if (mode === 'decision') f.state.decisionRevision = 1;
    if (mode === 'scope') f.session.realmId = 'other';
    assert.equal((await readAssessment(f.session, f.plan, f.loadAudit)).valid, false, mode);
  }
});
test('assessor malformed output or late evidence changes downgrade without executing any action', async () => {
  const malformed = await serviceFixture({ complete: async () => ({ text: 'not JSON' }) });
  assert.equal((await malformed.api.reviewFinish({ deadline: malformed.clock + 30000 })).outcome, 'unverified'); assert.equal(malformed.plan.steps.length, 1);
  const changed = await serviceFixture({ onReload: saved => { saved.session.reproduction.decisionRevision = 1; } });
  assert.equal((await changed.api.reviewFinish({ deadline: changed.clock + 30000 })).outcome, 'unverified'); assert.equal(changed.state.assessment, undefined);
});
test('Stop overrides a provider response and failed interpretation never starts execution', async () => {
  const f = await serviceFixture({ complete: async (_input, fixture) => { fixture.state.stopRequested = true; return { text: JSON.stringify(fixture.review()) }; } });
  await assert.rejects(f.api.reviewFinish({ deadline: f.clock + 30000 }), /Stopped/);
  const g = await serviceFixture({ complete: async () => ({ text: '{}' }) }); delete g.state.requestContract;
  await assert.rejects(g.api.ensureContract({ deadline: g.clock + 30000 }), /could not be interpreted/); assert.equal(g.calls.length, 2);
  assert.equal(g.plan.steps.length, 1); assert.equal(g.state.requestContract, undefined);
});

test('source-bound scalar setup rejects the executor choosing a convenient wrong amount', () => {
  const f = scenario('setup'), definition = clone(f.definition);
  definition.requirements[0].predicate = null;
  assert.throws(() => C.contractFrom(definition, f.state.requestSources), /source-bound predicate/);
  f.state.checks[0].actual = 50; f.state.checks[0].expected = 50; f.state.checks[0].passed = true;
  assert.equal(C.verdict(f.proof(), f.review()).outcome, 'unverified');
});
test('an original intermediate observation survives a later run, but old final evidence does not', () => {
  const f = scenario(); f.definition.requirements[0].timing = 'intermediate'; rebind(f); f.state.checks[0].historical = true;
  const oldRun = f.state.runId, later = f.clock + 3600000;
  f.state.caseRunHistory = [{ runId: oldRun, sourceHash: f.state.requestSources.contentHash, contractHash: f.state.requestContract.contentHash, startedAt: new Date(f.clock - 10000), endedAt: new Date(f.clock) }];
  f.state.runId = 'run-2'; f.state.startedAt = new Date(later - 5000); f.state.revision = 2;
  let proof = C.snapshot(f.session, f.plan, new Date(later).toISOString());
  assert.equal(C.verdict(proof, f.review()).outcome, 'unverified');
  f.state.checks[1].origin.runId = f.state.runId; f.state.checks[1].revision = 2; f.state.checks[1].checkedAt = new Date(later - 1000);
  proof = C.snapshot(f.session, f.plan, new Date(later).toISOString());
  assert.equal(C.verdict(proof, f.review()).outcome, 'reproduced');
});
test('foreign-case, wrong-actor and changed event metadata invalidate original audit links', async () => {
  for (const mode of ['case', 'run', 'plan', 'actor', 'type', 'ai']) {
    const f = await serviceFixture(), result = await f.api.reviewFinish({ deadline: f.clock + 30000 }); f.state.outcome = result.outcome;
    const row = f.audits.get(f.state.assessment.auditId);
    if (mode === 'case') row.inputParams.caseId = 'foreign-case';
    if (mode === 'run') row.afterState.runId = 'foreign-run';
    if (mode === 'plan') row.approvalEvent = 'foreign-plan';
    if (mode === 'actor') row.actorUserId = 'foreign-actor';
    if (mode === 'type') row.actionType = 'manual';
    if (mode === 'ai') row.aiDriven = false;
    assert.equal((await readAssessment(f.session, f.plan, f.loadAudit)).valid, false, mode);
  }
});

test('interpreter quotations become exact server-computed spans and ambiguous quotes are refused', () => {
  const f = scenario(), value = clone(f.definition);
  value.requirements[0].sources = [{ requestId: 'request-123456789', quote: 'invoice for 120' }];
  const saved = C.contractFrom(value, f.state.requestSources), ref = saved.payload.requirements[0].sources[0];
  assert.equal(f.message.slice(ref.start, ref.end), 'invoice for 120'); assert.equal(Object.hasOwn(ref, 'quote'), false);
  value.requirements[0].sources[0].quote = 'not in the original request';
  assert.throws(() => C.contractFrom(value, f.state.requestSources), /unique exact source quotation/);
});
