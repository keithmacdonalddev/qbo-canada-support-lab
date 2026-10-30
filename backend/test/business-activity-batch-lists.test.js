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
  assert.equal(saved('Item').Type, 'Service'); assert.equal(saved('Item').UnitPrice, 250); assert.equal(saved('Item').Description, 'A new fixed-price site survey service.'); assert.equal(saved('Item').IncomeAccountRef.value, h.mappings.serviceIncome);
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
  // Any change to its verified definition refuses use, not only the requested fields.
  const sale = decisionKey => ({ decisionKey, purpose: 'Use the clinic after someone changed it in QuickBooks.', activities: [{ type: 'settled-service-sale', customerKey: customer.key, itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 1000, purpose: 'Monthly care plan.' }] });
  const original = structuredClone(record), parent = [...h.records.values()].find(row => row.entity === 'Customer' && row.record.Id !== record.Id).record;
  for (const [index, drift] of [{ ParentRef: { value: parent.Id }, Job: true, BillWithParent: true }, { PrimaryEmailAddr: { Address: 'billing@elsewhere.example' } }].entries()) {
    Object.assign(record, structuredClone(drift), { SyncToken: String(Number(record.SyncToken) + 1) });
    await assert.rejects(h.service.prepareActivityBatch(h.user, sale('drifted-definition-00' + index)), /changed in QuickBooks/);
    for (const key of Object.keys(record)) delete record[key]; Object.assign(record, structuredClone(original));
  }
  record.DisplayName = 'Renamed Elsewhere'; record.SyncToken = String(Number(record.SyncToken) + 1);
  await assert.rejects(h.service.prepareActivityBatch(h.user, { decisionKey: 'drifted-role-001', purpose: 'Use the clinic after someone renamed it in QuickBooks.', activities: [{ type: 'settled-service-sale', customerKey: customer.key, itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 1000, purpose: 'Monthly care plan.' }] }), /changed in QuickBooks/);
});

const LIST_ENTITIES = ['Customer', 'Vendor', 'Item'];
const expense = (decisionKey, vendorKey = 'overhead-supplier-1') => ({ decisionKey, purpose: 'Pay the premises charge that came due today for the office.', activities: [{ type: 'paid-operating-expense', vendorKey, category: 'premises', amountCents: 5000, purpose: 'Premises service charge for the office.' }] });
test('anomalous added records are reported as unusable without blocking unrelated activity; capacity is checked at preparation', { timeout: 180000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'lists-anomaly-period-001');
  const created = await batch(h, additions('004')); assert.equal(created.complete, true, JSON.stringify(created));
  const before = await h.service.activityOptions(h.user), supplierKey = before.addedSuppliers[0].key;
  assert.deepEqual(before.unusableAddedRecords, []); assert.deepEqual(before.addedRecordCapacity, { used: 3, limit: 1000 });
  const step = entity => h.data.Steps.find(row => row.entity === entity && row.state === 'verified');
  // Forged or foreign creation evidence: a missing read-back proof; a request rescoped to another company.
  step('Customer').verification.evidenceHash = null;
  step('Item').compilation.request.scope = { ...step('Item').compilation.request.scope, realmId: '999' };
  // Two registry entries claiming one supplier record and role.
  h.data.Steps.push({ ...structuredClone(step('Vendor')), _id: 'zz' + 'd'.repeat(22) });
  const options = await h.service.activityOptions(h.user);
  assert.equal(options.addedCustomers.length + options.addedSuppliers.length + options.addedItems.length, 0);
  const reasons = Object.fromEntries(['customer', 'item'].map(kind => [kind, options.unusableAddedRecords.find(row => row.kind === kind)?.reason]));
  assert.match(reasons.customer, /read-back verification proof/); assert.match(reasons.item, /creation request is invalid/);
  assert.equal(options.unusableAddedRecords.filter(row => row.kind === 'supplier' && /same role or QuickBooks record/.test(row.reason)).length, 2);
  // Unrelated activity still prepares; the unusable supplier is refused with its reason.
  assert.ok((await h.service.prepareActivityBatch(h.user, expense('unrelated-expense-001'))).operationId);
  await assert.rejects(h.service.prepareActivityBatch(h.user, expense('duplicated-supplier-001', supplierKey)), /cannot be used: another added record/);
  // Additions go in their own batch.
  await assert.rejects(h.service.prepareActivityBatch(h.user, { ...additions('005'), activities: [additions('005').activities[0], expense('x').activities[0]] }), /own batch/);
  // Capacity: 998 entries leave room for two additions, not three.
  const base = step('Customer'), count = () => h.data.Steps.filter(row => LIST_ENTITIES.includes(row.entity)).length;
  const fill = target => { for (let n = count(); n < target; n++) h.data.Steps.push({ _id: 'zz' + String(n).padStart(22, '0'), contractVersion: 1, realmId: base.realmId, environment: base.environment, connectionId: base.connectionId, operationId: 'f'.repeat(24), planHash: 'e'.repeat(64), logicalKey: hash({ capacityFiller: n }), fingerprint: hash({ filler: n }), entity: 'Customer', state: 'saved', dependencies: [] }); };
  fill(998);
  await assert.rejects(h.service.prepareActivityBatch(h.user, additions('006')), /room for 2 more/);
  assert.ok((await h.service.prepareActivityBatch(h.user, { ...additions('007'), activities: additions('007').activities.slice(0, 2) })).operationId);
  // Over capacity, additions are refused but nothing else is blocked.
  fill(1010);
  const full = await h.service.activityOptions(h.user);
  assert.deepEqual(full.addedRecordCapacity, { used: 1001, limit: 1000 }); assert.equal(full.unusableAddedRecords.length, 50);
  await assert.rejects(h.service.prepareActivityBatch(h.user, { ...additions('008'), activities: additions('008').activities.slice(0, 1) }), /room for 0 more/);
  assert.ok((await h.service.prepareActivityBatch(h.user, expense('unrelated-expense-002'))).operationId);
});

