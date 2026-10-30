'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const roles = require('../src/modules/business-added-roles');
const { referenceDefinition } = require('../src/modules/business-reference');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };

test('name lookup escapes apostrophes and backslashes and checks the shared party name space', async () => {
  const sent = [], taken = new Set(['Vendor']);
  const query = async text => { sent.push(text); const type = /FROM (\w+)/.exec(text)[1]; return { QueryResponse: taken.has(type) ? { [type]: [{ Id: '9' }] } : {} }; };
  assert.equal(await roles.nameTaken(query, 'Customer', "O'Brien Family Dental"), true);
  assert.deepEqual(sent.map(text => /FROM (\w+)/.exec(text)[1]), ['Customer', 'Vendor']);
  assert.ok(sent[0].includes("DisplayName = 'O\\'Brien Family Dental' AND Active IN (true, false)"), sent[0]);
  sent.length = 0; taken.clear();
  assert.equal(await roles.nameTaken(query, 'Item', 'Back\\slash'), false);
  assert.deepEqual(sent, ["SELECT Id FROM Item WHERE Name = 'Back\\\\slash' AND Active IN (true, false) MAXRESULTS 5"]);
  // An incomplete answer is never read as "free".
  await assert.rejects(roles.nameTaken(async () => ({}), 'Customer', 'Anyone'), /could not be checked/);
  await assert.rejects(roles.nameTaken(async () => ({ QueryResponse: { Customer: { Id: '1' } } }), 'Customer', 'Anyone'), /could not be checked/);
});

test('additions use their own batch and must fit the registry capacity', () => {
  const add = { type: 'add-customer', name: 'New Clinic', purpose: 'A new clinic signed on.' }, sale = { type: 'settled-service-sale', customerKey: 'care-client-001' };
  assert.throws(() => roles.assertListOnlyBatch({ activities: [add, sale] }), /own batch/);
  roles.assertListOnlyBatch({ activities: [add, { ...add, type: 'add-item' }] });
  roles.assertListOnlyBatch({ activities: [sale] });
  const three = { activities: [add, add, add] };
  assert.throws(() => roles.assertCapacity({ count: roles.MAX_ROLES - 2, overCapacity: false }, three), /room for 2 more/);
  roles.assertCapacity({ count: roles.MAX_ROLES - 3, overCapacity: false }, three);
  assert.throws(() => roles.assertCapacity({ count: roles.MAX_ROLES + 1, overCapacity: true }, { activities: [add] }), /room for 0 more/);
  // Over capacity never blocks batches that add nothing.
  roles.assertCapacity({ count: roles.MAX_ROLES + 1, overCapacity: true }, { activities: [sale] });
});

test('before each write a saved list batch is rechecked: own batch only, and room for this exact record', async () => {
  const rows = [], models = { Steps: { find: () => { const q = { select: () => q, limit: () => q, maxTimeMS: () => q, lean: async () => rows }; return q; } } };
  const add = { type: 'add-customer', name: 'New Clinic', purpose: 'A new clinic signed on.' }, sale = { type: 'settled-service-sale', customerKey: 'care-client-001' };
  const op = 'f'.repeat(24), key = 'e'.repeat(64);
  // A mixed batch saved before the own-batch rule is refused at operation start and before any write.
  await assert.rejects(roles.assertDispatchable(models, scope, { activities: [add, sale] }, op, null), /own batch/);
  await assert.rejects(roles.assertDispatchable(models, scope, { activities: [add, sale] }, op, key), /own batch/);
  // 999 other records leave room for this one; a resent attempt of this exact step never counts itself.
  for (let n = 0; n < roles.MAX_ROLES - 1; n++) rows.push({ operationId: 'a'.repeat(24), logicalKey: String(n) });
  rows.push({ operationId: op, logicalKey: key });
  await roles.assertDispatchable(models, scope, { activities: [add] }, op, key);
  assert.deepEqual(await roles.countAddedRecords(models, scope), { count: roles.MAX_ROLES, overCapacity: false });
  // One more record created since approval: this record is not sent.
  rows.push({ operationId: op, logicalKey: 'd'.repeat(64) });
  await assert.rejects(roles.assertDispatchable(models, scope, { activities: [add] }, op, key), /registry is full \(1000 of 1000\); this record was not sent/);
  // Batches that add nothing are never blocked; the operation-start check is shape only.
  await roles.assertDispatchable(models, scope, { activities: [sale] }, op, key);
  await roles.assertDispatchable(models, scope, { activities: [add] }, op, null);
});

test('a used role must keep its verified full definition; only versions and balances may change', async () => {
  const record = { Id: '55', SyncToken: '0', Active: true, DisplayName: 'Harbour Lane Clinic', CurrencyRef: { value: 'CAD' }, PrimaryEmailAddr: { Address: 'office@harbour.example' }, Balance: 0, BalanceWithJobs: 0, Job: false, BillWithParent: false, MetaData: { CreateTime: '2026-12-01T10:00:00-04:00', LastUpdatedTime: '2026-12-01T10:00:00-04:00' } };
  const key = 'added-customer-0123456789ab', role = { key, kind: 'customer', entity: 'Customer', id: '55', name: record.DisplayName, definitionHash: referenceDefinition(scope, 'Customer', record).hash };
  const registry = { roles: [role], unusable: [], count: 1, overCapacity: false };
  const batch = { activities: [{ type: 'settled-service-sale', customerKey: key, itemKey: 'care-plan-1' }] };
  const resolve = observed => roles.resolveBatchRoles({ registry, batch, scope, readRecord: async () => observed });
  // QuickBooks-maintained fields (version, metadata, balances) may change.
  const [bound] = await resolve({ ...structuredClone(record), SyncToken: '4', Balance: 125.5, BalanceWithJobs: 125.5, MetaData: { ...record.MetaData, LastUpdatedTime: '2026-12-02T10:00:00-04:00' } });
  assert.deepEqual(bound, { key, entity: 'Customer', id: '55', syncToken: '4' });
  for (const drift of [{ ParentRef: { value: '7' }, Job: true, BillWithParent: true }, { IsProject: true }, { PrimaryEmailAddr: { Address: 'other@elsewhere.example' } }, { Notes: 'Changed' }, { CurrencyRef: { value: 'USD' } }, { Active: false }])
    await assert.rejects(resolve({ ...structuredClone(record), SyncToken: '5', ...drift }), /changed in QuickBooks/, JSON.stringify(drift));
  // A role without a retained definition, or an unusable entry, is refused.
  await assert.rejects(roles.resolveBatchRoles({ registry: { ...registry, roles: [{ ...role, definitionHash: undefined }] }, batch, scope, readRecord: async () => record }), /changed in QuickBooks/);
  await assert.rejects(roles.resolveBatchRoles({ registry: { roles: [], unusable: [{ key, kind: 'customer', name: 'Harbour Lane Clinic', reason: 'its read-back verification proof is missing' }], count: 1, overCapacity: false }, batch, scope, readRecord: async () => record }), /Harbour Lane Clinic cannot be used: its read-back verification proof is missing/);
});
