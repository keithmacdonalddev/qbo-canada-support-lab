'use strict';
process.env.QBO_ENVIRONMENT = 'production';
const test = require('node:test'), assert = require('node:assert/strict');
const { scenario } = require('./helpers/master-preparation-scenario');
const { remoteMasters } = require('./helpers/master-preparation-remote');
const { scope, ownerId, clone } = require('./helpers/master-transport-fixture');
const { createMasterPreparationRunner } = require('../src/modules/business-master-preparation-runner');
const { masterApplyReview } = require('../src/modules/business-master-apply');
const { verifyMasterReadback, compileMasterEntry } = require('../src/modules/business-master-preparation-plan');
const { verifiedParents } = require('../src/modules/business-master-preparation-transport');
const { inspectBusinessMasters, readBusinessMasters } = require('../src/modules/business-master-data');
const { checkBlueprintMappings } = require('../src/modules/blueprint-mapping-check');
const { readDraftSetup, draftView } = require('../src/modules/blueprint-draft');
const { hash } = require('../src/modules/business-calendar');
const { masterProgressHash } = require('../src/modules/business-master-receipt');
const key = '11223344-1111-4111-8111-111111111111';
async function fixture(t) {
  const h = scenario(); t.mock.method(Date, 'now', () => h.clock); remoteMasters(h); await h.propose(); await h.approve();
  h.execute = createMasterPreparationRunner({ scope, ownerId, store: h.store, authorize: h.access.authorize, clientFor: async () => h.client, readPolicy: async () => clone(h.data.Policies[0]), now: () => h.clock });
  h.pause = () => Object.assign(h.data.Users[0], { email: 'tester@testdatalab.local', authVersion: 1, accessPolicyVersion: 1, automationAccessPolicyVersion: 0 });
  h.review = ordinals => h.store.applyReview(String(h.run()._id), ordinals);
  return h;
}
test('known accepted readback recovers while automation is paused without issuing another POST', async t => {
  const h = await fixture(t), original = h.onGET; let once = true;
  h.onGET = async opts => { if (/\/account\/100$/.test(new URL(opts.url).pathname) && once) { once = false; throw new Error('fixture GET unavailable'); } return original(opts); };
  await h.execute(String(h.run()._id)); assert.equal(h.run().records[0].state, 'saved'); h.pause();
  const recovered = await h.execute.recover(String(h.run()._id)); assert.equal(recovered.state, 'stopped'); assert.equal(h.run().records[0].state, 'verified'); assert.equal(h.sent.length, 1); assert.equal(h.writer().unresolved, null); assert.equal(h.writer().operationId, String(h.run()._id));
  await assert.rejects(h.store.claim(String(h.run()._id), { resume: true, reviewHash: masterProgressHash(h.run()) }));
});
test('expired reserved request needs company-wide receipt absence and a new owner-approved attempt identity', async t => {
  const h = await fixture(t); await h.claim(); await h.prepare(0); const old = clone(h.run().records[0].attempts[0]); h.clock += 300001;
  h.data.Receipts.push({ _id: 'other', environment: scope.environment, realmId: scope.realmId, dispatchKey: old.dispatchKey });
  await assert.rejects(h.store.retry(String(h.run()._id), 0, h.run().planHash, true, masterProgressHash(h.run()))); assert.equal(h.run().records[0].state, 'reserved'); h.data.Receipts = [];
  await h.store.retry(String(h.run()._id), 0, h.run().planHash, true, masterProgressHash(h.run())); assert.equal(h.run().records[0].attempts[0].state, 'proved-unsent'); assert.equal(h.run().records[0].state, 'pending');
  const result = await h.execute(String(h.run()._id), { resume: true, reviewHash: masterProgressHash(h.run()) }); assert.equal(result.complete, true); assert.equal(h.sent.length, 32); assert.equal(h.run().records[0].attempts.length, 2); assert.notEqual(h.run().records[0].attempts[1].dispatchKey, old.dispatchKey);
});
test('definite refusal stays visible and requires an exact audited owner retry', async t => {
  const h = await fixture(t), original = h.onSDK; let refuse = true;
  h.onSDK = async opts => refuse ? { status: 400, json: { Fault: { type: 'ValidationFault', Error: [{ code: '6000' }] } } } : original(opts);
  await h.execute(String(h.run()._id)); assert.equal(h.run().records[0].state, 'rejected'); assert.equal(h.writer().unresolved, null); await h.execute(String(h.run()._id)); assert.equal(h.sent.length, 1);
  await assert.rejects(h.store.retry(String(h.run()._id), 0, h.run().planHash, false, masterProgressHash(h.run()))); await h.store.retry(String(h.run()._id), 0, h.run().planHash, true, masterProgressHash(h.run())); refuse = false;
  assert.equal((await h.execute(String(h.run()._id), { resume: true, reviewHash: masterProgressHash(h.run()) })).complete, true); assert.equal(h.sent.length, 33); assert.equal(h.run().records[0].attempts.length, 2); assert.equal(h.run().records[0].attempts[0].state, 'rejected');
});
test('unknown remote creation cannot be retried or closed merely because its lease expired', async t => {
  const h = await fixture(t); h.afterCreate = async () => { throw Object.assign(new Error('fixture lost transport'), { code: '500' }); }; await h.execute(String(h.run()._id)); h.clock += 600000;
  await assert.rejects(h.store.retry(String(h.run()._id), 0, h.run().planHash, true, masterProgressHash(h.run()))); await assert.rejects(h.store.retain(String(h.run()._id), h.run().planHash, true, masterProgressHash(h.run()))); assert.equal(h.run().claim, 'open'); assert.ok(h.writer().unresolved); assert.equal(h.sent.length, 1);
});
test('accepted but incompatible IDs can be retained unassigned while paused, preserving all receipts', async t => {
  const h = await fixture(t); h.changeRead = row => ({ ...row, Active: false }); await h.execute(String(h.run()._id)); h.pause();
  const closed = await h.store.retain(String(h.run()._id), h.run().planHash, true, masterProgressHash(h.run())); assert.equal(closed.claim, 'closed'); assert.equal(closed.records[0].qboId, '100'); assert.equal(closed.records[0].state, 'saved'); assert.ok(closed.records.slice(1).every(row => row.state === 'retired')); assert.equal(h.writer().operationId, null); assert.equal(h.writer().unresolved, null); assert.equal(h.data.Receipts.length, 1); assert.equal(h.sent.length, 1);
});
test('verified IDs apply atomically into a new normal draft and pass normal mapping and master validators', async t => {
  const h = await fixture(t); await h.execute(String(h.run()._id)); const runId = String(h.run()._id), ordinals = h.run().records.map(row => row.ordinal), review = await h.review(ordinals);
  h.failAudit = true; await assert.rejects(h.store.apply(runId, review, key)); assert.equal(h.data.Versions.length, 1); assert.equal(h.run().claim, 'open'); h.failAudit = false;
  const saved = await h.store.apply(runId, review, key); assert.equal(saved.draft.version, 2); assert.equal(h.run().claim, 'closed'); assert.equal(h.sent.length, 32); assert.equal(h.data.Versions.length, 2); assert.equal(h.data.Versions[0].contentHash, review.baseHash);
  const view = { ...scope, draft: saved.draft }, observed = await readBusinessMasters(h.client, scope), setup = await readDraftSetup(h.client, scope);
  assert.equal(inspectBusinessMasters(view, observed).unresolved, 0); const mappings = checkBlueprintMappings(view, setup, { connectionId: scope.connectionId, baseHash: saved.draft.contentHash }); assert.equal(mappings.compatibleAccounts, 10); assert.equal(mappings.unresolvedMappings, 2); assert.ok(mappings.rows.filter(row => ['salesTax', 'purchaseTax'].includes(row.key)).every(row => row.status === 'review_required'));
  h.data.Versions.push({ ...clone(h.data.Versions[1]), _id: '000000000000000000000077', version: 3 }); h.data.Sequences[0].value = 3;
  const retry = await h.store.apply(runId, { reviewHash: review.reviewHash }, key); assert.equal(retry.draft.id, saved.draft.id); assert.equal(retry.reused, true); assert.equal(h.data.Versions.length, 3);
});
test('a changed draft can receive a compatible exact subset, without replacing a different current choice', async t => {
  const h = await fixture(t); h.afterCreate = async () => h.store.stop(String(h.run()._id)); await h.execute(String(h.run()._id)); const before = clone(h.data.Versions[0]);
  const changed = { ...before, _id: '000000000000000000000088', version: 2, definition: clone(before.definition) }; changed.definition.publicSafeIdentity.displayName = 'Revised Business'; changed.definition.publicSafeIdentity.legalName = 'Revised Business'; changed.contentHash = hash(changed.definition); h.data.Versions.push(changed); h.data.Sequences[0].value = 2;
  const review = await h.review([0]); changed.definition.mappings.operatingBank = '999'; changed.contentHash = hash(changed.definition); await assert.rejects(h.store.apply(String(h.run()._id), review, key)); assert.equal(h.run().claim, 'open');
  const restored = h.data.Versions.at(-1); restored.definition.mappings.operatingBank = null; restored.contentHash = hash(restored.definition); const refreshed = await h.review([0]), applied = await h.store.apply(String(h.run()._id), refreshed, key); assert.equal(applied.draft.version, 3); assert.equal(applied.draft.business.displayName, 'Revised Business'); assert.equal(applied.draft.mappings.operatingBank, '100'); assert.equal(h.sent.length, 1); assert.equal(h.writer().operationId, null);
});
test('closed unsent proposal retries return that decision and a new request can prepare a fresh claim', async t => {
  const h = scenario(); t.mock.method(Date, 'now', () => h.clock); const { prepareMasterPlan } = require('../src/modules/business-master-preparation-plan'), plan = prepareMasterPlan(h.source), first = await h.store.propose(plan, key);
  await h.store.retain(String(first.run._id), plan.planHash, true, masterProgressHash(h.run())); const replay = await h.store.propose(plan, key); assert.equal(replay.run.claim, 'closed'); assert.equal(h.data.MasterRuns.length, 1);
  const next = await h.store.propose(plan, '22223344-1111-4111-8111-111111111111'); assert.equal(next.run.claim, 'open'); assert.notEqual(String(next.run._id), String(first.run._id)); assert.equal(h.data.MasterRuns.length, 2);
});

