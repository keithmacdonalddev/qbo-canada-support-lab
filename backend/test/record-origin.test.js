'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readRecordOrigin, originPipelines, LIMIT } = require('../src/modules/record-origin');
const scope = { userId: 'owner', realmId: 'realm', environment: 'production', entity: 'Bill', id: '12' };
const recordId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const connectionId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
function fixture(values = {}) {
  const calls = [];
  return { calls, db: { collection: collection => ({ aggregate(pipeline, options) {
    calls.push({ collection, pipeline, options });
    return { toArray: async () => {
      const value = values[collection];
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(pipeline) : value || [];
    } };
  } }) } };
}
test('creation receipt search is owner/realm scoped, exact and bounded with no raw record projection', () => {
  for (const job of originPipelines(scope)) {
    assert.equal(job.pipeline[0].$match[job.key === 'business_operation' ? 'ownerId' : 'userId'], scope.userId);
    assert.equal(job.pipeline[0].$match.realmId, scope.realmId);
    assert.ok(job.pipeline.some(stage => stage.$limit === LIMIT + 1));
    const projection = job.pipeline.find(stage => stage.$project).$project;
    assert.equal(projection.toolInput, undefined); assert.equal(projection.result, undefined);
  }
  const plans = originPipelines(scope)[0].pipeline;
  const candidate = plans[0].$match.steps.$elemMatch;
  assert.equal(candidate.status, 'completed'); assert.equal(candidate['result.data.id'], '12');
  assert.equal(candidate.$or[0]['toolInput.entityType'], 'Bill');
  assert.deepEqual(candidate.$or[1], { toolName: 'createBill' });
  const match = plans[2].$match;
  assert.equal(match.$and[0].$or[0]['steps.result.data.entityType'], 'Bill'); assert.equal(match['steps.result.success'], true);
  assert.equal(match['steps.result.data.id'], '12'); assert.equal(match.$and[0].$or[0]['steps.toolInput.entityType'], 'Bill');
  assert.equal(match.$and[1].$or[1]['steps.executionScope.environment'], 'production');
  assert.equal(plans.at(-1).$lookup.pipeline[0].$match.userId, 'owner');
});
test('no app receipt is unknown, never an assertion that a record is manual or business activity', async () => {
  const f = fixture(); const result = await readRecordOrigin({ ...scope, db: f.db });
  assert.equal(result.status, 'unknown'); assert.equal(result.complete, true); assert.equal(result.baseline, 'unclassified');
  assert.equal(f.calls.length, 6); assert.ok(f.calls.every(call => call.options.maxTimeMS === 5000));
});
test('legacy case evidence is a historical match, even with a current case link', async () => {
  const f = fixture({ aiplans: [{ _id: recordId, cases: [{ _id: connectionId }], step: 4, createdAt: '2026-10-01' }] });
  const result = await readRecordOrigin({ ...scope, db: f.db });
  assert.equal(result.status, 'historical_match'); assert.equal(result.sources[0].kind, 'support_case');
  assert.equal(result.sources[0].scope, 'environment_unrecorded'); assert.equal(result.sources[0].caseId, connectionId);
});
test('new case receipts carry the saved environment, and unknown fields are never exposed', async () => {
  const f = fixture({ aiplans: [{ _id: recordId, cases: [], executionScope: { version: 1, realmId: scope.realmId, environment: scope.environment, connectionId },
    toolInput: { secret: 'private details' }, result: 'private result', createdAt: 'invalid' }] });
  const result = await readRecordOrigin({ ...scope, db: f.db });
  assert.equal(result.status, 'recorded'); assert.equal(result.sources[0].createdAt, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('generation receipts require a recorded connection and historical logs stay uncertain', async () => {
  const f = fixture({ generationruns: pipeline => pipeline[0].$match.environment === 'production' ? [{ _id: recordId, connectionId }] : [], seedruns: [{ _id: connectionId }] });
  const result = await readRecordOrigin({ ...scope, db: f.db });
  assert.equal(result.status, 'recorded'); assert.equal(result.sources[0].scope, 'recorded_environment');
  assert.equal(result.sources[1].scope, 'environment_unrecorded');
});
test('failed and truncated sources are explicit, not empty success', async () => {
  const f = fixture({ aiplans: new Error('private database hostname'), seedruns: Array.from({ length: LIMIT + 1 }, () => ({ _id: recordId })) });
  const result = await readRecordOrigin({ ...scope, db: f.db });
  assert.equal(result.status, 'incomplete'); assert.equal(result.complete, false); assert.equal(result.sources.length, LIMIT);
  assert.deepEqual(result.incompleteSources, ['assistant', 'seed']); assert.equal(JSON.stringify(result).includes('hostname'), false);
});
test('invalid entity, path and scope fail before database access', async () => {
  const f = fixture();
  for (const invalid of [{ entity: 'CompanyInfo' }, { id: '../12' }, { environment: 'other' }, { realmId: '' }]) {
    await assert.rejects(readRecordOrigin({ ...scope, ...invalid, db: f.db }));
  }
  assert.equal(f.calls.length, 0);
});

test('seed lookups match the lowercase names written by the real seed route', () => {
  const pipeline = originPipelines({ ...scope, entity: 'Customer' }).find(job => job.key === 'seed').pipeline;
  const saved = { entity: 'customer', qboId: '12' };
  assert.ok(pipeline[0].$match.createdEntities.$elemMatch.entity.$in.includes(saved.entity));
  assert.ok(pipeline[2].$match['createdEntities.entity'].$in.includes(saved.entity));
  assert.equal(pipeline[2].$match['createdEntities.qboId'], saved.qboId);
  assert.ok(!pipeline[2].$match['createdEntities.entity'].$in.includes('vendor'));
});

test('older assistant create tools match only the specific resulting entity type', () => {
  for (const [entity, toolName] of [['Invoice', 'createInvoice'], ['Payment', 'applyPayment'], ['Bill', 'createBill'], ['BillPayment', 'applyBillPayment']]) {
    const stages = originPipelines({ ...scope, entity })[0].pipeline;
    assert.deepEqual(stages[0].$match.steps.$elemMatch.$or[1], { toolName });
    assert.deepEqual(stages[2].$match.$and[0].$or[1], { 'steps.toolName': toolName });
  }
  assert.equal(originPipelines({ ...scope, entity: 'Vendor' })[0].pipeline[0].$match.steps.$elemMatch.$or.length, 1);
});

const { harness: businessHarness } = require('./helpers/business-runtime-fixture');
const config = require('../src/config'), previousEnvironment = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previousEnvironment; });
async function businessReceipt() {
  const h = businessHarness(); await h.execute();
  return { ...structuredClone(h.data.Receipts[0]), audits: structuredClone(h.data.Audits) };
}
const businessScope = { userId: 'c'.repeat(24), realmId: '123', environment: 'sandbox', entity: 'Estimate', id: '1000' };
test('business creation origin uses original dispatcher receipts and both matching audits', async () => {
  const row = await businessReceipt(), f = fixture({ qbowritereceipts: [row] });
  const result = await readRecordOrigin({ ...businessScope, db: f.db });
  assert.equal(result.status, 'recorded'); assert.equal(result.complete, true); assert.equal(result.baseline, 'unclassified'); assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0], { kind: 'business_operation', sourceId: row._id, operationId: String(row.operationId), connectionId: String(row.connectionId), caseId: null, scope: 'recorded_environment', createdAt: new Date(row.observedAt).toISOString() });
  for (const field of ['responseHash', 'requestHash', 'logicalKey', 'actorId', 'audits', 'observed']) assert.equal(JSON.stringify(result).includes('"' + field + '"'), false);
});
test('business origin pipeline excludes other owners, companies, environments and noncreation receipts', () => {
  const job = originPipelines(businessScope).find(value => value.key === 'business_operation'), match = job.pipeline[0].$match;
  assert.deepEqual(match, { ownerId: businessScope.userId, realmId: '123', environment: 'sandbox', kind: 'business', operation: 'create', state: 'saved', entity: 'estimate', 'observed.qboId': '1000' });
  const lookup = job.pipeline.at(-1).$lookup; assert.equal(lookup.from, 'auditlogs'); assert.equal(lookup.pipeline[0].$match.userId, businessScope.userId); assert.equal(lookup.pipeline[0].$match.realmId, '123'); assert.equal(lookup.pipeline[1].$limit, 3);
  assert.deepEqual(lookup.let, { start: '$startAuditId', result: '$resultAuditId' });
  assert.deepEqual(lookup.pipeline[0].$match.$expr, { $in: ['$_id', ['$$start', '$$result']] });
});
test('missing, changed or duplicate audits make the business origin source incomplete', async () => {
  const original = await businessReceipt();
  for (const change of [r => { r.audits.pop(); }, r => { r.audits[1].inputParams.requestHash = '0'.repeat(64); }, r => { r.audits[1].afterState.qboId = '999'; }, r => { r.audits[1].userId = 'f'.repeat(24); }, r => { r.audits.push(r.audits[0]); }, r => { r.resultAuditId = 'f'.repeat(24); }]) {
    const row = structuredClone(original); change(row); const result = await readRecordOrigin({ ...businessScope, db: fixture({ qbowritereceipts: [row] }).db });
    assert.equal(result.status, 'incomplete'); assert.deepEqual(result.incompleteSources, ['business_operation']); assert.equal(result.sources.length, 0);
  }
});
test('returned candidate scope and record identity are independently checked', async () => {
  const original = await businessReceipt();
  for (const change of [r => { r.ownerId = 'f'.repeat(24); }, r => { r.realmId = '456'; }, r => { r.environment = 'production'; }, r => { r.entity = 'invoice'; }, r => { r.observed.qboId = '1001'; }, r => { r.kind = 'legacy'; }, r => { r.operation = 'update'; }, r => { r.state = 'unknown'; }, r => { r.connectionId = 'f'.repeat(24); }, r => { r.actorId = 'f'.repeat(24); }, r => { r._id = 'f'.repeat(64); }, r => { r.observedAt = null; }, r => { r.sentAt = '2200-01-01'; }]) {
    const row = structuredClone(original); change(row); const result = await readRecordOrigin({ ...businessScope, db: fixture({ qbowritereceipts: [row] }).db });
    assert.equal(result.complete, false); assert.equal(result.sources.length, 0);
  }
});
test('business origin failures, overflow and conflicting creation receipts remain explicit', async () => {
  const row = await businessReceipt();
  for (const values of [new Error('private database endpoint'), Array.from({ length: LIMIT + 1 }, () => structuredClone(row)), [row, structuredClone(row)]]) {
    const result = await readRecordOrigin({ ...businessScope, db: fixture({ qbowritereceipts: values }).db }); assert.equal(result.complete, false); assert.ok(result.incompleteSources.includes('business_operation')); assert.equal(JSON.stringify(result).includes('private database'), false);
  }
});
