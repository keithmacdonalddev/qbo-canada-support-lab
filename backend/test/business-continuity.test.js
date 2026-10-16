'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const zlib = require('node:zlib'), originalGunzip = zlib.gunzipSync; let gunzips = 0;
zlib.gunzipSync = (...args) => { gunzips++; return originalGunzip(...args); };
const { fixture, scope, ownerId, actorId } = require('./helpers/business-governance-fixture');
zlib.gunzipSync = originalGunzip;
const { hash } = require('../src/modules/business-calendar');
const { assertPublishedBusiness } = require('../src/modules/business-authority');
const { readAuthorityLineage } = require('../src/modules/business-authority-lineage');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const reason = 'Owner reviewed this future business scale and retained every earlier obligation and record choice.';
async function period(h, throughDate, key) { const p = await h.service.prepare(h.user, { requestKey: key, throughDate }); await h.service.approve(h.user, p.operationId, { planHash: p.planHash }); const result = await h.runtime(p.operationId).execute(); assert.equal(result.complete, true, JSON.stringify({ result, run: h.data.Runs.find(row => row._id === p.operationId) })); return p; }
async function ready() { const h = fixture({ activityTemplateVersion: 2, continuity: true, copyOnWriteTransactions: true, originalSdkTransport: true }); await h.publish(); await period(h, '2026-10-06', 'continuity-initial-period-001'); return h; }
async function selection(h, changes = { displayName: 'Harbour and Pine revised' }, effectiveFrom = '2026-10-07') { const d = h.saveRevision(changes); return { blueprintId: d._id, blueprintHash: d.contentHash, effectiveFrom }; }
async function decision(h, input) { const reviewed = await h.service.reviewContinuity(h.user, input); return { ...input, reviewHash: reviewed.reviewHash, reason }; }
function amend(h, input, change) { const d = h.data.Versions.find(row => row._id === input.blueprintId); change(d.definition); d.contentHash = hash(d.definition); h.data.Audits.find(row => row._id === d.auditId).afterState.contentHash = d.contentHash; return { ...input, blueprintHash: d.contentHash }; }
test('growth and reduction preserve old collections, exact master bindings, original proofs and a continuous calendar', { timeout: 300000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, continuity: true, copyOnWriteTransactions: true, originalSdkTransport: true }); await h.publish();
  const first = await period(h, '2026-10-15', 'continuity-growth-period-001');
  const originalPlan = JSON.stringify(h.data.Plans.find(row => row.operationId === first.operationId)), originalProof = JSON.stringify(h.data.Evidence.find(row => row.operationId === first.operationId)), baseline = JSON.stringify(h.data.Baselines[0]);
  const originalCalendar = structuredClone(h.data.Calendars[0]), before = h.posts;
  const up = await selection(h, { volumeProfile: 'flagship' }, '2026-10-16'), upBody = await decision(h, up), changed = await h.service.applyContinuity(h.user, upBody);
  assert.equal(changed.applied, true); assert.equal(h.posts, before); assert.equal(h.data.Calendars[0].verifiedThrough, '2026-10-15'); assert.equal(h.data.Calendars[0].revision, originalCalendar.revision + 1); assert.deepEqual(h.data.Calendars[0].baseline, originalCalendar.baseline); assert.equal(h.data.Calendars[0].lastVerifiedOperationId, first.operationId);
  const second = await period(h, '2026-10-31', 'continuity-growth-period-002'), secondPlan = h.data.Plans.find(row => row.operationId === second.operationId).manifest;
  assert.equal(secondPlan.continuity.segments.length, 2); assert.ok(secondPlan.continuity.origins.some(row => row.blueprintHash === up.blueprintHash && row.occurrence >= '2026-10-16')); assert.ok(secondPlan.continuity.origins.some(row => row.occurrence < '2026-10-16'));
  assert.ok(secondPlan.continuity.origins.filter(row => row.blueprintHash === up.blueprintHash).every(row => row.occurrence >= '2026-10-16'));
  const grownBindings = structuredClone(h.data.Versions.at(-1).definition.masterBindings), grownPlan = JSON.stringify(h.data.Plans.find(row => row.operationId === second.operationId)), grownProof = JSON.stringify(h.data.Evidence.find(row => row.operationId === second.operationId));
  const down = await selection(h, { volumeProfile: 'development', displayName: 'Harbour and Pine steady business' }, '2026-11-01'), downBody = await decision(h, down); await h.service.applyContinuity(h.user, downBody);
  for (const [key, id] of Object.entries(grownBindings)) assert.equal(h.data.Versions.at(-1).definition.masterBindings[key], id, key);
  let checkedAdmissions = 0; h.beforePost = async () => { const count = gunzips, running = h.data.Runs.find(row => row.status === 'running'); assert.ok(running); await assertPublishedBusiness({ ...h.models, scope, manifest: running }); assert.equal(gunzips, count, 'Original SDK admission performs no root report decompression'); checkedAdmissions++; };
  const fullBefore = gunzips; await readAuthorityLineage({ ...h.models, scope, head: h.data.Authorities.at(-1), verifyBaseline: true }); assert.ok(gunzips > fullBefore, 'Full review still verifies original compressed reports');
  const third = await period(h, '2026-11-20', 'continuity-growth-period-003'), thirdPlan = h.data.Plans.find(row => row.operationId === third.operationId).manifest;
  for (const stepKey of ['final-payment', 'final-deposit']) assert.ok(thirdPlan.continuity.origins.some(row => row.ruleKey === 'field-job-001' && row.occurrence === '2026-10-01' && row.stepKey === stepKey && row.blueprintHash === h.data.Versions[0].contentHash), 'Old day45/day46 ' + stepKey + ' retained');
  h.beforePost = null; assert.ok(checkedAdmissions > 0);
  const carried = thirdPlan.continuity.origins.find(row => row.ruleKey === 'field-job-010' && row.stepKey === 'payment' && row.occurrence === '2026-10-18'); assert.ok(carried, 'Higher-cohort October collection survives November reduction'); assert.equal(carried.blueprintHash, up.blueprintHash);
  const intent = h.data.Intents.find(row => row.planHash === third.planHash && row.logicalKey === carried.logicalKey); assert.ok(intent, 'Original immutable intent retained for this plan'); assert.equal(intent.step.references.find(ref => ref.key === 'field-client-005').id, grownBindings['field-client-005']);
  assert.ok(thirdPlan.continuity.origins.filter(row => row.blueprintHash === down.blueprintHash).every(row => row.occurrence >= '2026-11-01'));
  assert.equal(JSON.stringify(h.data.Plans.find(row => row.operationId === first.operationId)), originalPlan); assert.equal(JSON.stringify(h.data.Evidence.find(row => row.operationId === first.operationId)), originalProof); assert.equal(JSON.stringify(h.data.Plans.find(row => row.operationId === second.operationId)), grownPlan); assert.equal(JSON.stringify(h.data.Evidence.find(row => row.operationId === second.operationId)), grownProof); assert.equal(JSON.stringify(h.data.Baselines[0]), baseline);
  const currentHead = h.data.Calendars[0].authorityHash, cursor = h.data.Calendars[0].verifiedThrough; assert.equal((await h.service.applyContinuity(h.user, upBody)).current, false); assert.equal(h.data.Calendars[0].authorityHash, currentHead); assert.equal(h.data.Calendars[0].verifiedThrough, cursor);
  const reviewedSecond = await h.service.reviewOperation(h.user, second.operationId); assert.deepEqual(reviewedSecond.businessTerms, [{ effectiveFrom: '2026-10-01' }, { effectiveFrom: '2026-10-16' }], 'Historical review retains its two original business windows after the third revision');
  for (const entry of reviewedSecond.entries) { const origin = secondPlan.continuity.origins.find(row => row.logicalKey === entry.logicalKey); if (origin) assert.deepEqual(entry.businessOrigin, { occurrence: origin.occurrence, effectiveFrom: secondPlan.continuity.segments.find(row => row.authorityHash === origin.authorityHash).effectiveFrom }); else assert.equal(entry.businessOrigin, undefined); }
  assert.equal((await h.runtime(first.operationId).inspect()).financialMovements.complete, true); assert.equal((await h.runtime(second.operationId).inspect()).financialMovements.complete, true);
  assert.equal(new Set(h.data.Receipts.filter(row => row.kind === 'business').map(row => row.observed.qboId)).size, h.posts); assert.equal(h.data.Writers[0].operationId, null); assert.equal(h.data.Writers[0].unresolved, null);
});
test('lost acknowledgement returns the exact original revision and audit failure rolls back all new authority state', { timeout: 120000 }, async () => {
  const h = await ready(), input = await selection(h), body = await decision(h, input), before = h.posts; h.loseReply = true;
  const recovered = await h.service.applyContinuity(h.user, body); assert.equal(recovered.applied, true); assert.equal(recovered.reused, true); const head = h.data.Calendars[0].authorityHash;
  const replay = await h.service.applyContinuity(h.user, body); assert.equal(replay.reused, true); assert.equal(replay.authorityHash, head); assert.equal(h.data.Authorities.length, 2); assert.equal(h.posts, before);
  const next = await selection(h, { displayName: 'Harbour and Pine third version' }, '2026-10-08'), nextBody = await decision(h, next), calendar = JSON.stringify(h.data.Calendars), policy = JSON.stringify(h.data.Policies), writer = JSON.stringify(h.data.Writers); h.failCreate = 'Audits';
  await assert.rejects(h.service.applyContinuity(h.user, nextBody), /storage unavailable/); assert.equal(h.data.Authorities.length, 2); assert.equal(JSON.stringify(h.data.Calendars), calendar); assert.equal(JSON.stringify(h.data.Policies), policy); assert.equal(JSON.stringify(h.data.Writers), writer);
});
test('new revision denies changed historical identity, mappings, dormant bindings, invalid dates and non-owner authority', { timeout: 120000 }, async () => {
  for (const mode of ['opening', 'fiscal', 'template', 'account', 'tax', 'binding', 'date', 'operator', 'draft-audit']) {
    const h = await ready(); let input = await selection(h);
    if (mode === 'opening') input = amend(h, input, d => { d.calendar.openingDate = '2026-09-01'; });
    if (mode === 'fiscal') input = amend(h, input, d => { d.calendar.fiscalYearStartMonth = 4; });
    if (mode === 'template') input = amend(h, input, d => { delete d.activityTemplateVersion; });
    if (mode === 'account') input = amend(h, input, d => { d.mappings.operatingBank = '999'; });
    if (mode === 'tax') input = amend(h, input, d => { d.mappings.salesTax = '999'; });
    if (mode === 'binding') input = amend(h, input, d => { delete d.masterBindings['field-client-001']; });
    if (mode === 'date') input.effectiveFrom = '2026-10-06';
    if (mode === 'draft-audit') h.data.Audits = h.data.Audits.filter(row => row._id !== h.data.Versions.at(-1).auditId);
    const count = h.posts; await assert.rejects(h.service.reviewContinuity(mode === 'operator' ? { id: ownerId, actorId } : h.user, input), undefined, mode); assert.equal(h.posts, count); assert.equal(h.data.Authorities.length, 1);
  }
});
test('unfinished plans, claims, uncertain receipts, legacy workers, protected dates and changed revisions block the owner decision', { timeout: 120000 }, async () => {
  for (const mode of ['previewed', 'approved', 'claim', 'receipt', 'legacy', 'protected', 'revision', 'completion', 'rehashed-source']) {
    const h = await ready(), input = await selection(h), body = await decision(h, input), oldHead = h.data.Calendars[0].authorityHash;
    if (['previewed', 'approved'].includes(mode)) h.data.Runs.push({ _id: 'e'.repeat(24), ...scope, status: mode });
    if (mode === 'claim') h.data.Steps.push({ _id: 'e'.repeat(24), ...scope, state: 'claimed' });
    if (mode === 'receipt') h.data.Receipts.push({ _id: 'e'.repeat(24), ...scope, state: 'possibly-sent' });
    if (mode === 'legacy') h.legacy.generationruns.push({ _id: 'e'.repeat(24), realmId: scope.realmId, status: 'in_progress' });
    if (mode === 'protected') { const { contentHash, ...control } = h.data.Policies[0].periodControl; control.closedThrough = '2026-10-07'; h.data.Policies[0].periodControl = { ...control, contentHash: hash(control) }; }
    if (mode === 'revision') h.data.Calendars[0].revision++;
    if (mode === 'completion') h.data.Evidence[0].proof.complete = false;
    if (mode === 'rehashed-source') { const row = h.data.Evidence[0], { sourceHash, ...source } = row.sources; source.accounts[0].Name = 'Changed retained account'; row.sources = { ...source, sourceHash: hash(source) }; }
    const before = h.posts; await assert.rejects(h.service.applyContinuity(h.user, body), undefined, mode); assert.equal(h.posts, before); assert.equal(h.data.Calendars[0].authorityHash, oldHead); assert.equal(h.data.Authorities.length, 1);
  }
});
test('complete lineage and exact current-head execution reject altered parents, original audits and a stale ancestor plan', { timeout: 120000 }, async () => {
  const h = await ready(), oldRun = structuredClone(h.data.Runs[0]), input = await selection(h), body = await decision(h, input); await h.service.applyContinuity(h.user, body);
  await assert.rejects(assertPublishedBusiness({ ...h.models, scope, manifest: oldRun }), /differs/);
  const active = await assertPublishedBusiness({ ...h.models, scope }); assert.equal(active.lineage.entries.length, 2);
  const root = h.data.Authorities[0], audit = h.data.Audits.find(row => row._id === root.auditId), saved = structuredClone(audit); audit.afterState.baselineHash = 'f'.repeat(64);
  await assert.rejects(readAuthorityLineage({ ...h.models, scope, head: h.data.Authorities[1] }), /audit/); Object.assign(audit, saved);
  const baseline = h.data.Baselines[0]; baseline.payload.accepted = true; await assert.rejects(assertPublishedBusiness({ ...h.models, scope }), error => error.code === 'BUSINESS_CONTINUITY_UNVERIFIED'); baseline.payload.accepted = false;
  h.data.Authorities.shift(); await assert.rejects(assertPublishedBusiness({ ...h.models, scope }), /chain/);
});

