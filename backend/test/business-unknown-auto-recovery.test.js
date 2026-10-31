'use strict';
// Automatic resolution of an uncertain business create under the standing grant (no owner
// decision), on the simulated company: one coverage read after the send, then exactly
// one matching record is attributed, none proves it was not created (the step is sent
// again, once), and several stay held. An abandoned possibly-sent request gets the same
// terminal facts as a failed transport first.
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/business-governance-fixture');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const MINUTE = 60000;
async function uncertain({ created = true } = {}) {
  const h = fixture(); await h.publish();
  const plan = await h.service.prepare(h.user, { requestKey: 'auto-unknown-period-0001', throughDate: '2026-10-15' }); await h.service.approve(h.user, plan.operationId, { planHash: plan.planHash });
  const lost = () => Object.assign(Error('Fixture lost network response'), { code: 'ECONNRESET' });
  if (created) h.afterPost = async (_opts, record) => { h.afterPost = null; const found = [...h.records.values()].find(row => row.record === record); h.candidate = { entity: found.entity, id: record.Id }; throw lost(); };
  else h.beforePost = async () => { h.beforePost = null; throw lost(); };
  const result = await h.runtime(plan.operationId).execute(); assert.equal(result.complete, false);
  const step = h.data.Steps.find(row => row.dispatch && row.state === 'dispatched'); assert.ok(step);
  const receipt = h.data.Receipts.find(row => row.logicalKey === step.logicalKey && row.dispatchKey === step.dispatch.key); assert.equal(receipt.state, 'unknown');
  Object.assign(h, { plan, step, receipt, input: { planHash: plan.planHash } });
  return h;
}
const resolve = h => h.service.resolveUnknownAutomatically(h.user, h.plan.operationId, h.input);

test('exactly one matching record found after the send is attributed automatically; the operation completes without a replay', { timeout: 120000 }, async () => {
  const h = await uncertain(), posts = h.posts;
  assert.equal((await resolve(h)).state, 'waiting', 'too soon after the send');
  h.clock += 6 * MINUTE;
  const outcome = await resolve(h);
  assert.equal(outcome.state, 'attributed', JSON.stringify(outcome)); assert.equal(outcome.qboId, h.candidate.id);
  assert.equal(h.step.state, 'saved'); assert.equal(h.step.qboId, h.candidate.id); assert.equal(h.data.Writers[0].unresolved, null);
  const authority = h.data.Authorities.find(row => row.payload?.kind === 'owner-attributed-business-creation');
  assert.equal(authority.payload.automatic.source, 'automatic-standing-grant-evidence'); assert.deepEqual(authority.payload.automatic.unclaimed, [h.candidate.id]);
  assert.equal(h.posts, posts, 'no QuickBooks write during recovery');
  assert.equal((await h.runtime(h.plan.operationId).execute()).complete, true);
  assert.equal([...h.records.values()].filter(row => row.entity === h.candidate.entity && row.record.Id === h.candidate.id).length, 1);
});

test('no record after proven coverage: the request created nothing and the step is sent again exactly once', { timeout: 120000 }, async () => {
  const h = await uncertain({ created: false }), before = h.posts, entity = h.step.entity, marked = () => [...h.records.values()].filter(row => row.entity === entity && [row.record.PrivateNote, row.record.Description].some(text => String(text || '').includes(h.step.logicalKey))).length;
  assert.equal(marked(), 0, 'the lost request created nothing');
  h.clock += 6 * MINUTE;
  const outcome = await resolve(h);
  assert.equal(outcome.state, 'not-created', JSON.stringify(outcome));
  assert.equal(h.receipt.state, 'rejected'); assert.equal(h.receipt.reconciliation.outcome, 'not-created'); assert.equal(h.data.Writers[0].unresolved, null);
  assert.equal(h.data.Steps.find(row => row.logicalKey === h.step.logicalKey).state, 'claimed');
  assert.ok(h.data.Audits.some(row => row.action === 'Uncertain business creation proved not created'));
  assert.equal((await h.runtime(h.plan.operationId).execute()).complete, true);
  assert.ok(h.posts > before); assert.equal(marked(), 1, 'the record exists exactly once');
});

test('several matching records stay held and are reported plainly', { timeout: 120000 }, async () => {
  const h = await uncertain(), original = h.records.get(h.candidate.entity.toLowerCase() + ':' + h.candidate.id);
  h.records.set(h.candidate.entity.toLowerCase() + ':99999', { entity: original.entity, record: { ...structuredClone(original.record), Id: '99999' } });
  h.clock += 6 * MINUTE;
  const outcome = await resolve(h);
  assert.equal(outcome.state, 'ambiguous'); assert.match(outcome.message, /2 matching .* records/);
  assert.ok(h.data.Writers[0].unresolved); assert.equal(h.step.receipt, null);
});

test('an abandoned possibly-sent request gets terminal facts, then is attributed', { timeout: 120000 }, async () => {
  const h = await uncertain(), receipt = h.receipt;
  // As if the process died before the response was recorded.
  h.data.Audits = h.data.Audits.filter(row => row._id !== receipt.resultAuditId && row._id !== receipt.terminal?.auditId);
  Object.assign(receipt, { state: 'possibly-sent', observed: null, observedAt: undefined, resultAuditId: undefined, terminal: undefined });
  delete h.data.Writers[0].unresolved.responseReceiptId;
  h.clock += 6 * MINUTE;
  assert.equal((await resolve(h)).state, 'waiting', 'a possibly-sent request waits ten minutes');
  h.clock += 5 * MINUTE;
  const outcome = await resolve(h);
  assert.equal(outcome.state, 'attributed', JSON.stringify(outcome));
  assert.equal(receipt.state, 'unknown'); assert.equal(receipt.terminal.kind, 'sdk-failure');
  assert.equal((await h.runtime(h.plan.operationId).execute()).complete, true);
});