test('retaining accepted IDs never permits an automatic second set for those unassigned roles', async t => {
  const h = await fixture(t); h.afterCreate = async () => h.store.stop(String(h.run()._id)); await h.execute(String(h.run()._id)); await h.store.retain(String(h.run()._id), h.run().planHash, true, masterProgressHash(h.run()));
  const { prepareMasterPlan } = require('../src/modules/business-master-preparation-plan'); await assert.rejects(h.store.propose(prepareMasterPlan(h.source), key), /Previously prepared IDs/); assert.equal(h.data.MasterRuns.length, 1); assert.equal(h.sent.length, 1);
});

test('a lost apply commit acknowledgement retries the original draft without a second version', async t => {
  const h = await fixture(t); h.afterCreate = async () => h.store.stop(String(h.run()._id)); await h.execute(String(h.run()._id)); const runId = String(h.run()._id), review = await h.review([0]);
  h.loseCommitReply = h.commits + 1; await assert.rejects(h.store.apply(runId, review, key), /acknowledgement lost/); assert.equal(h.data.Versions.length, 2); assert.ok(h.run().applied); const retry = await h.store.apply(runId, { reviewHash: review.reviewHash }, key); assert.equal(retry.reused, true); assert.equal(h.data.Versions.length, 2); assert.equal(h.sent.length, 1);
});

