'use strict';
process.env.QBO_ENVIRONMENT = 'production';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, clone, scope, ownerId } = require('./helpers/master-transport-fixture');
const { createMasterPreparationStore } = require('../src/modules/business-master-preparation-store');
const { createBusinessRuntimeAccess } = require('../src/modules/business-runtime-access');
const { prepareMasterPlan, compileMasterEntry } = require('../src/modules/business-master-preparation-plan');
const { prepareMasterDispatchEvidence } = require('../src/modules/business-master-dispatch-evidence');
const { verifiedParents } = require('../src/modules/business-master-preparation-transport');
const { freezeWriteRequest } = require('../src/modules/qbo-write-contract');
const { hash } = require('../src/modules/business-calendar');
const { scenario } = require('./helpers/master-preparation-scenario');
test('proposal refresh reuses the company claim without approving or claiming a writer', async () => {
  const h = scenario(), first = await h.propose(), second = await h.propose();
  assert.equal(first.existing, false); assert.equal(second.existing, true); assert.equal(h.data.MasterRuns.length, 1); assert.equal(h.run().state, 'proposed'); assert.equal(h.run().approval, null); assert.equal(h.writer().operationId, null); assert.equal(h.sent.length, 0);
});
test('approval is exact, current, owner-authorized and idempotent', async () => {
  const h = scenario(); await h.propose(); await assert.rejects(h.store.approve(String(h.run()._id), h.run().planHash, false, prepareMasterPlan(h.source)));
  h.busy = true; await assert.rejects(h.approve()); assert.equal(h.run().approval, null); h.busy = false;
  const approved = await h.approve(), again = await h.approve(); assert.equal(approved.approval.contentHash, again.approval.contentHash); assert.equal(h.run().state, 'approved'); assert.equal(h.writer().operationId, null);
  const claimed = await h.claim(); assert.equal(h.writer().operationId, claimed._id); assert.equal(h.writer().workflowKind, 'master-preparation'); await assert.rejects(h.claim());
});
test('every prepared role survives current owner authority, actual transport and independent GET readback before writer completion', async () => {
  const h = scenario(); await h.propose(); await h.approve(); await h.claim(); let nextId = 100; const remote = new Map(), reads = [];
  h.onGET = async opts => { const match = /\/(account|customer|vendor|employee|item)\/(\d+)$/.exec(new URL(opts.url).pathname); if (!match) return null; const entry = remote.get(match[1] + ':' + match[2]); reads.push(match[0]); return { status: 200, json: { [entry.entity]: clone(entry.record) } }; };
  h.onSDK = async opts => { const entity = h.compiled.entity; h.accepted = { ...JSON.parse(opts.body), Id: String(nextId++), SyncToken: '0' }; remote.set(entity.toLowerCase() + ':' + h.accepted.Id, { entity, record: clone(h.accepted) }); return { status: 200, json: { [entity]: h.accepted } }; };
  for (const entry of h.run().plan.entries) {
    await h.prepare(entry.ordinal); await h.send(); const response = await h.client.read(entry.entity.toLowerCase(), h.run().records[entry.ordinal].qboId), accepted = response[entry.entity], run = h.run();
    assert.equal(run.records[entry.ordinal].state, 'saved'); assert.ok(h.writer().unresolved); await assert.rejects(h.store.finish(String(run._id), run.leaseToken));
    await h.store.verify(String(run._id), entry.ordinal, run.leaseToken, accepted); assert.equal(h.run().records[entry.ordinal].state, 'verified'); assert.equal(h.writer().unresolved, null);
    if (entry.entity === 'Account') h.source.setup.options.accounts.push({ id: accepted.Id, name: accepted.Name, active: true, type: accepted.AccountType, subtype: accepted.AccountSubType, currency: 'CAD', syncToken: '0' });
  }
  const complete = await h.store.finish(String(h.run()._id), h.run().leaseToken); assert.equal(complete.state, 'complete'); assert.equal(complete.claim, 'open'); assert.equal(h.writer().operationId, null); assert.equal(h.sent.length, 32); assert.equal(reads.length, 32); assert.equal(h.run().records.filter(row => row.state === 'verified').length, 32);
  const again = await h.store.finish(String(h.run()._id), 'old-worker'); assert.equal(again.state, 'complete'); assert.equal(h.sent.length, 32);
});
test('stop works while automation is paused and an expired stop can settle without allowing another create', async () => {
  const h = scenario(); await h.propose(); await h.approve(); await h.claim(); await h.prepare(0);
  Object.assign(h.data.Users[0], { email: 'tester@testdatalab.local', authVersion: 1, accessPolicyVersion: 1, automationAccessPolicyVersion: 0 });
  const stopping = await h.store.stop(String(h.run()._id)); assert.equal(stopping.stopRequested, true); assert.equal(stopping.state, 'running'); await assert.rejects(h.send()); assert.equal(h.sent.length, 0);
  h.clock += 300001; const stopped = await h.store.stop(String(h.run()._id)); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.leaseToken, null); assert.equal(h.writer().operationId, stopped._id); assert.equal(h.run().records[0].attempts.length, 1);
});
test('known accepted ID remains recoverable when an outer caller loses acknowledgement', async () => {
  const h = scenario(); await h.propose(); await h.approve(); await h.claim(); await h.prepare(0); h.loseCommitReply = h.commits + 2;
  await assert.rejects(h.send()); assert.equal(h.run().records[0].qboId, '100'); const token = h.run().leaseToken; await h.store.releaseWorker(String(h.run()._id), token);
  assert.equal(h.run().leaseToken, null); assert.equal(h.run().state, 'blocked'); assert.equal(h.run().records[0].qboId, '100'); assert.ok(h.writer().unresolved); await assert.rejects(h.claim()); assert.equal(h.sent.length, 1);
});
test('verification refusal and audit failure retain the accepted ID and company barrier', async () => {
  for (const failAudit of [false, true]) {
    const h = scenario(); await h.propose(); await h.approve(); await h.claim(); await h.prepare(0); await h.send(); const run = h.run(), record = { ...h.compiled.payload, Id: '100', SyncToken: '0', ...(failAudit ? {} : { Active: false }) };
    if (failAudit) h.failAudit = true;
    await assert.rejects(h.store.verify(String(run._id), 0, run.leaseToken, record)); assert.equal(h.run().records[0].qboId, '100'); assert.equal(h.run().records[0].state, 'saved'); assert.ok(h.writer().unresolved);
  }
});
test('new draft and changed prerequisites cannot approve stale choices or reserve later records', async () => {
  const h = scenario(); await h.propose(); const current = prepareMasterPlan(h.source); const { planHash, ...content } = current; content.evidence.setupHash = hash('new setup'); const changed = { ...content, planHash: hash(content) };
  await assert.rejects(h.store.approve(String(h.run()._id), h.run().planHash, true, changed)); assert.equal(h.run().approval, null);
  await h.approve(); await h.claim(); h.data.Versions.push({ ...clone(h.data.Versions[0]), _id: '000000000000000000000099', version: 2 }); h.data.Sequences[0].value = 2;
  await assert.rejects(h.prepare(0)); assert.equal(h.run().records[0].attempts.length, 0); assert.equal(h.sent.length, 0);
});
test('private worker settlement after revocation retains all receipt and writer evidence', async () => {
  const h = scenario(); await h.propose(); await h.approve(); await h.claim(); await h.prepare(0); h.onSDK = async () => { throw Object.assign(new Error('fixture failed'), { code: '500' }); }; await assert.rejects(h.send());
  const token = h.run().leaseToken; h.data.Users[0].role = 'retired'; await h.store.releaseWorker(String(h.run()._id), token);
  assert.equal(h.run().state, 'blocked'); assert.equal(h.run().leaseToken, null); assert.equal(h.run().records[0].state, 'unknown'); assert.ok(h.writer().unresolved); assert.equal(h.data.Receipts[0].state, 'unknown'); assert.equal(h.sent.length, 1);
});

