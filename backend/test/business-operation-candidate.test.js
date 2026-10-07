'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleBusinessOperation, bindApprovedOperationPolicies } = require('../src/modules/business-operation-candidate');
const { validateOperationCandidate } = require('../src/modules/business-operation-plan-store');
const { hash, canonical } = require('../src/modules/business-calendar');
const { candidateFixture, signPrepared, signHistory } = require('./helpers/business-operation-candidate-fixture');
const clone = value => JSON.parse(JSON.stringify(value));
function assembled(earlier = false) { const f = candidateFixture(earlier); return { f, assembly: assembleBusinessOperation(f) }; }
test('current activity is ordered and fingerprinted before an exact approved policy is accepted', () => {
  const { f, assembly } = assembled(), entries = assembly.candidate.entries;
  assert.deepEqual(entries.map(entry => entry.step.entity), ['PurchaseOrder', 'Bill']);
  assert.equal(entries[1].step.dependencies[0].fingerprint, hash(entries[0].step));
  assert.equal(entries[0].policy, undefined); assert.equal(assembly.readyToExecute, false); assert.equal(assembly.persisted, false);
  const policies = f.policies(assembly), before = canonical(policies), result = bindApprovedOperationPolicies(assembly, policies, f.now);
  assert.equal(canonical(policies), before); assert.equal(result.candidateHash, hash(result.candidate));
  assert.equal(result.planHash, validateOperationCandidate(result.candidate, f.context.scope, f.now).planHash);
  for (const key of ['requiresActivationFence', 'requiresOwnershipReview', 'requiresFreshReadback']) assert.equal(result[key], true);
  assert.equal(result.readyToExecute, false); assert.equal(result.persisted, false);
});
test('original earlier steps, policies and ownership survive assembly unchanged', () => {
  const { f, assembly } = assembled(true), before = canonical(f.history.entries[0]), entry = assembly.candidate.entries[0];
  assert.equal(entry.kind, 'existing'); assert.equal(canonical(entry.step), canonical(f.history.entries[0].step));
  assert.equal(canonical(entry.policy), canonical(f.history.entries[0].policy));
  const result = bindApprovedOperationPolicies(assembly, f.policies(assembly), f.now);
  assert.equal(canonical(result.candidate.entries[0].step), canonical(f.history.entries[0].step));
  assert.equal(assembly.origins[0].operationId, f.history.entries[0].operationId); assert.equal(canonical(f.history.entries[0]), before);
});
test('preparation and full history integrity, scope, freshness and roots are required', () => {
  for (const mutate of [f => f.prepared.steps.pop(), f => f.history.entries.push({}), f => { f.context.scope.realmId = '999'; }, f => { f.context.blueprintHash = hash('different'); }, f => { f.prepared.preparedAt = new Date(f.now - 300001).toISOString(); }, f => { f.history.scope.realmId = '999'; signHistory(f.history); }, f => { f.history.roots.pop(); signHistory(f.history); }, f => { f.history.observedAt = new Date(f.now + 1).toISOString(); signHistory(f.history); }]) {
    const f = candidateFixture(); mutate(f); assert.throws(() => assembleBusinessOperation(f));
  }
});
test('unresolved choices and unrelated blockers cannot become executable steps', () => {
  for (const mutate of [f => { f.prepared.steps[0].references[0].status = 'review_required'; }, f => { delete f.prepared.steps[0].references[0].definition; }, f => { f.prepared.steps[0].blockers.push({ kind: 'record_choice', key: 'tax' }); }, f => { f.prepared.steps[0].blockers.push({ kind: 'unknown_future_check' }); }, f => { f.prepared.steps[0].blockers.push({ kind: 'prior_record', key: hash('unrelated') }); }, f => { f.prepared.steps[0].details.lines[0].quantity++; }]) {
    const f = candidateFixture(); mutate(f); signPrepared(f.prepared); assert.throws(() => assembleBusinessOperation(f));
  }
});
test('all claimed current activity requires resume even if the saved state is uncertain', () => {
  const f = candidateFixture(true); f.history.entries[0].logicalKey = f.prepared.steps[0].logicalKey; f.history.entries[0].state = 'unknown'; signHistory(f.history);
  assert.throws(() => assembleBusinessOperation(f), /Resume/);
});
test('missing, uncertain, cross-business and changed earlier ownership is rejected', () => {
  for (const mutate of [f => { f.history.entries = []; f.history.missing.push(f.po.step.logicalKey); }, f => { f.history.entries[0].state = 'unknown'; }, f => { f.history.entries[0].qboId = null; }, f => { f.history.entries[0].businessKey = 'other-business'; }, f => { f.history.entries[0].step.details.lines[0].quantity++; }, f => { f.history.entries[0].policy.stepHash = hash('changed'); }, f => { f.history.entries.push(clone(f.history.entries[0])); }]) {
    const f = candidateFixture(true); mutate(f); signHistory(f.history); assert.throws(() => assembleBusinessOperation(f));
  }
});
test('exact missing-root coverage is required and local absence never proves provider absence', () => {
  const f = candidateFixture(); f.history.missing.pop(); signHistory(f.history); assert.throws(() => assembleBusinessOperation(f), /coverage/);
  const result = assembleBusinessOperation(candidateFixture()); assert.equal(result.requiresOwnershipReview, true);
});
test('dependency cycles, duplicate links and changed original fingerprints are rejected', () => {
  const f = candidateFixture(); f.prepared.steps[1].dependencies = [{ logicalKey: f.prepared.steps[0].logicalKey, entity: 'Bill' }]; signPrepared(f.prepared);
  assert.throws(() => assembleBusinessOperation(f), /cycle/);
  const g = candidateFixture(); g.prepared.steps[0].dependencies.push(clone(g.prepared.steps[0].dependencies[0])); signPrepared(g.prepared);
  assert.throws(() => assembleBusinessOperation(g), /ambiguous/);
  const h = candidateFixture(true); h.prepared.steps[0].dependencies[0].fingerprint = hash('other'); signPrepared(h.prepared);
  assert.throws(() => assembleBusinessOperation(h), /originating/);
});
test('calendar continuity and limits are enforced before policy binding', () => {
  for (const mutate of [f => { f.context.expectedCursor = '2026-10-04'; }, f => { f.context.expectedRevision = -1; }, f => { f.context.requiredAssertions = []; }, f => { f.context.baselineHash = null; }, f => { f.prepared.throughDate = '2026-11-06'; signPrepared(f.prepared); }, f => { f.prepared.steps = Array(501).fill(f.prepared.steps[0]); signPrepared(f.prepared); }, f => { f.context.padding = 'x'.repeat(8000000); }]) {
    const f = candidateFixture(); mutate(f); assert.throws(() => assembleBusinessOperation(f));
  }
});
test('policies are never rewritten to match a different finalized step or approval state', () => {
  const { f, assembly } = assembled();
  for (const mutate of [p => { p[0].policy.stepHash = hash('preview step'); }, p => { p[0].policy.status = 'proposed'; }, p => { p[0].policy.scope.realmId = '999'; }, p => { p[0].policy.country = 'US'; }, p => { p[0].logicalKey = hash('other'); }, p => p.pop(), p => { p[1].logicalKey = p[0].logicalKey; }]) {
    const policies = f.policies(assembly); mutate(policies); const before = canonical(policies);
    assert.throws(() => bindApprovedOperationPolicies(assembly, policies, f.now)); assert.equal(canonical(policies), before);
  }
  const changed = clone(assembly); changed.candidate.entries[0].step.references[0].id = '999';
  assert.throws(() => bindApprovedOperationPolicies(changed, f.policies(assembly), f.now), /changed/);
  assert.throws(() => bindApprovedOperationPolicies(assembly, f.policies(assembly), f.now + 300001), /stale/);
});
test('assembly is stable across preview order and does not mutate caller inputs', () => {
  const f = candidateFixture(), before = canonical(f.prepared), first = assembleBusinessOperation(f);
  assert.equal(canonical(f.prepared), before);
  f.prepared.steps.reverse(); signPrepared(f.prepared); const second = assembleBusinessOperation(f);
  assert.equal(canonical(first.candidate), canonical(second.candidate));
  const policies = f.policies(second), result = bindApprovedOperationPolicies(second, policies, f.now);
  result.candidate.entries[0].step.references[0].id = '999'; assert.notEqual(second.candidate.entries[0].step.references[0].id, '999');
});