test('a name taken in QuickBooks after approval is refused before dispatch; apostrophes are escaped', { timeout: 180000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'lists-dispatch-name-001');
  const name = "O'Brien Family Dental", input = { decisionKey: 'add-obrien-001', purpose: 'Grow the business with a new dental clinic client.', activities: [{ type: 'add-customer', name, purpose: 'A new dental clinic signed a service agreement.' }] };
  const prepared = await h.service.prepareActivityBatch(h.user, input);
  await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  // Someone creates the same name in QuickBooks (as a supplier: one shared name space).
  h.records.set('vendor:990001', { entity: 'Vendor', record: { Id: '990001', SyncToken: '0', Active: true, DisplayName: name } });
  const posts = h.posts, outcome = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(outcome.complete, true, JSON.stringify(outcome)); assert.equal(h.posts, posts);
  assert.equal([...h.records.values()].filter(row => ['Customer', 'Vendor'].includes(row.entity) && row.record.DisplayName === name).length, 1);
});

const CREATED = ['dispatched', 'unknown', 'saved', 'verified'];
const createdLists = h => h.data.Steps.filter(row => LIST_ENTITIES.includes(row.entity) && CREATED.includes(row.state)).length;
const fillRegistry = (h, target) => { for (let n = createdLists(h); n < target; n++) h.data.Steps.push({ _id: 'zz' + String(n).padStart(22, '0'), contractVersion: 1, ...scope, operationId: 'f'.repeat(24), planHash: 'e'.repeat(64), logicalKey: hash({ capacityFiller: n }), fingerprint: hash({ filler: n }), entity: 'Customer', state: 'saved', dependencies: [] }); };
const outcomeText = (h, operationId, outcome) => JSON.stringify(outcome) + String(h.data.Runs.find(row => String(row._id) === operationId)?.lastError || '');

test('a mixed batch saved and approved before the own-batch rule is refused at approval and before any write', { timeout: 180000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'lists-saved-mixed-period-001');
  const roles = require('../src/modules/business-added-roles'), original = roles.assertListOnlyBatch, legacy = async action => { roles.assertListOnlyBatch = () => {}; try { return await action(); } finally { roles.assertListOnlyBatch = original; } };
  // Simulate the earlier code: preparation and approval without the own-batch rule.
  const prepared = await legacy(() => h.service.prepareActivityBatch(h.user, { ...additions('010'), activities: [additions('010').activities[0], expense('x').activities[0]] }));
  await assert.rejects(h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash }), /own batch/);
  await legacy(() => h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash }));
  // Repeating approval of the already approved operation is refused too.
  await assert.rejects(h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash }), /own batch/);
  const posts = h.posts, outcome = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(outcome.complete, true, JSON.stringify(outcome)); assert.match(outcomeText(h, prepared.operationId, outcome), /own batch/);
  assert.equal(h.posts, posts); assert.equal(createdLists(h), 0);
});

