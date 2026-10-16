'use strict';
const { canonical, hash, date, shift, planBusinessCalendar } = require('./business-calendar');
const { activityDefinition, businessDate } = require('./business-activity-preview');
const { prepareBusinessOperation } = require('./business-operation-preview');
const { MAX_AUTHORITIES } = require('./business-authority-lineage');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/, KEY = /^[a-z][a-z0-9-]{0,99}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_CONTINUITY_UNVERIFIED' }); }
function exact(value, keys) { return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function prepareContinuingBusiness(active, scope, input, setup, masters, now) {
  const lineage = active.lineage;
  if (!lineage || lineage.entries.length < 2 || lineage.entries.length > MAX_AUTHORITIES || hash(lineage.segments) !== lineage.lineageHash) fail('The complete current business lineage is required.');
  const steps = [], earlier = [], origins = [], futureKeys = new Set(), seen = new Set(), sources = [];
  let remaining = null;
  for (let index = 0; index < lineage.entries.length; index++) {
    const entry = lineage.entries[index], segment = lineage.segments[index], next = lineage.segments[index + 1];
    if (segment.effectiveFrom > input.throughDate || (next && next.effectiveFrom <= shift(input.fromDate, -365))) continue;
    const definition = activityDefinition(entry.view.business), plan = planBusinessCalendar({ definition, scope: { realmId: scope.realmId, environment: scope.environment }, fromDate: input.fromDate, throughDate: input.throughDate, today: businessDate(now) });
    const inside = event => event.occurrence >= segment.effectiveFrom && (!next || event.occurrence < next.effectiveFrom);
    const selected = plan.events.filter(inside);
    // A window selects whole occurrences. Follow-ups keep their original view,
    // even when their posting date is after the next blueprint takes effect.
    const wanted = new Map(selected.map(event => [event.logicalKey, event]));
    const all = new Map([...plan.events, ...plan.future, ...plan.prerequisites].map(event => [event.logicalKey, event]));
    for (const event of plan.future.filter(inside)) { if (futureKeys.has(event.logicalKey)) fail('Business windows duplicate a future obligation.'); futureKeys.add(event.logicalKey); }
    if (!selected.length) continue;
    const view = { ...scope, draft: entry.view, proposal: null };
    const prepared = prepareBusinessOperation(view, { ...input, baseHash: entry.value.blueprintHash }, setup, masters, now);
    const prior = new Set();
    const retain = event => { for (const key of event.dependsOn) { const parent = all.get(key); if (!parent || !inside(parent)) fail('An original occurrence dependency is unavailable.'); if (parent.txnDate < input.fromDate && !prior.has(key)) { prior.add(key); retain(parent); } } };
    for (const event of selected) retain(event);
    for (const step of prepared.steps.filter(step => wanted.has(step.logicalKey))) {
      if (seen.has(step.logicalKey)) fail('Business revision windows duplicate an activity identity.');
      seen.add(step.logicalKey); steps.push(step);
      const event = wanted.get(step.logicalKey);
      origins.push({ logicalKey: step.logicalKey, authorityHash: segment.authorityHash, blueprintId: segment.blueprintId, blueprintHash: segment.blueprintHash, occurrence: event.occurrence, ruleKey: event.ruleKey, stepKey: event.stepKey });
    }
    if (selected.length !== prepared.steps.filter(step => wanted.has(step.logicalKey)).length) fail('A selected business occurrence is missing its exact prepared activity.');
    for (const row of prepared.earlierRequirements.filter(row => prior.has(row.logicalKey))) { if (earlier.some(value => value.logicalKey === row.logicalKey)) fail('Business revision windows duplicate an earlier obligation.'); earlier.push(row); }
    remaining ||= prepared.remaining;
    sources.push({ authorityHash: segment.authorityHash, calendarHash: prepared.calendarHash, selectedKeys: [...wanted.keys()].sort() });
    if (steps.length > 500 || steps.length + earlier.length > 1000) fail('Combined business windows exceed the operation record budget. Shorten the period.');
  }
  const continuity = { version: 1, authorityHash: active.authority.contentHash, lineageHash: lineage.lineageHash, segments: lineage.segments, origins: origins.sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) };
  // Empty periods still retain the same operation-wide requirements.
  if (!remaining) remaining = [{ key: 'baseline', reason: 'Retain the original accepted opening evidence.' }, { key: 'business_policy', reason: 'Review this exact current-head activity.' }, { key: 'period_control', reason: 'Protect the current calendar and prior receipts.' }, { key: 'execution', reason: 'Verify the saved records and required reports.' }];
  const payload = { version: 1, scope, businessKey: active.value.businessKey, openingDate: active.value.openingDate, blueprintId: active.value.blueprintId, blueprintHash: active.value.blueprintHash, fromDate: input.fromDate, throughDate: input.throughDate,
    calendarHash: hash(sources), detailsHash: hash(steps.map(step => ({ logicalKey: step.logicalKey, detailsHash: step.detailsHash }))), observations: { setup: { sourceHash: setup.sourceHash, observedAt: setup.observedAt }, masters: { sourceHash: masters.sourceHash, observedAt: masters.observedAt } },
    steps: steps.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.logicalKey.localeCompare(b.logicalKey)), earlierRequirements: earlier.sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)), futureFollowUps: futureKeys.size, remaining, continuity };
  if (Buffer.byteLength(canonical(payload)) > 8000000) fail('Combined business windows exceed the retained operation size budget.');
  return { ...payload, operationHash: hash(payload), preparedAt: now.toISOString(), readyToExecute: false, persisted: false,
    summary: { steps: steps.length, blockedSteps: steps.filter(step => step.status === 'blocked').length, unresolvedReferences: new Set(steps.flatMap(step => step.references.filter(ref => ref.status !== 'resolved').map(ref => ref.entity + ':' + ref.key))).size },
    limitations: ['Each occurrence retains its approved original business definition. No existing record is adopted or rewritten.', 'The complete combined plan still requires owner approval and fresh saved-record/report verification.'] };
}
function validateOperationContinuity(value, candidate) {
  if (!exact(value, ['version', 'authorityHash', 'lineageHash', 'segments', 'origins']) || value.version !== 1 || !HASH.test(value.authorityHash || '') || value.authorityHash !== candidate.authorityHash || !HASH.test(value.lineageHash || '') || !Array.isArray(value.segments) || value.segments.length < 2 || value.segments.length > MAX_AUTHORITIES || hash(value.segments) !== value.lineageHash || !Array.isArray(value.origins) || value.origins.length > 500) fail('The operation needs its exact complete business revision history.');
  const authorities = new Set();
  for (let index = 0; index < value.segments.length; index++) {
    const segment = value.segments[index];
    if (!exact(segment, ['authorityHash', 'blueprintId', 'blueprintHash', 'effectiveFrom']) || !HASH.test(segment.authorityHash || '') || authorities.has(segment.authorityHash) || !ID.test(segment.blueprintId || '') || !HASH.test(segment.blueprintHash || '')) fail('The business revision windows are incomplete or duplicated.');
    date(segment.effectiveFrom); authorities.add(segment.authorityHash);
    if (index ? segment.effectiveFrom <= value.segments[index - 1].effectiveFrom : segment.effectiveFrom !== candidate.openingDate) fail('Business revision windows must partition occurrences from the original opening.');
  }
  const last = value.segments.at(-1);
  if (last.authorityHash !== value.authorityHash || last.blueprintId !== candidate.blueprintId || last.blueprintHash !== candidate.blueprintHash) fail('The operation does not use the exact current business head.');
  const creates = new Map(candidate.entries.filter(entry => entry.kind === 'create').map(entry => [entry.step.logicalKey, entry.step]));
  if (creates.size !== value.origins.length) fail('Every new activity needs exactly one original business revision.');
  const seen = new Set();
  for (const origin of value.origins) {
    if (!exact(origin, ['logicalKey', 'authorityHash', 'blueprintId', 'blueprintHash', 'occurrence', 'ruleKey', 'stepKey']) || !HASH.test(origin.logicalKey || '') || seen.has(origin.logicalKey) || !creates.has(origin.logicalKey) || !KEY.test(origin.ruleKey || '') || !KEY.test(origin.stepKey || '')) fail('The operation has missing or duplicate occurrence origins.');
    date(origin.occurrence); seen.add(origin.logicalKey);
    const selected = value.segments.filter(segment => segment.effectiveFrom <= origin.occurrence).at(-1), step = creates.get(origin.logicalKey);
    if (!selected || ['authorityHash', 'blueprintId', 'blueprintHash'].some(key => origin[key] !== selected[key]) || origin.occurrence > step.txnDate || origin.logicalKey !== hash({ realmId: candidate.scope.realmId, environment: candidate.scope.environment, businessKey: candidate.businessKey, ruleKey: origin.ruleKey, occurrence: origin.occurrence, stepKey: origin.stepKey })) fail('An activity differs from its original occurrence window.');
    if ([2, 3].includes(step.details.activityTemplateVersion) && canonical(step.details.origin) !== canonical({ openingDate: candidate.openingDate, occurrence: origin.occurrence, ruleKey: origin.ruleKey, stepKey: origin.stepKey })) fail('The saved lifecycle and business revision origins differ.');
  }
  return JSON.parse(canonical(value));
}
module.exports = { prepareContinuingBusiness, validateOperationContinuity };