test('actual business preview assembles full first-period chains after explicit fixture reference resolution', () => {
  const { fixture, now } = require('./helpers/business-preparation-fixture');
  const { bindBusinessReference } = require('../src/modules/business-reference');
  const { operationHistoryRoots } = require('../src/modules/business-operation-preview');
  const f = fixture(); f.view.draft.business.openingDate = '2026-10-01';
  const prepared = f.prepare(); assert.ok(prepared.steps.length > 10);
  assert.equal(prepared.businessKey, 'harbour-pine-v1'); assert.equal(prepared.blueprintId, f.view.draft.id);
  // This is simulated reviewed reference data; production tax approval remains unwired.
  for (const step of prepared.steps) {
    step.references = step.references.map(ref => {
      const record = { Id: ref.id, SyncToken: ref.syncToken, Active: true }, recordHash = hash(record);
      return bindBusinessReference({ scope: prepared.scope, entity: ref.entity, key: ref.key, now: now.getTime(), observed: { scope: prepared.scope, entity: ref.entity, record, recordHash, observedAt: now.toISOString(), source: { version: 1, kind: 'qbo-full-entity-get', scope: prepared.scope, entity: ref.entity, id: ref.id, endpoint: ref.entity.toLowerCase() + '/' + ref.id, recordHash } } });
    });
    step.blockers = step.blockers.filter(blocker => blocker.kind !== 'record_choice');
  }
  signPrepared(prepared);
  const history = signHistory({ version: 1, scope: prepared.scope, roots: operationHistoryRoots(prepared), entries: [], missing: prepared.steps.map(step => step.logicalKey).sort(), observedAt: now.toISOString(), requiresCurrentReadback: true });
  const context = { scope: prepared.scope, businessKey: prepared.businessKey, blueprintId: prepared.blueprintId, blueprintHash: prepared.blueprintHash, baselineHash: hash('reviewed fixture baseline'), openingDate: prepared.openingDate, expectedCursor: null, expectedRevision: 0, requiredAssertions: [{ key: 'trial-balance', evidenceType: 'accrual-ledger', currency: 'CAD', basis: 'Accrual' }] };
  const assembly = assembleBusinessOperation({ prepared, history, context, now: now.getTime() });
  assert.equal(assembly.candidate.entries.length, prepared.steps.length);
  const positions = new Map(assembly.candidate.entries.map((entry, index) => [entry.step.logicalKey, index]));
  for (const [index, entry] of assembly.candidate.entries.entries()) for (const link of entry.step.dependencies) { assert.ok(positions.get(link.logicalKey) < index); assert.equal(link.fingerprint, hash(assembly.candidate.entries[positions.get(link.logicalKey)].step)); }
  const policies = assembly.candidate.entries.map(entry => ({ logicalKey: entry.step.logicalKey, policy: { version: 1, status: 'approved', scope: prepared.scope, country: 'CA', currency: 'CAD', stepHash: hash(entry.step), evidenceHash: hash('separate fixture approval'), fromDate: prepared.fromDate, throughDate: prepared.throughDate } }));
  const bound = bindApprovedOperationPolicies(assembly, policies, now.getTime());
  assert.equal(validateOperationCandidate(bound.candidate, prepared.scope, now.getTime()).manifest.recordCount, prepared.steps.length);
  assert.equal(bound.readyToExecute, false);
});
test('empty periods still bind their calendar and report requirements without invented activity', () => {
  const f = candidateFixture(); f.prepared.steps = []; signPrepared(f.prepared); f.history.roots = []; f.history.missing = []; signHistory(f.history);
  const assembly = assembleBusinessOperation(f), result = bindApprovedOperationPolicies(assembly, [], f.now);
  assert.equal(result.candidate.entries.length, 0); assert.equal(result.candidate.requiredAssertions.length, 1);
});

