'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { generateNote } = require('../src/modules/ai-notes'), provider = require('../src/modules/ai-provider');
const { serviceFixture } = require('./helpers/case-assessment-fixture');
const { readAssessment } = require('../src/modules/reproduction-assessment');
async function publicCase(f) {
  const review = await readAssessment(f.session, f.plan, f.loadAudit);
  return { ...f.session, reproduction: { ...f.state, outcome: review.outcome, assessmentTrust: review.trust, assessmentReview: review } };
}
test('case notes use validated original evidence with no model call or invented cause', async t => {
  t.mock.method(provider, 'complete', async () => { throw Error('A case note must not call a provider'); });
  const f = await serviceFixture(), result = await f.api.reviewFinish({ deadline: f.clock + 30000 }); f.state.outcome = result.outcome;
  const session = await publicCase(f), note = await generateNote(session, 'internal');
  assert.equal(note.source, 'retained-case-evidence'); assert.equal(note.evidence.outcome, 'reproduced');
  assert.equal(note.evidence.caseId, 'case-1'); assert.equal(note.evidence.revision, f.state.revision); assert.equal(note.evidence.decisionRevision, 0);
  assert.equal(note.evidence.sourceHash, f.state.requestSources.contentHash); assert.equal(note.evidence.viewOutcome, session.reproduction.outcome);
  assert.match(note.content, /Reported symptom observed/); assert.match(note.content, /Root cause: Not established/); assert.equal(note.tokenUsage.inputTokens, 0);
  const customer = await generateNote(session, 'customer'); assert.ok(customer.content.split(/\s+/).length <= 200); assert.doesNotMatch(customer.content, /#100|plan-1|case-1/);
});
test('unavailable and legacy notes cannot repeat an unsupported assistant conclusion', async t => {
  t.mock.method(provider, 'complete', async () => { throw Error('No provider'); });
  const f = await serviceFixture(), result = await f.api.reviewFinish({ deadline: f.clock + 30000 }); f.state.outcome = result.outcome;
  f.session.messages = [{ role: 'assistant', content: 'Guaranteed reproduced and fixed. Invented root cause.' }];
  f.audits.delete(f.state.assessment.auditId);
  const note = await generateNote(await publicCase(f), 'internal'); assert.match(note.content, /Result unverified/); assert.doesNotMatch(note.content, /Guaranteed|Invented root cause/);
  const legacy = { ...f.session, reproduction: { ...f.state, assessmentTrust: 'executor-assessed', assessmentReview: null } };
  const historical = await generateNote(legacy, 'internal'); assert.match(historical.content, /Legacy assistant result/); assert.match(historical.content, /No independent request assessment/);
  assert.equal(historical.evidence.outcome, 'unverified');
});
test('ordinary non-case notes retain their existing provider format and personal-key contract', async t => {
  let supplied; t.mock.method(provider, 'complete', async options => { supplied = options; return { text: 'Synthetic investigation note', usage: { inputTokens: 1, outputTokens: 2 } }; });
  const note = await generateNote({ messages: [{ role: 'user', content: 'Synthetic investigation' }] }, 'internal', { userApiKey: 'isolated-key' });
  assert.equal(note.content, 'Synthetic investigation note'); assert.equal(supplied.userApiKey, 'isolated-key'); assert.match(supplied.prompt, /Synthetic investigation/);
});