function companyObservationBarrier(h) {
  let arrived = 0, release; const both = new Promise(resolve => { release = resolve; });
  h.onGet = async opts => { const query = new URL(opts.url).searchParams.get('query') || ''; if (!query.includes('CompanyInfo') || arrived >= 2) return; arrived++; if (arrived === 2) release(); await both; };
  return () => { h.onGet = null; assert.equal(arrived, 2, 'Both concurrent preflights reached the original SDK'); };
}
test('simultaneous revision and preparation serialize before either authority or an unsent plan can become stale permission', { timeout: 120000 }, async () => {
  const h = await ready(), body = await decision(h, await selection(h)), before = h.posts, release = companyObservationBarrier(h);
  const outcomes = await Promise.allSettled([h.service.applyContinuity(h.user, body), h.service.prepare(h.user, { requestKey: 'continuity-concurrent-prepare-001', throughDate: '2026-10-07' })]); release();
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1, JSON.stringify(outcomes)); assert.equal(h.posts, before); assert.equal(h.data.Calendars[0].verifiedThrough, '2026-10-06');
  if (outcomes[0].status === 'fulfilled') { assert.equal(h.data.Authorities.length, 2); assert.equal(h.data.Runs.filter(row => row.status !== 'verified').length, 0); }
  else { assert.equal(h.data.Authorities.length, 1); assert.ok(h.data.Runs.some(row => row.status === 'previewed')); }
});
test('two simultaneous reviewed revisions cannot fork the current business head', { timeout: 120000 }, async () => {
  const h = await ready(), first = await decision(h, await selection(h, { displayName: 'First concurrent revision' })), second = await decision(h, await selection(h, { displayName: 'Second concurrent revision' })), before = h.posts, release = companyObservationBarrier(h);
  const outcomes = await Promise.allSettled([h.service.applyContinuity(h.user, first), h.service.applyContinuity(h.user, second)]); release();
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1, JSON.stringify(outcomes)); assert.equal(h.data.Authorities.length, 2); assert.equal(h.posts, before); assert.equal(h.data.Calendars[0].verifiedThrough, '2026-10-06');
});
test('concurrent original operation claim keeps its old authority while a later revision is refused', { timeout: 120000 }, async () => {
  const h = await ready(), body = await decision(h, await selection(h)), oldHead = h.data.Calendars[0].authorityHash;
  const prepared = await h.service.prepare(h.user, { requestKey: 'continuity-concurrent-claim-001', throughDate: '2026-10-07' }); await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  const outcomes = await Promise.allSettled([h.service.applyContinuity(h.user, body), h.runtime(prepared.operationId).execute()]);
  assert.equal(outcomes[0].status, 'rejected'); assert.equal(outcomes[1].status, 'fulfilled'); assert.equal(outcomes[1].value.complete, true); assert.equal(h.data.Authorities.length, 1); assert.equal(h.data.Calendars[0].authorityHash, oldHead); assert.equal(h.data.Calendars[0].verifiedThrough, '2026-10-07');
});

