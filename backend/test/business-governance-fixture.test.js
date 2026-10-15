'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/business-governance-fixture');
test('large-fixture copy-on-write model transactions roll back nested updates, additions and removals', async () => {
  const h = fixture({copyOnWriteTransactions:true}), before = structuredClone(h.data);
  await assert.rejects(h.transaction(async session => {
    await h.models.Policies.updateOne({_id:h.data.Policies[0]._id},{$set:{'periodControl.closedThrough':'2026-09-30'}},{session});
    await h.models.Writers.findOneAndUpdate({_id:h.data.Writers[0]._id},{$inc:{revision:1}},{session}).lean();
    await h.models.Candidates.create([{_id:'f'.repeat(24),payload:{fixture:true}}],{session});
    await h.models.Memberships.deleteOne({_id:'owner-membership'},{session});
    throw Error('Fixture forced rollback');
  }),/forced rollback/);
  assert.deepEqual(h.data,before);
  h.loseReply = true;
  await assert.rejects(h.transaction(async session => h.models.Writers.findOneAndUpdate({_id:h.data.Writers[0]._id},{$inc:{revision:1}},{session}).lean()),/acknowledgement/);
  assert.equal(h.data.Writers[0].revision,1,'lost acknowledgement retains the committed document');
  assert.equal(before.Writers[0].revision,0,'original snapshot was not mutated');
});
