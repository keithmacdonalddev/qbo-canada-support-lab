'use strict';
process.env.QBO_ENVIRONMENT = 'production';
const test = require('node:test'), assert = require('node:assert/strict');
const { scenario } = require('./helpers/master-preparation-scenario');
const { remoteMasters } = require('./helpers/master-preparation-remote');
const { scope, ownerId, clone } = require('./helpers/master-transport-fixture');
const { createMasterPreparationRunner } = require('../src/modules/business-master-preparation-runner');
const { assertMasterAttribution, SOURCE } = require('../src/modules/business-master-attribution');
const { masterProgressHash } = require('../src/modules/business-master-receipt');
async function fixture(t, entity = 'Account') {
  const h = scenario(); t.mock.method(Date, 'now', () => h.clock); remoteMasters(h); await h.propose(); await h.approve();
  h.execute = createMasterPreparationRunner({ scope, ownerId, store: h.store, authorize: h.access.authorize, clientFor: async () => h.client, readPolicy: async () => clone(h.data.Policies[0]), now: () => h.clock });
  h.afterCreate = async (record, kind) => { if (kind === entity || (entity === 'last' && h.sent.length === h.run().records.length)) { h.candidate = record.Id; h.remote[kind].find(value => value.Id === record.Id).MetaData = { CreateTime: new Date(h.clock).toISOString() }; throw Object.assign(new Error('fixture SDK lost the response'), { code: '500' }); } };
  await h.execute(String(h.run()._id)); h.ordinal = h.run().records.find(row => row.state === 'unknown').ordinal; h.runId = String(h.run()._id);
  h.review = () => h.store.attributionReview(h.runId, h.ordinal, h.candidate);
  h.input = review => ({ qboId: h.candidate, reviewHash: review.reviewHash, confirmOwnership: true, reason: 'Owner identified this exact fixture ID in independent remote evidence.' });
  return h;
}
for (const entity of ['Account', 'Customer', 'Vendor', 'Employee', 'Item']) test(entity + ' terminal uncertainty needs exact-ID owner attribution and preserves its unknown transport result', async t => {
  const h = await fixture(t, entity), sent = h.sent.length, review = await h.review(); assert.equal(review.provenance, SOURCE); assert.equal(review.qboWrites, 0);
  const confirmed = await h.store.attribute(h.runId, h.ordinal, h.input(review)), row = confirmed.records[h.ordinal]; assert.equal(row.state, 'verified'); assert.equal(row.qboId, h.candidate); assert.equal(row.attempts.at(-1).outcome.outcome, 'unknown'); assert.equal(h.data.Receipts.at(-1).state, 'unknown'); assert.equal(h.writer().unresolved, null); assert.equal(h.sent.length, sent); assert.equal(confirmed.stopRequested, true);
  const evidence = await assertMasterAttribution(h.models, scope, confirmed, row); assert.equal(evidence.source, SOURCE); assert.equal(evidence.reviewHash, review.reviewHash); const reads = h.exactReads.length; await h.store.attribute(h.runId, h.ordinal, h.input(review)); assert.equal(h.exactReads.length, reads);
  h.afterCreate = null; const result = await h.execute(h.runId, { resume: true }); assert.equal(result.complete, true); assert.equal(h.sent.length, 32); assert.equal(h.writer().operationId, null); assert.equal(result.acceptedRecords, 31); assert.equal(result.ownerAttributedRecords, 1); assert.equal(result.identifiedRecords, 32); const audit = h.data.Audits.find(row => row.action === 'Business master creation completed'); assert.equal(audit.afterState.confirmedCreates, 31); assert.equal(audit.afterState.ownerAttributedRecords, 1);
});
test('owner attribution and retained closure remain possible while account automation is paused', async t => {
  const h = await fixture(t); Object.assign(h.data.Users[0], { email: 'tester@testdatalab.local', authVersion: 1, accessPolicyVersion: 1, automationAccessPolicyVersion: 0 }); const review = await h.review(); await h.store.attribute(h.runId, h.ordinal, h.input(review));
  await h.store.retain(h.runId, h.run().planHash, true, masterProgressHash(h.run())); assert.equal(h.run().claim, 'closed'); assert.equal(h.run().records[0].qboId, h.candidate); assert.equal(h.data.Receipts[0].state, 'unknown'); assert.equal(h.writer().operationId, null); assert.equal(h.sent.length, 1);
});
for (const mode of ['preexisting', 'other-master', 'other-operation', 'other-receipt', 'legacy', 'unfinished', 'terminal-audit']) test('attribution refuses ' + mode + ' ownership or incomplete evidence', async t => {
  const h = await fixture(t);
  if (mode === 'preexisting') h.candidate = '1';
  if (mode === 'other-master') h.data.MasterRuns.push({ _id: '000000000000000000000099', environment: scope.environment, realmId: scope.realmId, ownerId: 'other', records: [{ entity: 'Account', key: 'other-role', qboId: h.candidate }] });
  if (mode === 'other-operation') h.data.Steps.push({ ...scope, entity: 'Account', qboId: h.candidate });
  if (mode === 'other-receipt') h.data.Receipts.push({ _id: 'other', environment: scope.environment, realmId: scope.realmId, entity: 'account', observed: { qboId: h.candidate }, ownerId: 'other' });
  if (mode === 'legacy') h.legacyOwner = true;
  if (mode === 'unfinished') { h.run().records[0].state = h.run().records[0].attempts[0].state = 'possibly-sent'; h.data.Receipts[0].state = 'possibly-sent'; h.data.Receipts[0].observed = null; h.data.Receipts[0].terminal = null; }
  if (mode === 'terminal-audit') { const id = h.data.Receipts[0].terminal.auditId; h.data.Audits = h.data.Audits.filter(row => String(row._id) !== String(id)); }
  await assert.rejects(h.review()); assert.ok(h.writer().unresolved); assert.equal(h.run().claim, 'open'); assert.equal(h.sent.length, 1);
});
test('confirmation rereads the exact remote record and cannot accept changed fields', async t => {
  const h = await fixture(t), review = await h.review(); h.remote.Account.find(row => row.Id === h.candidate).Active = false; await assert.rejects(h.store.attribute(h.runId, h.ordinal, h.input(review))); assert.equal(h.run().records[0].state, 'unknown'); assert.ok(h.writer().unresolved); assert.equal(h.data.Receipts[0].ownerRecovery ?? null, null);
});
test('attribution atomically rolls back audit failure and recovers a lost committed acknowledgement', async t => {
  const h = await fixture(t), review = await h.review(); h.failAudit = true; await assert.rejects(h.store.attribute(h.runId, h.ordinal, h.input(review))); assert.equal(h.run().records[0].state, 'unknown'); assert.ok(h.writer().unresolved); h.failAudit = false;
  h.loseCommitReply = h.commits + 1; await assert.rejects(h.store.attribute(h.runId, h.ordinal, h.input(review)), /acknowledgement lost/); assert.equal(h.run().records[0].state, 'verified'); assert.equal(h.writer().unresolved, null); assert.equal((await h.store.attribute(h.runId, h.ordinal, h.input(review))).records[0].state, 'verified'); assert.equal(h.sent.length, 1);
});
test('a later create cannot use an attributed parent with missing owner evidence', async t => {
  const h = await fixture(t), review = await h.review(); await h.store.attribute(h.runId, h.ordinal, h.input(review)); const id = h.run().records[0].attempts[0].ownerAttribution.auditId; h.data.Audits = h.data.Audits.filter(row => String(row._id) !== String(id)); h.afterCreate = null;
  await h.execute(h.runId, { resume: true }); assert.equal(h.sent.length, 1); assert.equal(h.run().claim, 'open');
});

