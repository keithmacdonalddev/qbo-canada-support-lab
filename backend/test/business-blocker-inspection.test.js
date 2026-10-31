'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBlockerInspection } = require('../src/modules/business-blocker-inspection');
const { createBusinessAgentTools } = require('../src/modules/business-agent-tools');
const { createToolbox } = require('../src/modules/business-agent-toolbox');
const { referenceDefinition } = require('../src/modules/business-reference');
const { hash } = require('../src/modules/business-calendar');
const scope = { environment: 'production', realmId: '123456789', connectionId: '1'.repeat(24) };
const operationId = 'a'.repeat(24), planId = 'b'.repeat(24), planHash = 'c'.repeat(64), logicalKey = 'd'.repeat(64);
const now = Date.parse('2026-10-31T12:00:00Z');
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(option => matches(row, option));
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(row[key]);
    return String(row[key]) === String(value);
  });
}
function fixture() {
  const reads = [];
  const db = { Runs: [{ _id: operationId, ...scope, planId, planHash, status: 'blocked', nextOrdinal: 0, recordCount: 2, lastError: 'The selected Item differs from its approved definition.', executionRequest: { result: { error: 'Definition refusal', code: 'BUSINESS_REFERENCE_UNVERIFIED', diagnostic: { stack: 'Error: definition refusal\n at compile (business-reference.js:75:1)', source: 'business-reference.js', access_token: 'fixture-private', token: 'fixture-token', credentials: 'fixture-credentials', message: 'Authorization: Bearer fixture-bearer api_key=fixture-api mongodb://user:fixture-pass@localhost/db', cause: { token: 'fixture-token', credentials: 'fixture-credentials', message: 'Authorization: Basic Zml4dHVyZS1jcmVkZW50aWFs' } } } } }],
    Authorities: [], Audits: [], Steps: [], Intents: [{ ...scope, planId, planHash, ordinal: 0, logicalKey, step: { entity: 'Invoice', txnDate: '2026-10-31', references: [] }, policy: {} }], Records: [] };
  const models = Object.fromEntries(Object.keys(db).map(name => [name, { findOne: filter => query(name, filter, false), find: filter => query(name, filter, true) }]));
  function query(name, filter, plural) {
    for (const key of (name === 'Audits' ? ['realmId'] : ['environment', 'realmId', 'connectionId'])) assert.equal(filter[key], scope[key], name + ' must be company scoped');
    reads.push({ name, filter }); let limit = Infinity, sort = null;
    const q = { session() { return q; }, sort(value) { sort = value; return q; }, limit(n) { limit = n; return q; }, maxTimeMS(n) { assert.equal(n, 3000); return q; }, async lean() {
      let rows = db[name].filter(row => matches(row, filter));
      if (sort) rows = [...rows].sort((a, b) => { for (const [key, dir] of Object.entries(sort)) { if (a[key] < b[key]) return -dir; if (a[key] > b[key]) return dir; } return 0; });
      return structuredClone(plural ? rows.slice(0, limit) : rows[0] || null);
    } }; return q;
  }
  const mirror = (entity, record, extra = {}) => db.Records.push({ ...scope, entity, qboId: record.Id, record, lastObservedAt: new Date(now - 1000).toISOString(), deleted: false, generation: 'fixture-generation', ...extra });
  const binding = (entity, record) => ({ key: 'fixture-role', entity, id: record.Id, syncToken: record.SyncToken, status: 'resolved', definition: referenceDefinition(scope, entity, record) });
  const inspect = createBlockerInspection({ models, scope, now: () => now });
  return { db, models, reads, mirror, binding, inspect };
}
const item = () => ({ Id: '19', SyncToken: '1', Active: true, Name: 'Approved service', Type: 'Service', UnitPrice: 125, IncomeAccountRef: { value: '40', name: 'Service income' }, SalesTaxCodeRef: { value: '6', name: 'HST' } });
test('refusal before claim reports exact run diagnostic and cursor, redacting secrets', async () => {
  const h = fixture(), result = await h.inspect(operationId);
  assert.equal(result.success, true); assert.equal(result.data.steps[0].state, 'not-claimed'); assert.equal(result.data.steps[0].ordinal, 0);
  assert.equal(result.data.qboRequests, 0); assert.equal(result.data.readOnly, true);
  assert.match(result.data.diagnostic.stack, /business-reference.js:75:1/); assert.match(result.data.lastError, /approved definition/);
  const text = JSON.stringify(result);
  for (const secret of ['fixture-private', 'fixture-bearer', 'fixture-api', 'fixture-pass', 'fixture-token', 'fixture-credentials', 'Zml4dHVyZS1jcmVkZW50aWFs']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(h.db.Steps, []);
});
test('reference differences show retained approved versus current names, refs, price, type, active and SyncToken', async () => {
  const h = fixture(), approved = item(), binding = { ...h.binding('Item', approved), record: approved };
  h.db.Intents[0].step.references = [binding];
  h.mirror('Item', { ...approved, Name: 'Renamed', SyncToken: '2', UnitPrice: 140, Type: 'NonInventory', Active: false, IncomeAccountRef: { value: '41', name: 'Other income' }, SalesTaxCodeRef: { value: '7', name: 'Exempt' }, apiKey: 'fixture-secret' });
  const data = (await h.inspect(operationId)).data, ref = data.steps[0].references[0];
  assert.equal(ref.approvedFieldsAvailable, true);
  for (const field of ['Name', 'SyncToken', 'UnitPrice', 'Type', 'Active', 'IncomeAccountRef.value', 'IncomeAccountRef.name', 'SalesTaxCodeRef.value']) assert.ok(ref.differences.some(row => row.field === field), field);
  assert.deepEqual(ref.differences.find(row => row.field === 'UnitPrice'), { field: 'UnitPrice', approved: 125, current: 140, approvedPresent: true, currentPresent: true });
  assert.ok(!JSON.stringify(data).includes('fixture-secret')); assert.equal(ref.currentDefinition, null);
});
test('legacy hash-only binding never invents approved field values and can authenticate matching synced fields', async () => {
  const h = fixture(), approved = item(); h.db.Intents[0].step.references = [h.binding('Item', approved)];
  h.mirror('Item', { ...approved, Name: 'Renamed', SyncToken: '2' });
  let ref = (await h.inspect(operationId)).data.steps[0].references[0];
  assert.equal(ref.approvedFieldsAvailable, false); assert.match(ref.missingApprovedFields, /cannot be reconstructed/);
  assert.equal(ref.synced.fields.Name, 'Renamed'); assert.ok(!ref.differences.some(row => row.field === 'Name'));
  assert.deepEqual(ref.approved, { Id: '19', SyncToken: '1' });
  h.db.Records[0].record = { ...approved, SyncToken: '2' };
  ref = (await h.inspect(operationId)).data.steps[0].references[0];
  assert.equal(ref.approvedFieldsAvailable, true); assert.equal(ref.approvedSource, 'matching-synced-definition');
  assert.equal(ref.approved.SyncToken, '1'); assert.deepEqual(ref.differences.map(row => row.field), ['SyncToken']);
});
test('tax refusal compares approved TaxCode and TaxRate, including effective rates', async () => {
  const h = fixture(), code = { Id: '6', SyncToken: '1', Active: true, Name: 'HST', SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '9', name: 'HST sales' }, TaxTypeApplicable: 'TaxOnAmount' }] } }, rate = { Id: '9', SyncToken: '1', Active: true, Name: 'HST sales', RateValue: 15, EffectiveTaxRate: [{ EffectiveDate: '2020-01-01', RateValue: 15 }] };
  h.db.Runs[0].executionRequest.result.code = 'BUSINESS_TAX_UNVERIFIED';
  h.db.Intents[0].policy.taxSources = [{ entity: 'TaxCode', id: '6', record: code, recordHash: hash(code) }, { entity: 'TaxRate', id: '9', record: rate, recordHash: hash(rate) }];
  h.db.Intents[0].step.references = [h.binding('TaxCode', code)];
  h.mirror('TaxCode', { ...code, SyncToken: '2', Name: 'Revised HST' });
  h.mirror('TaxRate', { ...rate, SyncToken: '2', RateValue: 14, EffectiveTaxRate: [{ EffectiveDate: '2025-04-01', RateValue: 14 }] });
  const step = (await h.inspect(operationId)).data.steps[0];
  assert.equal(step.references[0].approvedFieldsAvailable, true);
  assert.ok(step.taxSources.find(row => row.entity === 'TaxCode').differences.some(row => row.field === 'Name'));
  const comparison = step.taxSources.find(row => row.entity === 'TaxRate');
  assert.ok(comparison.differences.some(row => row.field === 'EffectiveTaxRate[0].RateValue' && row.approved === 15 && row.current === 14));
  h.db.Intents[0].policy.taxSources[1].recordHash = 'f'.repeat(64);
  assert.equal((await h.inspect(operationId)).data.steps[0].taxSources[1].approvedEvidenceMatchesHash, false);
});
test('deferred needs-check identifies the saved record/version and retained live comparison', async () => {
  const h = fixture(), approved = item(), current = { ...approved, Name: 'Live name', SyncToken: '3' };
  h.db.Runs[0].nextOrdinal = 2; h.db.Runs[0].deferredSteps = [{ ordinal: 0, logicalKey }];
  h.db.Intents[0].step.references = [{ ...h.binding('Item', approved), record: approved }];
  h.db.Steps.push({ ...scope, operationId, planHash, logicalKey, entity: 'Invoice', qboId: '101', state: 'needs-check', receipt: { syncToken: '0' }, verification: { syncToken: '1', observedHash: 'e'.repeat(64), reason: 'Invoice version changed during verification.' } });
  h.mirror('Invoice', { Id: '101', SyncToken: '2', TotalAmt: 100 }); h.mirror('Item', approved);
  const observation = { scope, entity: 'Item', record: current, observedAt: new Date(now - 100).toISOString(), recordHash: hash(current), source: { kind: 'qbo-full-entity-get', scope, entity: 'Item', id: '19', recordHash: hash(current) } };
  h.db.Runs[0].executionRequest.result.diagnostic.observations = [observation];
  const step = (await h.inspect(operationId)).data.steps[0];
  assert.equal(step.deferred, true); assert.equal(step.atCursor, false); assert.equal(step.recordVersion.id, '101');
  assert.equal(step.recordVersion.versionMismatch, true); assert.equal(step.recordVersion.verifiedVersion, '1'); assert.equal(step.recordVersion.currentSyncedVersion, '2');
  assert.ok(step.references[0].latestLiveObservation.differences.some(row => row.field === 'Name' && row.current === 'Live name'));
  observation.scope = { ...scope, realmId: 'other' }; h.db.Runs[0].executionRequest.result.diagnostic.observations = [observation];
  assert.equal((await h.inspect(operationId)).data.steps[0].references[0].latestLiveObservation, null);
});
test('company scope, input, missing records and cancellation are enforced without writes', async () => {
  const h = fixture(); h.db.Runs[0].realmId = 'other';
  assert.equal((await h.inspect(operationId)).notFound, true); assert.equal(h.reads.length, 1);
  await assert.rejects(h.inspect('bad'), /exact saved operation/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createBlockerInspection({ models: h.models, scope, signal: controller.signal })(operationId), /abort/i);
});
test('inspectBlocker is deferred, discoverable as business-read, authorized, and callable with useTool', async () => {
  const h = fixture(), permissions = [];
  const tools = createBusinessAgentTools({ row: {}, scope, store: { models: h.models }, readTools: { toolDefinitions: [] }, guard: async () => {}, access: { authorize: async (s, action) => { assert.deepEqual(s, scope); permissions.push(action); } }, now: () => now });
  const box = createToolbox({ definitions: tools.definitions, execute: tools.execute });
  assert.ok(!box.coreDefinitions.some(tool => tool.name === 'inspectBlocker'));
  const found = await box.execute('searchTools', { query: 'select:inspectBlocker', category: 'business-read' });
  assert.equal(found.data.tools[0].name, 'inspectBlocker'); assert.equal(found.data.tools[0].core, false);
  assert.equal((await box.execute('useTool', { name: 'inspectBlocker', input: { operationId } })).success, true);
  assert.deepEqual(permissions, ['operations.read']);
  assert.equal((await box.execute('useTool', { name: 'inspectBlocker', input: { operationId, realmId: 'other' } })).success, false);
  const denied = createBusinessAgentTools({ row: {}, scope, store: { models: h.models }, readTools: { toolDefinitions: [] }, guard: async () => {}, access: { authorize: async () => { throw Error('read denied'); } } });
  const before = h.reads.length; await assert.rejects(denied.execute('inspectBlocker', { operationId }), /read denied/); assert.equal(h.reads.length, before);
});

