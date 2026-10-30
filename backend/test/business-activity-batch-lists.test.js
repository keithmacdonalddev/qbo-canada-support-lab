'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const batchTools = require('../src/modules/business-activity-batch');
const { fixture } = require('./helpers/business-governance-fixture');
const config = require('../src/config'); const previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const additions = key => ({ decisionKey: 'add-roles-' + key, purpose: 'Grow the business with a new client, a new supplier and a new service.', activities: [
  { type: 'add-customer', name: 'Harbour Lane Clinic ' + key, email: 'office@harbourlane.example', purpose: 'A new clinic signed a service agreement.' },
  { type: 'add-supplier', name: 'Bayview Cleaning ' + key, purpose: 'A new cleaning supplier for the office.' },
  { type: 'add-item', name: 'Site survey ' + key, incomeRole: 'serviceIncome', unit: 'each', unitPriceCents: 25000, purpose: 'A new fixed-price site survey service.' }] });
const V5 = [...batchTools.SAVED_POLICIES.values()].find(policy => policy.version === 5);

test('v6 accepts list additions; older policies keep their exact original rules', () => {
  const v6 = batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', choices: additions('x') });
  assert.equal(v6.policyHash, batchTools.POLICY_HASH);
  const activity = batchTools.buildBatchActivity(v6, scope, 'b');
  assert.deepEqual(activity.events.map(event => event.entity), ['Customer', 'Vendor', 'Item']);
  const roles = activity.events.map(event => activity.detailProposal.byLogicalKey[event.logicalKey].details.listRole);
  assert.match(roles[0].roleKey, batchTools.ADDED.customer); assert.match(roles[2].roleKey, batchTools.ADDED.item);
  assert.equal(activity.detailProposal.byLogicalKey[activity.events[2].logicalKey].details.incomeMapping, 'serviceIncome');
  // v5 cannot claim the new workflows or added roles, and a v5 batch rebuilds unchanged.
  assert.throws(() => batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', choices: additions('x'), policy: V5 }), /not part of the saved activity policy/);
  const sale = { decisionKey: 'sale-added-0001', purpose: 'Sell a visit to a returning client of the business.', activities: [{ type: 'settled-service-sale', customerKey: 'added-customer-0123456789ab', itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 1000, purpose: 'Monthly care plan.' }] };
  assert.throws(() => batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', choices: sale, policy: V5 }), /published business/);
  const v5 = batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', choices: { ...sale, activities: [{ ...sale.activities[0], customerKey: 'care-client-001' }] }, policy: V5 });
  assert.equal(v5.policyHash, hash(V5)); assert.equal(batchTools.buildBatchActivity(v5, scope, 'b').events.length, 3);
  assert.throws(() => batchTools.buildBatchActivity({ ...v6, policyHash: hash(V5) }, scope, 'b'), /policy changed/);
  // An added item sale must carry the item's income role and unit; names are allowlisted and unique per batch.
  assert.throws(() => batchTools.validateChoices({ ...sale, activities: [{ ...sale.activities[0], itemKey: 'added-item-0123456789ab' }] }));
  assert.equal(batchTools.validateChoices({ ...sale, activities: [{ ...sale.activities[0], itemKey: 'added-item-0123456789ab', incomeRole: 'careIncome', unit: 'month' }] }).activities[0].unit, 'month');
  for (const bad of [{ name: 'A' }, { name: 'Bad:Name' }, { name: ' Padded' }, { email: 'not an email' }, { phone: 'call me' }, { balance: 5 }])
    assert.throws(() => batchTools.validateChoices({ ...additions('y'), activities: [{ ...additions('y').activities[0], ...bad }] }));
  assert.throws(() => batchTools.validateChoices({ ...additions('y'), activities: [additions('y').activities[0], { ...additions('y').activities[1], name: 'harbour lane clinic y' }] }), /once per batch/);
});

test('a list step keeps its exact role contract and carries no postings', () => {
  const v6 = batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', choices: additions('z') }), activity = batchTools.buildBatchActivity(v6, scope, 'b');
  const step = event => ({ entity: event.entity, txnDate: '2026-12-01', dependencies: [], details: structuredClone(activity.detailProposal.byLogicalKey[event.logicalKey].details) });
  const item = step(activity.events[2]);
  assert.equal(batchTools.batchLifecycle(item).mode, 'list-record');
  for (const mutate of [s => { s.details.listRole.roleKey = 'added-item-000000000000'; }, s => { s.details.listRole.itemType = 'Inventory'; }, s => { s.details.listRole.qtyOnHand = 5; }, s => { s.details.taxMapping = 'salesTax'; }, s => { s.details.incomeMapping = 'careIncome'; }, s => { s.details.lines = [{ amountCents: 1 }]; }, s => { s.dependencies = [{ logicalKey: 'f'.repeat(64) }]; }]) {
    const changed = structuredClone(item); mutate(changed); assert.throws(() => batchTools.batchLifecycle(changed));
  }
  // Field-level tampering is caught by validateActivityBatch's exact rebuild; the lifecycle
  // itself refuses anything outside the allowlist.
  const customer = step(activity.events[0]); customer.details.listRole.name = 'Bad:Name';
  assert.throws(() => batchTools.batchLifecycle(customer), /plain name/);
  const extra = step(activity.events[0]); extra.details.listRole.openingBalance = 5;
  assert.throws(() => batchTools.batchLifecycle(extra));
  const invoice = { entity: 'Invoice', txnDate: '2026-12-01', dependencies: [], details: { ...item.details, activityBatch: { ...item.details.activityBatch, stepKey: 'invoice' }, listRole: { kind: 'item' }, incomeMapping: 'serviceIncome', dueDate: '2026-12-01' } };
  assert.throws(() => batchTools.batchLifecycle(invoice), /list role|lifecycle/);
});

async function calendar(h, throughDate, key) { const p = await h.service.prepare(h.user, { requestKey: key, throughDate }); await h.service.approve(h.user, p.operationId, { planHash: p.planHash }); const result = await h.runtime(p.operationId).execute(); assert.equal(result.complete, true, JSON.stringify(result)); return p; }
async function batch(h, input) { const prepared = await h.service.prepareActivityBatch(h.user, input); await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash }); return h.runtime(prepared.operationId).execute(); }