test('a first proposal or approval cannot present an old or future observation as current', async () => {
  const old = scenario(); old.clock += 300001; await assert.rejects(old.propose(), /Refresh/); assert.equal(old.data.MasterRuns.length, 0);
  const h = scenario(); await h.propose(); const plan = prepareMasterPlan(h.source); h.clock += 300001;
  await assert.rejects(h.store.approve(String(h.run()._id), h.run().planHash, true, plan), /Refresh/); assert.equal(h.run().approval, null);
  const { planHash, ...content } = plan; content.observedAt = new Date(h.clock + 1).toISOString();
  await assert.rejects(h.store.approve(String(h.run()._id), h.run().planHash, true, { ...content, planHash: hash(content) }), /Refresh/); assert.equal(h.sent.length, 0);
});

test('transactional proposal reuse cannot substitute full and supplier-only scopes',async()=>{
 const h=scenario({activityTemplateVersion:2}), full=prepareMasterPlan(h.source), supplier=prepareMasterPlan({...h.source,input:{...h.source.input,recordScope:'suppliers'}}), key='40000000-0000-0000-0000-000000000001';
 await h.store.propose(full,key);
 await assert.rejects(h.store.propose(supplier,key),/different business choices/);
 await assert.rejects(h.store.propose(supplier,'40000000-0000-0000-0000-000000000002'),/different records/);
 assert.equal(h.data.MasterRuns.length,1);assert.equal(h.sent.length,0);
});