test('an old retry confirmation cannot approve a later refused attempt', async t => {
  const h = await fixture(t); h.onSDK = async () => ({ status: 400, json: { Fault: { type: 'ValidationFault', Error: [{ code: '6000' }] } } }); await h.execute(String(h.run()._id));
  const reviewed = masterProgressHash(h.run()); await h.store.retry(String(h.run()._id), 0, h.run().planHash, true, reviewed); await h.execute(String(h.run()._id), { resume: true, reviewHash: masterProgressHash(h.run()) }); assert.equal(h.run().records[0].attempts.length, 2); assert.equal(h.run().records[0].state, 'rejected');
  await h.store.retry(String(h.run()._id), 0, h.run().planHash, true, reviewed); assert.equal(h.run().records[0].state, 'rejected'); await h.execute(String(h.run()._id), { resume: true, reviewHash: masterProgressHash(h.run()) }); assert.equal(h.sent.length, 2);
});
test('original refusal audits must survive both owner decision and final transport admission', async t => {
  const h = await fixture(t); h.onSDK = async () => ({ status: 400, json: { Fault: { type: 'ValidationFault', Error: [{ code: '6000' }] } } }); await h.execute(String(h.run()._id));
  const resultId = h.data.Receipts[0].resultAuditId, saved = clone(h.data.Audits.find(row => String(row._id) === String(resultId))); h.data.Audits = h.data.Audits.filter(row => String(row._id) !== String(resultId));
  await assert.rejects(h.store.retry(String(h.run()._id), 0, h.run().planHash, true, masterProgressHash(h.run())), /transport audit/); h.data.Audits.push(saved);
  await h.store.retry(String(h.run()._id), 0, h.run().planHash, true, masterProgressHash(h.run())); h.data.Audits = h.data.Audits.filter(row => String(row._id) !== String(resultId)); await h.execute(String(h.run()._id), { resume: true, reviewHash: masterProgressHash(h.run()) }); assert.equal(h.sent.length, 1);
});
test('a contradictory accepted request barrier is never cleared by retaining records', async t => {
  const h = await fixture(t); h.changeRead = row => ({ ...row, Active: false }); await h.execute(String(h.run()._id)); h.writer().unresolved.requestHash = 'f'.repeat(64);
  await assert.rejects(h.store.retain(String(h.run()._id), h.run().planHash, true, masterProgressHash(h.run())), /exact accepted or terminal/); assert.equal(h.run().claim, 'open'); assert.ok(h.writer().unresolved);
});
test('new accepted progress invalidates an earlier apply or retain confirmation', async t => {
  const h = await fixture(t); h.afterCreate = async () => h.store.stop(String(h.run()._id)); await h.execute(String(h.run()._id)); const review = await h.review([0]), retained = masterProgressHash(h.run());
  await h.execute(String(h.run()._id), { resume: true, reviewHash: masterProgressHash(h.run()) }); assert.equal(h.sent.length, 2); await assert.rejects(h.store.apply(String(h.run()._id), review, key), /changed after review/); await assert.rejects(h.store.retain(String(h.run()._id), h.run().planHash, true, retained), /exact current/); assert.equal(h.run().claim, 'open');
});
test('confirmation rereads the real accepted ID and refuses remote changes after preview', async t => {
  const h = await fixture(t); h.afterCreate = async () => h.store.stop(String(h.run()._id)); await h.execute(String(h.run()._id)); const review = await h.review([0]), reads = h.exactReads.length;
  h.remote.Account.find(row => row.Id === '100').Active = false; await assert.rejects(h.store.apply(String(h.run()._id), review, key), /fields do not match/); assert.equal(h.exactReads.length, reads + 1); assert.equal(h.data.Versions.length, 1); assert.equal(h.run().claim, 'open');
});
test('prepared inventory cannot be applied before its starting date in a revised history', async t => {
  const h = await fixture(t); await h.execute(String(h.run()._id)); const revised = clone(h.data.Versions[0]); revised._id = '000000000000000000000089'; revised.version = 2; revised.definition.calendar.openingDate = '2022-10-01'; revised.contentHash = hash(revised.definition); h.data.Versions.push(revised); h.data.Sequences[0].value = 2;
  await assert.rejects(h.review(h.run().records.map(row => row.ordinal)), /inventory item starts after/); assert.equal(h.run().claim, 'open'); const accountOnly = await h.review([0]); assert.equal(accountOnly.entries[0].entity, 'Account');
});
test('more than 100 closed unsent proposals do not permanently block new preparation', async t => {
  const h = scenario(); t.mock.method(Date, 'now', () => h.clock); const { prepareMasterPlan } = require('../src/modules/business-master-preparation-plan'), plan = prepareMasterPlan(h.source); await h.store.propose(plan, key); await h.store.retain(String(h.run()._id), plan.planHash, true, masterProgressHash(h.run()));
  const old = clone(h.run()); for (let n = 1; n <= 101; n++) h.data.MasterRuns.push({ ...clone(old), _id: n.toString(16).padStart(24, '0') }); const next = await h.store.propose(plan, '33333333-1111-4111-8111-111111111111'); assert.equal(next.run.claim, 'open'); assert.equal(h.data.MasterRuns.length, 103);
});