test('added customer, supplier and item are created, verified, then used by a later batch and the day closes', { timeout: 180000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'lists-november-period-001');
  // A name already used by any customer, supplier or employee is refused before planning.
  const taken = [...h.records.values()].find(row => row.entity === 'Customer').record.DisplayName;
  await assert.rejects(h.service.prepareActivityBatch(h.user, { ...additions('t'), activities: [{ ...additions('t').activities[0], name: taken }] }), /already used/);
  const posts = h.posts, created = await batch(h, additions('001'));
  assert.equal(created.complete, true, JSON.stringify(created)); assert.equal(h.posts, posts + 3);
  const saved = entity => [...h.records.values()].filter(row => row.entity === entity).map(row => row.record).at(-1);
  assert.equal(saved('Customer').DisplayName, 'Harbour Lane Clinic 001'); assert.equal(saved('Customer').PrimaryEmailAddr.Address, 'office@harbourlane.example');
  assert.equal(saved('Item').Type, 'Service'); assert.equal(saved('Item').UnitPrice, 250); assert.equal(saved('Item').IncomeAccountRef.value, h.mappings.serviceIncome);
  for (const record of [saved('Customer'), saved('Vendor'), saved('Item')]) for (const key of ['Balance', 'OpenBalanceDate', 'QtyOnHand', 'ParentRef', 'Job']) assert.ok(!(key in record) || (key === 'Balance' && record[key] === 0), key);
  const options = await h.service.activityOptions(h.user);
  assert.equal(options.addedCustomers.length, 1); assert.equal(options.addedSuppliers.length, 1); assert.equal(options.addedItems[0].incomeRole, 'serviceIncome');
  const customerKey = options.addedCustomers[0].key, vendorKey = options.addedSuppliers[0].key, item = options.addedItems[0];
  const use = { decisionKey: 'use-added-roles-001', purpose: 'Serve the new clinic and pay the new cleaning supplier today.', activities: [
    { type: 'settled-service-sale', customerKey, itemKey: item.key, quantity: 2, unitPriceCents: 25000, incomeRole: item.incomeRole, unit: item.unit, purpose: 'Two site surveys for the new clinic.' },
    { type: 'paid-operating-expense', vendorKey, category: 'premises', amountCents: 12000, purpose: 'Office cleaning by the new supplier.' }] };
  // The income role and unit must be the role's retained capability.
  await assert.rejects(h.service.prepareActivityBatch(h.user, { ...use, decisionKey: 'use-added-wrong-001', activities: [{ ...use.activities[0], incomeRole: 'careIncome' }] }), /retained income role/);
  const used = await batch(h, use);
  assert.equal(used.complete, true, JSON.stringify(used));
  const invoice = saved('Invoice'); assert.equal(invoice.Line[0].SalesItemLineDetail.ItemRef.value, saved('Item').Id); assert.equal(invoice.CustomerRef.value, saved('Customer').Id);
  assert.equal(saved('Bill').VendorRef.value, saved('Vendor').Id);
  await calendar(h, '2026-12-01', 'lists-close-december-first');
  assert.equal(h.data.Calendars[0].verifiedThrough, '2026-12-01');
});

test('a role created in this batch, or changed in QuickBooks after creation, cannot be used', { timeout: 180000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'lists-drift-period-001');
  const created = await batch(h, additions('002')); assert.equal(created.complete, true, JSON.stringify(created));
  const [customer] = (await h.service.activityOptions(h.user)).addedCustomers;
  // Unknown (not yet verified) role keys are refused.
  await assert.rejects(h.service.prepareActivityBatch(h.user, { decisionKey: 'unknown-role-001', purpose: 'Try to use a customer that was never verified.', activities: [{ type: 'settled-service-sale', customerKey: 'added-customer-0123456789ab', itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 1000, purpose: 'Monthly care plan.' }] }), /not a verified accountant-added role/);
  const record = [...h.records.values()].find(row => row.entity === 'Customer' && row.record.DisplayName === customer.name).record;
  record.DisplayName = 'Renamed Elsewhere'; record.SyncToken = String(Number(record.SyncToken) + 1);
  await assert.rejects(h.service.prepareActivityBatch(h.user, { decisionKey: 'drifted-role-001', purpose: 'Use the clinic after someone renamed it in QuickBooks.', activities: [{ type: 'settled-service-sale', customerKey: customer.key, itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 1000, purpose: 'Monthly care plan.' }] }), /changed in QuickBooks/);
});