test('incompatible company currency and unknown operation-wide blockers cannot disappear', () => {
  const { fixture } = require('./helpers/business-preparation-fixture');
  const f = fixture(); f.setup.observations.homeCurrency = 'USD';
  const prepared = f.prepare(); assert.ok(prepared.remaining.some(item => item.key === 'home_currency'));
  const source = candidateFixture();
  assert.throws(() => assembleBusinessOperation({ ...source, prepared }), /operation-wide/);
  for (const key of ['unknown_new_requirement', 'saved_plan', 'home_currency']) {
    const g = candidateFixture(); g.prepared.remaining.push({ key, reason: 'Still unresolved.' }); signPrepared(g.prepared);
    assert.throws(() => assembleBusinessOperation(g), /operation-wide/);
  }
});
test('known deferred operation requirements survive policy binding without a readiness claim', () => {
  const { f, assembly } = assembled(), bound = bindApprovedOperationPolicies(assembly, f.policies(assembly), f.now);
  assert.deepEqual(assembly.requirements, f.prepared.remaining); assert.deepEqual(bound.requirements, f.prepared.remaining);
  assert.equal(bound.readyToExecute, false);
});

test('complete original dependency closure is preserved without regenerating earlier intent', () => {
  const { fixture } = require('./helpers/business-transaction-fixtures');
  const { operationHistoryRoots } = require('../src/modules/business-operation-preview');
  const f = candidateFixture(true), estimate = fixture('Estimate'), time = fixture('TimeActivity'), invoice = fixture('Invoice');
  estimate.step.txnDate = '2026-10-04'; estimate.approve();
  time.step.txnDate = '2026-10-05'; time.step.dependencies = [{ logicalKey: estimate.step.logicalKey, entity: 'Estimate', fingerprint: hash(estimate.step) }];
  time.step.details.references = [{ logicalKey: estimate.step.logicalKey, entity: 'Estimate' }]; time.approve();
  invoice.step.dependencies = [{ logicalKey: estimate.step.logicalKey, entity: 'Estimate' }, { logicalKey: time.step.logicalKey, entity: 'TimeActivity' }];
  invoice.step.details.references = invoice.step.dependencies.map(link => ({ ...link })); invoice.approve();
  f.prepared.steps = [{ ...clone(invoice.step), blockers: invoice.step.dependencies.map(link => ({ kind: 'prior_record', key: link.logicalKey })) }]; signPrepared(f.prepared);
  f.history.entries = [estimate, time].map((source, index) => ({ businessKey: 'flagship', operationId: 'f'.repeat(24), planHash: hash('original'), logicalKey: source.step.logicalKey, entity: source.step.entity, fingerprint: hash(source.step), state: 'verified', revision: 2, qboId: String(100 + index), step: clone(source.step), policy: clone(source.policy) }));
  f.history.roots = operationHistoryRoots(f.prepared); f.history.missing = [invoice.step.logicalKey]; signHistory(f.history);
  const assembly = assembleBusinessOperation(f);
  assert.deepEqual(assembly.candidate.entries.map(entry => entry.step.entity), ['Estimate', 'TimeActivity', 'Invoice']);
  for (const original of f.history.entries) { const retained = assembly.candidate.entries.find(entry => entry.step.logicalKey === original.logicalKey); assert.equal(canonical(retained.step), canonical(original.step)); assert.equal(canonical(retained.policy), canonical(original.policy)); }
  const policies = [{ logicalKey: invoice.step.logicalKey, policy: { ...invoice.policy, stepHash: hash(assembly.candidate.entries.at(-1).step) } }];
  assert.equal(bindApprovedOperationPolicies(assembly, policies, f.now).candidate.entries.length, 3);
  f.history.entries.pop(); signHistory(f.history); assert.throws(() => assembleBusinessOperation(f), /missing/);
});
test('unrelated original rows and duplicate physical transaction ownership are rejected', () => {
  const f = candidateFixture(true), extra = clone(f.history.entries[0]);
  extra.logicalKey = hash('another logical activity'); extra.step.logicalKey = extra.logicalKey; extra.fingerprint = hash(extra.step); extra.policy.stepHash = extra.fingerprint;
  f.history.entries.push(extra); signHistory(f.history);
  assert.throws(() => assembleBusinessOperation(f), /same QuickBooks record/);
  extra.qboId = '999'; signHistory(f.history); assert.throws(() => assembleBusinessOperation(f), /unrelated/);
});