test('deleting only the attribution marker blocks later admission, retaining and completed-row release', async t => {
  const h = await fixture(t), review = await h.review(); await h.store.attribute(h.runId, h.ordinal, h.input(review)); h.run().records[0].attempts[0].ownerAttribution = null; h.afterCreate = null;
  const result = await h.execute(h.runId, { resume: true }); assert.equal(h.sent.length, 1); assert.equal(result.acceptedRecords, 0); await assert.rejects(h.store.retain(h.runId, h.run().planHash, true, masterProgressHash(h.run()))); assert.equal(h.run().claim, 'open'); assert.equal(h.writer().operationId, h.runId);
});
for (const mode of ['missing-marker', 'missing-outcome', 'changed-outcome']) test('completion refuses ' + mode + ' for the final attributed record', async t => {
  const h = await fixture(t, 'last'), review = await h.review(); await h.store.attribute(h.runId, h.ordinal, h.input(review)); const attempt = h.run().records[h.ordinal].attempts.at(-1);
  if (mode === 'missing-marker') attempt.ownerAttribution = null; if (mode === 'missing-outcome') attempt.outcome = null; if (mode === 'changed-outcome') attempt.outcome = { outcome: 'saved' };
  const result = await h.execute.recover(h.runId); assert.equal(result.complete, false); assert.equal(h.writer().operationId, h.runId); assert.equal(h.sent.length, 32); assert.equal(h.data.Audits.some(row => row.action === 'Business master creation completed'), false); await assert.rejects(h.store.retain(h.runId, h.run().planHash, true, masterProgressHash(h.run())));
});
test('partial worker cleanup distinguishes confirmed responses from owner-attributed identities', async t => {
  const h = await fixture(t), review = await h.review(); await h.store.attribute(h.runId, h.ordinal, h.input(review)); h.afterCreate = async () => h.store.stop(h.runId); const result = await h.execute(h.runId, { resume: true });
  assert.equal(result.acceptedRecords, 1); assert.equal(result.ownerAttributedRecords, 1); assert.equal(result.identifiedRecords, 2); const audit = h.data.Audits.filter(row => row.action === 'Business master worker settled').at(-1); assert.equal(audit.afterState.acceptedRecords, 1); assert.equal(audit.afterState.ownerAttributedRecords, 1); assert.equal(audit.afterState.identifiedRecords, 2);
});
test('attribution rejects noncanonical run IDs before reading a candidate or clearing its barrier', async t => {
  const h = await fixture(t), review = await h.review(), reads = h.exactReads.length; await assert.rejects(h.store.attribute('ABCDEF1234567890ABCDEF12', h.ordinal, h.input(review)), /exact reviewed|canonical/); assert.equal(h.exactReads.length, reads); assert.ok(h.writer().unresolved);
});
test('all verified master receipt and attribution proofs use two bounded database snapshots', async t => {
  const h = await fixture(t, 'last'), review = await h.review(); await h.store.attribute(h.runId, h.ordinal, h.input(review)); const { assertMasterRecordSet } = require('../src/modules/business-master-record-evidence');
  let queries = 0; for (const name of ['Receipts', 'Audits']) { const original = h.models[name].find; t.mock.method(h.models[name], 'find', function (...args) { queries++; return original.apply(this, args); }); }
  await assertMasterRecordSet(h.models, scope, h.run(), h.run().records); assert.equal(queries, 2); assert.equal(h.sent.length, 32);
});
