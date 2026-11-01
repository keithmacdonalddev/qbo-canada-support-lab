'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const roles = require('../src/modules/business-added-roles');
const { referenceDefinition } = require('../src/modules/business-reference');
const { hash } = require('../src/modules/business-calendar');
const { businessErrorDetail } = require('../src/modules/business-error-detail');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const owner = 'b'.repeat(24), operationId = 'c'.repeat(24);
const query = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => value });
function fixture(t, entity, version, alterReceipt = () => {}) {
  const item = entity === 'Item', kind = item ? 'item' : entity === 'Vendor' ? 'supplier' : 'customer';
  const key = 'added-' + kind + '-0123456789ab', name = 'Example ' + entity;
  const record = { Id: '55', SyncToken: '2', Active: true, ...(item ? { Name: name, Type: 'Service', UnitPrice: 149, IncomeAccountRef: { value: '126', name: 'Service income' }, SalesTaxCodeRef: { value: '16' } } : { DisplayName: name, CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' }, PrimaryEmailAddr: { Address: 'office@example.test' }, Balance: 0 }) };
  const role = { roleKey: key, kind, name, ...(item ? { incomeRole: 'careIncome', unit: 'month', unitPriceCents: 14900 } : {}) };
  const intent = { entity, details: { listRole: role } }, logicalKey = hash('list-' + entity);
  const dispatch = { key: hash('dispatch'), requestHash: hash('request'), compilationHash: hash('compiled'), actorId: owner };
  const savedResponse = { [entity]: structuredClone(record), time: '2026-10-31T10:00:00Z' };
  const observed = { outcome: 'saved', operation: 'create', entity: entity.toLowerCase(), httpStatus: 200, qboId: '55', syncToken: '2', responseHash: createHash('sha256').update(JSON.stringify(savedResponse)).digest('hex') };
  const receiptId = hash({ scope, dispatchKey: dispatch.key });
  const row = { _id: receiptId, contractVersion: 1, ...scope, operationId, logicalKey, kind: 'business', operation: 'create', entity: entity.toLowerCase(), dispatchKey: dispatch.key, requestHash: dispatch.requestHash, actorId: owner, ownerId: owner, state: 'saved', observed, savedResponse, startAuditId: hash({ receiptId, event: 'started' }).slice(0, 24), resultAuditId: hash({ receiptId, event: 'response', observed }).slice(0, 24) };
  const evidence = require('../src/modules/business-dispatch-receipt').businessTransportEvidence({ ...scope, operationId, logicalKey, entity, dispatch }, row);
  const verification = { kind: 'business-readback', compilationHash: dispatch.compilationHash, observedHash: hash(record), graphEvidenceHash: hash('graph'), listDefinitionHash: referenceDefinition(scope, entity, record, version).hash };
  verification.evidenceHash = require('../src/modules/business-readback').listReadbackEvidenceHash({ requestHash: dispatch.requestHash, compilationHash: dispatch.compilationHash, receiptHash: evidence.result.receipt.evidenceHash, recordHash: verification.observedHash });
  const step = { operationId, entity, state: 'verified', qboId: '55', logicalKey, planHash: hash('plan'), fingerprint: hash(intent), compilation: { entity, logicalKey, intentHash: hash(intent), compilationHash: dispatch.compilationHash, request: { body: JSON.stringify(item ? { Name: name, Type: 'Service', UnitPrice: 149 } : { DisplayName: name }) } }, dispatch, receipt: evidence.result.receipt, verification, lastAuditId: 'd'.repeat(24) };
  const run = { _id: operationId, status: 'verified', activityBatch: { key: 'list-batch' }, planId: 'e'.repeat(24), planHash: step.planHash, blueprintHash: hash('blueprint') };
  run.verification = { evidenceHash: hash('completion'), recordSetHash: hash('set'), planHash: run.planHash, blueprintHash: run.blueprintHash, operationId, completionAuditId: 'f'.repeat(24) };
  const audits = evidence.audits.map(a => ({ _id: a.id, userId: owner, actorUserId: owner, realmId: scope.realmId, action: a.action, actionType: 'manual', outcome: a.outcome, inputParams: evidence.params, afterState: a.afterState }));
  audits.push({ _id: step.lastAuditId, userId: owner, realmId: scope.realmId, action: 'Business operation evidence recorded', outcome: 'success', inputParams: { ...scope, details: { ...scope, operationId, logicalKey, phase: 'verify', qboId: '55', dispatchKey: dispatch.key } } });
  t.mock.method(require('../src/modules/business-readback'), 'validateCompilation', () => ({ scope, requestHash: dispatch.requestHash }));
  t.mock.method(require('../src/modules/business-activity-batch'), 'batchLifecycle', () => ({ mode: 'list-record', listRole: role, activityBatch: { key: 'list-batch' } }));
  t.mock.method(require('../src/modules/business-period-store'), 'assertRun', () => {});
  t.mock.method(require('../src/modules/business-stock-history'), 'committedReceipt', async () => ({ evidence: { evidenceHash: run.verification.evidenceHash, proof: { ...scope, records: [{ logicalKey, entity, qboId: '55', fingerprint: step.fingerprint, state: 'verified', auditId: step.lastAuditId }] } } }));
  alterReceipt(row);
  const models = { Steps: { find: () => query([step]) }, Runs: { find: () => query([run]) }, Intents: { findOne: () => query({ step: intent }) }, Receipts: { findOne: () => query(row) }, Audits: { findOne: filter => query(audits.find(a => String(a._id) === String(filter._id))) } };
  const batch = { activities: [{ [item ? 'itemKey' : entity === 'Vendor' ? 'vendorKey' : 'customerKey']: key, ...(item ? { incomeRole: 'careIncome', unit: 'month' } : {}) }] };
  return { record, models, batch, role, row, step };
}
for (const [entity, version] of [['Customer', 1], ['Vendor', 1], ['Item', 1], ['Item', 2]]) test(entity + ' v' + version + ' added role uses current meaning across provider defaults', async t => {
  const f = fixture(t, entity, version); delete f.step.verification.listDefinitionHash;
  const registry = await roles.listAddedRoles(f.models, scope, owner);
  assert.equal(registry.roles.length, 1); assert.deepEqual(registry.unusable, []);
  const observed = structuredClone(f.record); observed.SyncToken = '4'; observed.MetaData = { LastUpdatedTime: '2026-10-31T11:00:00Z' };
  if (entity === 'Item') { delete observed.IncomeAccountRef.name; observed.DeferredRevenue = false; }
  else { observed.ClientEntityId = '0'; observed.V4IDPseudonym = 'provider-only-id'; observed.IsProject = false; observed.Balance = 200; delete observed.CurrencyRef.name; }
  const resolve = record => roles.resolveBatchRoles({ scope, registry, batch: f.batch, readRecord: async () => record });
  assert.equal((await resolve(observed))[0].id, '55');
  assert.equal(JSON.stringify(registry).includes('office@example.test'), false);
  assert.equal(JSON.stringify(roles.choiceRoles(registry)).includes('provider-only-id'), false);
  const drift = entity === 'Item' ? [{ UnitPrice: 150 }, { IncomeAccountRef: { value: '999' } }, { SalesTaxCodeRef: { value: '12' } }] : [{ PrimaryEmailAddr: { Address: 'changed@example.test' } }, { ClientEntityId: '7' }, { Job: true }];
  for (const change of [...drift, { Notes: 'Owner changed this' }, { SyncToken: '1' }, { UnknownProviderSetting: true }]) assert.equal((await resolve({ ...observed, ...change }))[0].id,'55');
  const risk = entity === 'Item' ? [{ Type:'NonInventory' }, { IncomeAccountRef: null }] : [{ CurrencyRef:{value:'USD'} }, ...(entity==='Customer'?[{IsProject:true}]:[])];
  for (const change of [...risk, { Id:'999' }, { Active:false }, { sparse:true }]) await assert.rejects(resolve({...observed,...change}), /changed in QuickBooks/);
  if (entity !== 'Item') await assert.rejects(resolve({ ...observed, Balance: 'invalid' }), /changed in QuickBooks/);
  await assert.rejects(resolve({ ...observed, Active: false, Notes: 'Sensitive customer note' }), error => {
    const detail = businessErrorDetail(error); assert.equal(detail.entity,entity); assert.equal(detail.recordId,'55');
    assert.equal(JSON.stringify(detail).includes('Sensitive customer note'),false); return true;
  });
});
for (const tamper of ['bytes', 'approved-definition']) test('tampered retained receipt evidence still refuses reuse: ' + tamper, async t => {
  const f = fixture(t, 'Customer', 1, row => {
    if (tamper === 'bytes') row.savedResponse.Customer.Notes = 'tampered';
    if (tamper === 'approved-definition') { row.savedResponse.Customer.DisplayName = 'Changed'; row.observed.responseHash = createHash('sha256').update(JSON.stringify(row.savedResponse)).digest('hex'); }
    if (tamper === 'missing') delete row.savedResponse;
  });
  const registry = await roles.listAddedRoles(f.models, scope, owner);
  await assert.rejects(roles.resolveBatchRoles({ scope, registry, batch: f.batch, readRecord: async () => ({ ...f.record, ClientEntityId: '0', V4IDPseudonym: 'provider-only-id' }) }), /changed in QuickBooks|cannot be used/);
});

test('missing creation response body is not required for reuse with intact ownership receipts', async t => {
  const f=fixture(t,'Vendor',1,row=>{delete row.savedResponse;});
  const registry=await roles.listAddedRoles(f.models,scope,owner);
  assert.equal((await roles.resolveBatchRoles({scope,registry,batch:f.batch,readRecord:async()=>({...f.record,IsProject:false,FutureProviderDefault:true})}))[0].id,'55');
});