const withdrawal = request => ({ request, reason: 'Owner withdrew this unconfirmed request after inspecting the saved business state.' });
test('withdrawal survives stale review, active work and lost acknowledgement and cannot become a business authority', { timeout: 120000 }, async () => {
  const h = await ready(), body = await decision(h, await selection(h)), head = h.data.Calendars[0].authorityHash, before = h.posts;
  h.data.Runs.push({ _id: 'e'.repeat(24), ...scope, status: 'approved' }); h.data.Writers[0].operationId = 'e'.repeat(24); h.data.Writers[0].planHash = 'f'.repeat(64); h.data.Policies[0].revision++;
  h.loseReply = true; await assert.rejects(h.service.withdrawContinuity(h.user, withdrawal(body)), /acknowledgement/);
  const terminal = await h.service.applyContinuity(h.user, body); assert.equal(terminal.withdrawn, true); assert.equal(terminal.applied, false); assert.equal((await h.service.withdrawContinuity(h.user, withdrawal(body))).reused, true); assert.equal(h.posts, before); assert.equal(h.data.Calendars[0].authorityHash, head); assert.equal(h.data.Calendars[0].verifiedThrough, '2026-10-06');
  const marker = h.data.Authorities.find(row => row.payload.kind === 'continuity-withdrawal'); assert.ok(marker); assert.throws(() => require('../src/modules/business-authority').assertAuthorityDocument(marker, scope));
  await assert.rejects(h.service.withdrawContinuity({ id: ownerId, actorId }, withdrawal(body)), error => error.status === 403);
  await assert.rejects(h.service.withdrawContinuity(h.user, { ...withdrawal(body), realmId: '999' }));
});
test('withdrawal after application returns the validated original applied decision without undo or marker', { timeout: 120000 }, async () => {
  const h = await ready(), body = await decision(h, await selection(h)), applied = await h.service.applyContinuity(h.user, body), before = JSON.stringify(h.data.Calendars);
  const terminal = await h.service.withdrawContinuity(h.user, withdrawal(body)); assert.equal(terminal.applied, true); assert.equal(terminal.authorityHash, applied.authorityHash); assert.equal(h.data.Authorities.length, 2); assert.equal(JSON.stringify(h.data.Calendars), before); assert.ok(h.data.Authorities.every(row => !row.payload.kind));
});
test('withdrawal during original observations wins before any reviewed head change can commit', { timeout: 120000 }, async () => {
  const h = await ready(), body = await decision(h, await selection(h)), oldHead = h.data.Calendars[0].authorityHash;
  let entered, release; const arrived = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  h.onGet = async () => { h.onGet = null; entered(); await held; };
  const applying = h.service.applyContinuity(h.user, body); await arrived;
  const withdrawn = await h.service.withdrawContinuity(h.user, withdrawal(body)); release();
  const result = await applying; assert.equal(withdrawn.withdrawn, true); assert.equal(result.withdrawn, true); assert.equal(result.applied, false); assert.equal(h.data.Calendars[0].authorityHash, oldHead); assert.equal(h.data.Authorities.filter(row => row.payload.status === 'published').length, 1);
});