test('an approved addition batch is rechecked at approval and before each write and never exceeds capacity', { timeout: 180000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'lists-capacity-dispatch-001');
  fillRegistry(h, 997);
  const prepared = await h.service.prepareActivityBatch(h.user, additions('011'));
  // Two records created elsewhere after preparation: approval refuses three more.
  fillRegistry(h, 999);
  await assert.rejects(h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash }), /room for 1 more/);
  h.data.Steps.splice(h.data.Steps.length - 2, 2); assert.equal(createdLists(h), 997);
  await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  // One record created elsewhere after approval: only two of the three are sent.
  fillRegistry(h, 998);
  const posts = h.posts, outcome = await h.runtime(prepared.operationId).execute().catch(error => ({ error: error.message }));
  assert.notEqual(outcome.complete, true, JSON.stringify(outcome)); assert.match(outcomeText(h, prepared.operationId, outcome), /registry is full/);
  assert.equal(h.posts, posts + 2); assert.equal(createdLists(h), 1000);
});

test('a role needs its transport receipt, its verification audit and its operation\'s recomputed completion proof', { timeout: 180000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'lists-evidence-period-001');
  const created = await batch(h, additions('012')); assert.equal(created.complete, true, JSON.stringify(created));
  const usable = async () => { const options = await h.service.activityOptions(h.user); return { count: options.addedCustomers.length + options.addedSuppliers.length + options.addedItems.length, reasons: Object.fromEntries(options.unusableAddedRecords.map(row => [row.kind, row.reason])) }; };
  assert.deepEqual(await usable(), { count: 3, reasons: {} });
  const step = entity => h.data.Steps.find(row => row.entity === entity && row.state === 'verified');
  const take = (rows, match) => { const index = rows.findIndex(match); assert.ok(index >= 0); return rows.splice(index, 1)[0]; };
  const receiptRow = entity => h.data.Receipts.find(row => row.dispatchKey === step(entity).dispatch.key);
  // Receipt evidence cleared; observed record hash changed; transport receipt row deleted.
  const saved = { receipt: step('Customer').receipt.evidenceHash, observed: step('Vendor').verification.observedHash };
  step('Customer').receipt.evidenceHash = null; step('Vendor').verification.observedHash = 'e'.repeat(64);
  const transport = take(h.data.Receipts, row => row.dispatchKey === step('Item').dispatch.key);
  let state = await usable();
  assert.equal(state.count, 0); assert.match(state.reasons.customer, /creation receipt does not match its dispatch/);
  assert.match(state.reasons.supplier, /read-back proof does not match its receipt and observed record/); assert.match(state.reasons.item, /creation receipt or transport audit is missing or changed/);
  // A different but well-formed receipt hash no longer matches the recomputed read-back proof.
  step('Customer').receipt.evidenceHash = 'e'.repeat(64); assert.match((await usable()).reasons.customer, /read-back proof does not match its receipt/);
  step('Customer').receipt.evidenceHash = saved.receipt; step('Vendor').verification.observedHash = saved.observed; h.data.Receipts.push(transport);
  assert.deepEqual(await usable(), { count: 3, reasons: {} });
  // The step's verification audit, or a transport audit, deleted.
  const stepAudit = take(h.data.Audits, row => row._id === step('Customer').lastAuditId), transportAudit = take(h.data.Audits, row => row._id === receiptRow('Vendor').resultAuditId);
  state = await usable();
  assert.equal(state.count, 1); assert.match(state.reasons.customer, /verification audit record is missing or differs/); assert.match(state.reasons.supplier, /creation receipt or transport audit/);
  h.data.Audits.push(stepAudit, transportAudit); assert.equal((await usable()).count, 3);
  // Completion assertions removed from the stored proof, or the completion audit deleted.
  const operationId = String(step('Item').operationId), evidence = h.data.Evidence.find(row => String(row.operationId) === operationId), assertions = evidence.proof.assertions;
  evidence.proof.assertions = [];
  state = await usable(); assert.equal(state.count, 0); for (const kind of ['customer', 'supplier', 'item']) assert.match(state.reasons[kind], /completion evidence is missing or changed/);
  evidence.proof.assertions = assertions;
  const run = h.data.Runs.find(row => String(row._id) === operationId), completionAudit = take(h.data.Audits, row => row._id === String(run.verification.completionAuditId));
  state = await usable(); assert.equal(state.count, 0); assert.match(state.reasons.item, /completion evidence is missing or changed/);
  h.data.Audits.push(completionAudit); assert.deepEqual(await usable(), { count: 3, reasons: {} });
});