test('the stopped cursor is retained even when more than twenty earlier checks exist', async () => {
  const h = fixture(); h.db.Runs[0].nextOrdinal = 25; h.db.Runs[0].recordCount = 26;
  const original = h.db.Intents[0]; h.db.Intents.length = 0;
  for (let n = 0; n < 26; n++) {
    const key = n.toString(16).padStart(64, '0');
    h.db.Intents.push({ ...original, ordinal: n, logicalKey: key });
    if (n < 25) h.db.Steps.push({ ...scope, operationId, planHash, logicalKey: key, state: 'needs-check', updatedAt: n });
  }
  const data = (await h.inspect(operationId)).data;
  assert.equal(data.steps[0].ordinal, 25); assert.equal(data.steps[0].atCursor, true); assert.ok(data.limitations.length);
});
test('a matching v2 definition cannot invent approved historical reference labels', async () => {
  const h = fixture(), approved = item(); h.db.Intents[0].step.references = [h.binding('Item', approved)];
  h.mirror('Item', { ...approved, SyncToken: '2', IncomeAccountRef: { value: '40', name: 'Renamed income' } });
  const ref = (await h.inspect(operationId)).data.steps[0].references[0];
  assert.ok(ref.unboundApprovedFields.includes('IncomeAccountRef.name'));
  assert.equal(ref.approved.IncomeAccountRef.name, undefined);
  assert.equal(ref.synced.fields.IncomeAccountRef.name, 'Renamed income');
  assert.ok(!ref.differences.some(row => row.field === 'IncomeAccountRef.name'));
});
test('approved tax amendment is the effective policy and missing amendment evidence is explicit', async () => {
  const h = fixture(), code = { Id: '6', SyncToken: '1', Active: true, Name: 'Old HST' }, amended = { ...code, SyncToken: '2', Name: 'Reviewed HST' };
  const intent = h.db.Intents[0], run = h.db.Runs[0], ownerId = 'f'.repeat(24), auditId = 'e'.repeat(24);
  intent.kind = 'create'; intent.policy = { scope, taxSources: [{ entity: 'TaxCode', id: '6', record: code, recordHash: hash(code) }] };
  intent.step.references = [h.binding('TaxCode', code)];
  const body = { scope, taxSources: [{ entity: 'TaxCode', id: '6', record: amended, recordHash: hash(amended) }], taxReferenceDefinitions: [{ key: 'fixture-role', id: '6', originalDefinitionHash: intent.step.references[0].definition.hash, definition: referenceDefinition(scope, 'TaxCode', amended) }] };
  const policy = { ...body, evidenceHash: hash(body) };
  const payload = { kind: 'operation-policy-amendment', operationId, planHash, authorityHash: '9'.repeat(64), scope, ownerId, overrides: [{ logicalKey, originalPolicyHash: hash(intent.policy), policy }] };
  run.authorityHash = payload.authorityHash; run.approval = { actorId: ownerId }; run.policyAmendmentHash = hash(payload);
  h.db.Authorities.push({ ...scope, contentHash: run.policyAmendmentHash, payload, actorId: ownerId, auditId });
  // This fixture model matches literal dotted audit filters as passed by the trusted loader.
  h.db.Audits.push({ _id: auditId, realmId: scope.realmId, userId: ownerId, action: 'Remaining business tax expectations approved', outcome: 'success', 'afterState.amendmentHash': run.policyAmendmentHash, 'afterState.operationId': operationId, 'afterState.planHash': planHash });
  h.mirror('TaxCode', amended);
  let step = (await h.inspect(operationId)).data.steps[0];
  assert.equal(step.policyError, null); assert.equal(step.taxSources[0].approved.Name, 'Reviewed HST'); assert.equal(step.taxSources[0].differences.length, 0);
  assert.equal(step.references[0].originalApprovedBinding.definition.hash, intent.step.references[0].definition.hash);
  assert.equal(step.references[0].approved.Name, 'Reviewed HST');
  h.db.Authorities.length = 0;
  step = (await h.inspect(operationId)).data.steps[0];
  assert.match(step.policyError.error, /unavailable/); assert.deepEqual(step.taxSources, []);
});
test('raw observations never bypass company filtering and large diagnostics stay bounded', async () => {
  const h = fixture();
  h.db.Runs[0].executionRequest.result.diagnostic = { message: 'Definition failed', observations: [{ scope: { ...scope, realmId: 'other' }, record: { Name: 'foreign-private-name' } }], source: { file: 'business-reference.js', record: { Name: 'foreign-private-name' } }, cause: { record: { Name: 'foreign-private-name' } }, stack: 'x'.repeat(200000) };
  let result = await h.inspect(operationId);
  assert.ok(!JSON.stringify(result).includes('foreign-private-name')); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 85000);
  h.db.Runs[0].executionRequest.result.diagnostic.cause = Object.fromEntries(Array.from({ length: 150 }, (_, n) => ['detail' + n, 'x'.repeat(6000)]));
  result = await h.inspect(operationId); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 85000);
});