test('interrupted version-two period completion stays visible and recovers without new accounting writes', { timeout: 120000 }, async () => {
  const h = await ready(); await h.service.applyContinuity(h.user, await decision(h, await selection(h)));
  const prepared = await h.service.prepare(h.user, { requestKey: 'continuity-pending-commit-001', throughDate: '2026-10-07' }); await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  h.onRead = async (name, filter) => { if (name === 'Runs' && filter.status?.$in?.join(',') === 'committing,verified') throw Error('Fixture interrupted final receipt persistence'); };
  await assert.rejects(h.runtime(prepared.operationId).execute(), /Fixture interrupted final receipt persistence/);
  const before = h.posts, cursor = h.data.Calendars[0].verifiedThrough, revision = h.data.Calendars[0].revision; assert.ok(h.data.Calendars[0].pendingCommit);
  const status = await h.service.status(h.user); assert.equal(status.calendar.completionPending, true); assert.equal(status.currentOperation.operationId, prepared.operationId); assert.equal(status.currentOperation.status, 'committing'); assert.equal(h.posts, before); assert.ok(h.data.Calendars[0].pendingCommit, 'Read-only status never repairs the commit');
  await assert.rejects(assertPublishedBusiness({ ...h.models, scope }), error => error.code === 'BUSINESS_AUTHORITY_CHANGED');
  h.onRead = null; const recovered = await h.runtime(prepared.operationId).settleStop(); assert.equal(recovered.complete, true); assert.equal(h.posts, before); assert.equal(h.data.Calendars[0].verifiedThrough, cursor); assert.equal(h.data.Calendars[0].revision, revision);
  const restored = await h.service.status(h.user); assert.equal(restored.calendar.completionPending, false); assert.equal(restored.currentOperation, null);
});
