'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createCaseBusiness, fenceCaseCreate, fenceCaseWorkflow, settleCaseGeneralResult, recentCaseTypes } = require('../src/modules/reproduction-business');
const { runEngine } = require('../src/modules/reproduction-engine');
const { createGeneralWriteService } = require('../src/modules/general-write-service');
const { claimWriteWorkflow } = require('../src/modules/qbo-write-workflow');
const DAY = '2026-10-31', id = c => c.repeat(24);
const scope = { environment: 'sandbox', realmId: '123', connectionId: id('a') };
const clone = value => structuredClone(value);
const chain = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, session() { return this; }, lean: async () => clone(value) });
function runs() {
  const rows = new Map();
  return { rows, findOne(filter) { return chain([...rows.values()].find(row => Object.entries(filter).every(([k,v]) => k === 'owned' ? row.owned.some(item => Object.entries(v.$elemMatch).every(([key, value]) => item[key] === value)) : row[k] === v)) || null); },
    async create([row]) { rows.set(row._id, { batches: [], items: {}, owned: [], dirty: [], revision: 0, ...clone(row) }); },
    findOneAndUpdate(filter, update) { const row = rows.get(filter._id); if (!row || row.revision !== filter.revision) return chain(null); Object.assign(row, clone(update.$set)); row.revision++; return chain(row); } };
}
function fixture({ enabled = true, unknown = false } = {}) {
  const session = { _id: id('b'), userId: id('c'), realmId: scope.realmId };
  const state = { status: 'running', runId: 'run-1', environment: scope.environment, connectionId: scope.connectionId, actorId: id('c'), ownedRecords: [], authorization: 'connected-company-case-request-v1' };
  const plan = { _id: id('d'), sessionId: session._id, userId: session.userId, realmId: scope.realmId, steps: [] };
  const records = new Map([['Invoice:20', { Id: '20', SyncToken: '0', DocNumber: 'INV-20', Balance: 25, TotalAmt: 100 }]]), writes = [], events = [];
  let next = 100, active = true;
  const qbo = { async read(type, qboId) { const entity = [...records.keys()].find(key => key.toLowerCase() === type + ':' + qboId)?.split(':')[0]; return { [entity]: clone(records.get(entity + ':' + qboId)) }; },
    async create(type, payload) {
      const workflow = claimWriteWorkflow(); assert.equal(workflow.workflow.kind, 'reproduction');
      assert.ok(plan.steps.at(-1).result.generalWriteRunId, 'general identity saved before dispatch');
      await workflow.onDispatch({ version: 1, receiptId: 'e'.repeat(64), dispatchKey: 'f'.repeat(64), requestHash: '9'.repeat(64), scope });
      const entity = type[0].toUpperCase() + type.slice(1), record = { ...clone(payload), Id: String(++next), SyncToken: '0', MetaData: { CreateTime: DAY + 'T12:00:00Z', LastUpdatedTime: DAY + 'T12:00:00Z' } };
      records.set(entity + ':' + record.Id, record); writes.push(record);
      if (unknown) throw new Error('Lost response');
      return { [entity]: record };
    }, async query() { return { QueryResponse: {} }; } };
  qbo.apiCall = async (_method, endpoint, payload) => {
    const workflow = claimWriteWorkflow(); assert.equal(workflow.workflow.kind, 'reproduction');
    await workflow.onDispatch({ version: 1, receiptId: 'e'.repeat(64), dispatchKey: 'f'.repeat(64), requestHash: '9'.repeat(64), scope });
    const entity = endpoint.startsWith('invoice') ? 'Invoice' : 'Customer', key = entity + ':' + payload.Id, prior = records.get(key);
    if (endpoint.includes('operation=delete')) { records.delete(key); return { [entity]: { Id: payload.Id, status: 'Deleted' } }; }
    const record = { ...clone(prior), ...clone(payload), SyncToken: String(Number(prior.SyncToken) + 1) };
    if (endpoint.includes('void')) { record.status = 'Voided'; record.PrivateNote = 'Voided'; record.TotalAmt = 0; record.Balance = 0; record.Line = record.Line.map(line => ({ ...line, Amount: 0, SalesItemLineDetail: { ...line.SalesItemLineDetail, Qty: 0 } })); }
    records.set(key, record); return { [entity]: record };
  };
  const models = { GeneralWriteRuns: runs(), Steps: { findOne: () => chain(null) } };
  const generalFactory = options => createGeneralWriteService({ models, copy: { read: async (_s, entity, qboId) => records.get(entity + ':' + qboId) || null }, contextFor: async () => ({ day: DAY, verifiedThrough: '2026-10-30', taxCodes: { sales: ['7'], purchases: ['7'] }, taxPercent: { 7: 15 } }), transport: options.caseTransport, caseWrites: true, dispatchEnabled: () => enabled });
  const persist = async () => events.push(clone(plan.steps));
  const assertActive = async () => { if (!active) throw new Error('Stopped'); };
  const business = createCaseBusiness({ session, state, plan, qbo, assertActive, persist, generalFactory, settleResult: input => settleCaseGeneralResult({ ...input, Runs: models.GeneralWriteRuns, retain: async () => {} }), query: { run: async () => ({ success: true, data: { rows: [{ entity: 'Invoice', id: '20', Balance: 25 }], freshness: { status: 'current' } } }) } });
  return { session, state, plan, records, writes, events, models, business, stop() { active = false; },
    options: { state, plan, qbo, persist, assertActive, audit: async () => ({}), messages: [], caseBusiness: business } };
}
const define = tool => tool('defineCase', { title: 'Partial invoice', scenario: 'Find an existing partially paid invoice', conditions: ['Invoice balance is 25'] });
const find = tool => tool('queryCompanyData', { mode: 'find', entities: ['Invoice'], where: [{ field: 'Balance', op: 'gt', value: 0 }] });
const create = tool => tool('createRecord', { entityType: 'Customer', record: { DisplayName: 'Case customer', Active: true }, summary: 'Create isolated case customer' });

test('search first, offer a fresh existing invoice and verify it with zero writes; never acquire edit authority', async () => {
  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool);
    assert.match((await create(tool)).error, /First search/);
    assert.equal((await find(tool)).success, true);
    const offered = await tool('offerExistingRecords', { records: [{ entityType: 'Invoice', id: '20' }], reason: 'Existing partial collection' });
    assert.equal(offered.records[0].docNumber, 'INV-20');
    assert.equal((await tool('checkCase', { condition: 1, sources: [{ entityType: 'Invoice', id: '20', path: 'Balance' }], aggregate: 'single', operator: 'equal', expected: 25 })).passed, true);
    assert.equal((await tool('updateRecord', { entityType: 'Invoice', id: '20', changes: { PrivateNote: 'edit' } })).success, false);
    await tool('finishCase', { outcome: 'reproduced', summary: 'See QuickBooks invoice INV-20, remaining balance $25', tests: [], limitations: [] });
  } });
  assert.equal(f.state.outcome, 'reproduced'); assert.equal(f.writes.length, 0); assert.deepEqual(f.state.ownedRecords, []);
  assert.equal(f.state.existingRecords[0].id, '20');
});
test('unsearched records and unconfirmed evidence cannot be offered', async () => {
  const f = fixture();
  await assert.rejects(f.business.offerExistingRecords({ records: [{ entityType: 'Invoice', id: '20' }], reason: 'example' }), /returned by queryCompanyData/);
  await f.business.queryCompanyData({ mode: 'find' }); f.records.delete('Invoice:20');
  await assert.rejects(f.business.offerExistingRecords({ records: [{ entityType: 'Invoice', id: '20' }], reason: 'example' }), /confirmed/);
});
test('case create goes through the real general service and retains reproduction dispatch and general identity', async () => {
  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool); await find(tool); const result = await create(tool);
    assert.equal(result.success, true, JSON.stringify(result));
    await tool('finishCase', { outcome: 'unverified', summary: 'Customer created in QuickBooks', tests: [], limitations: [] });
  } });
  assert.equal(f.writes.length, 1); assert.equal(f.models.GeneralWriteRuns.rows.size, 1);
  assert.equal([...f.models.GeneralWriteRuns.rows.values()][0].status, 'complete');
  assert.ok(f.plan.steps[0].writeDispatch.receiptId); assert.ok(f.plan.steps[0].result.generalWriteRunId);
  assert.deepEqual(f.state.ownedRecords.map(row => row.id), ['101']);
});
test('held general dispatch is definite and does not turn unsent work into an unknown case', async () => {
  const f = fixture({ enabled: false });
  await runEngine({ ...f.options, runModel: async (_m, tool) => { await define(tool); await find(tool); assert.equal((await create(tool)).success, false); await tool('finishCase', { outcome: 'unverified', summary: 'Dispatch held', tests: [], limitations: [] }); } });
  assert.equal(f.writes.length, 0); assert.equal(f.plan.steps[0].result.outcomeUnknown, false); assert.ok(f.plan.steps[0].result.generalWriteRunId);
});
test('lost response stops the case and retains exact reproduction dispatch plus general identity for existing recovery', async () => {
  const f = fixture({ unknown: true });
  await runEngine({ ...f.options, runModel: async (_m, tool) => { await define(tool); await find(tool); assert.equal((await create(tool)).success, false); assert.equal((await create(tool)).success, false); } });
  assert.equal(f.writes.length, 1); assert.equal(f.state.outcomeUnknown, true); assert.equal(f.plan.steps[0].result.outcomeUnknown, true);
  assert.ok(f.plan.steps[0].writeDispatch.receiptId); assert.ok(f.plan.steps[0].result.generalWriteRunId);
});
test('ordinary general executor cannot send an orphaned case run or adopt its identity', async () => {
  const f = fixture({ enabled: false });
  await runEngine({ ...f.options, runModel: async (_m, tool) => { await define(tool); await find(tool); await create(tool); await tool('finishCase', { outcome: 'unverified', summary: 'Held', tests: [], limitations: [] }); } });
  const run = [...f.models.GeneralWriteRuns.rows.values()][0];
  const api = createGeneralWriteService({ models: f.models, copy: {}, contextFor: async () => ({}), transport: { sendBatch: () => assert.fail('Must not dispatch') }, dispatchEnabled: () => true });
  await assert.rejects(api.execute({ scope, ownerId: f.session.userId, actorId: f.state.actorId }, run._id), /different case authority/);
  await assert.rejects(api.execute({ scope, ownerId: f.session.userId, actorId: f.state.actorId, caseAuthority: run.caseAuthority }, run._id), /different case authority/);
});

function admission() {
  const f = fixture(), payload = { DisplayName: 'Case customer', Active: true };
  f.state.planId = f.plan._id;
  const step = { stepNumber: 1, toolName: 'createRecord', status: 'executing', toolInput: { entityType: 'Customer', record: clone(payload) }, result: { generalWriteRunId: '0'.repeat(24) } }; f.plan.steps.push(step);
  const run = { _id: '0'.repeat(24), ...scope, ownerId: f.session.userId, actorId: f.state.actorId, status: 'sending', caseAuthority: { version: 1, caseId: f.session._id, planId: f.plan._id, runId: f.state.runId, stepNumber: 1 }, plan: { operations: [{ ref: 'case-record', op: 'create', entity: 'Customer', payload }] }, batches: [{ state: 'sending', items: [{ ref: 'case-record', op: 'create', operation: 'create', entity: 'Customer', payload }] }] };
  let touched = 0, guarded = 0;
  const Sessions = { findOne: filter => { assert.equal(filter['reproduction.stopRequested'].$ne, true); assert.equal(filter['reproduction.connectionId'], scope.connectionId); assert.equal(filter['reproduction.runId'], f.state.runId); return chain(f.state.status === 'running' ? { reproduction: f.state } : null); }, updateOne: async () => { touched++; return { matchedCount: 1 }; } };
  const Plans = { findOne: () => chain(f.plan) }, Runs = { findOne: filter => { assert.equal(filter.realmId, scope.realmId); return chain(run); } };
  return { f, run, step, args: { workflow: { sessionId: f.session._id, planId: f.plan._id, stepNumber: 1 }, scope, ownerId: f.session.userId, actorId: f.state.actorId, request: { operation: 'create', entity: 'customer', body: JSON.stringify(payload) }, periodProof: {}, session: {}, now: Date.now(), Plans, Runs, Sessions, guard: async () => { guarded++; } }, count: () => ({ touched, guarded }) };
}
test('admission fences exact payload, current case, ownership and guard snapshot before sending', async () => {
  const a = admission();
  await fenceCaseCreate({ ...a.args, run: a.run, batch: a.run.batches[0] });
  a.run.plan.operations[0].payload.DisplayName = 'Changed';
  await assert.rejects(fenceCaseCreate({ ...a.args, run: a.run, batch: a.run.batches[0] }), /exact create/);
  a.run.plan.operations[0].payload.DisplayName = 'Case customer'; a.f.state.status = 'stopped';
  await assert.rejects(fenceCaseCreate({ ...a.args, run: a.run, batch: a.run.batches[0] }), /no longer authorizes/);
});
test('workflow admission invokes the shared general guard in the same transaction', async () => {
  const a = admission();
  // Inject session read to keep this entirely in memory.
  await fenceCaseWorkflow(a.args);
  assert.equal(a.count().guarded, 1);
});
test('recent case demand stays scoped and bounded and never grants accountant case authority', async () => {
  let filter, limit;
  const Sessions = { find(value) { filter = value; const q = chain([{ reproduction: { title: 'Partial payment', conditions: ['Remaining balance'] } }, { reproduction: { title: 'Partial payment', conditions: [] } }]); q.limit = n => { limit = n; return q; }; return q; } };
  const result = await recentCaseTypes({ ...scope, ownerId: id('c') }, { Sessions, now: Date.parse(DAY) });
  assert.equal(filter.userId, id('c')); assert.equal(filter['reproduction.connectionId'], scope.connectionId); assert.equal(filter['reproduction.environment'], scope.environment);
  assert.equal(limit, 20); assert.equal(result.types[0].cases, 2); assert.match(result.guidance, /no additional authority/);
});

function invoiceFixture() {
  const f = fixture();
  f.state.ownedRecords.push({ entityType: 'Customer', id: '1' });
  for (const [key, record] of [
    ['Customer:1', { Id: '1', DisplayName: 'Isolated case party', Active: true, CurrencyRef: { value: 'CAD' } }],
    ['Item:40', { Id: '40', Name: 'Field hour', Type: 'Service', Active: true }],
    ['TaxCode:7', { Id: '7',SyncToken:'0', Active: true,SalesTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:'8'},TaxTypeApplicable:'TaxOnAmount'}]},PurchaseTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:'8'},TaxTypeApplicable:'TaxOnAmount'}]} }],
    ['TaxRate:8', { Id: '8',SyncToken:'0',Active:true,RateValue:15,EffectiveTaxRate:[{EffectiveDate:'2020-01-01',RateValue:15}] }],
  ]) f.records.set(key, record);
  f.models.GeneralWriteRuns.find = () => chain([...f.models.GeneralWriteRuns.rows.values()]);
  return f;
}
const invoicePayload = () => ({ TxnDate: DAY, DueDate: '2026-11-30', CustomerRef: { value: '1' }, GlobalTaxCalculation: 'TaxExcluded', Line: [{ Amount: 200, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 2, UnitPrice: 100, TaxCodeRef: { value: '7' } } }] });
for (const operation of ['updateRecord', 'voidTransaction', 'deleteRecord']) test('case create -> ' + operation + ' leaves the latest governed close version', async () => {
  const f = invoiceFixture();
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool); await find(tool);
    const made = await tool('createRecord', { entityType: 'Invoice', record: invoicePayload(), summary: 'Set up a case invoice' });
    assert.equal(made.success, true, JSON.stringify(made));
    const changed = await tool(operation, { entityType: 'Invoice', id: made.data.id, summary: 'Perform the case experiment', ...(operation === 'updateRecord' ? { changes: { PrivateNote: 'Case edit' } } : {}) });
    assert.equal(changed.success, true, JSON.stringify(changed));
    await tool('finishCase', { outcome: 'unverified', summary: 'Saved case experiment', tests: [], limitations: [] });
  } });
  assert.equal(f.state.status, 'completed', f.state.summary);
  const view = await require('../src/modules/general-write-day-close').generalRecordsFor({ Runs: f.models.GeneralWriteRuns, scope, day: DAY, copy: { read: async (_s, entity, qboId) => f.records.get(entity + ':' + qboId) } });
  assert.equal(view.records.length, 1);
  const row = view.records[0];
  assert.equal(row.evidence.accountant.operation, { updateRecord: 'update', voidTransaction: 'void', deleteRecord: 'delete' }[operation]);
  assert.equal(require('../src/modules/general-write-close').classifyRecord(row).kind, 'accountant');
});
test('read-only reconciliation settles the original general identity and removes its unsettled-close barrier', async () => {
  const f = fixture({ unknown: true });
  await runEngine({ ...f.options, runModel: async (_m, tool) => { await define(tool); await find(tool); await create(tool); } });
  const step = f.plan.steps[0], record = f.records.get('Customer:101');
  await settleCaseGeneralResult({ step, scope, caseId: f.session._id, planId: f.plan._id, Runs: f.models.GeneralWriteRuns,
    decision: { status: 'completed', generalRecord: record, result: { success: true, data: { id: '101' } } }, retain: async () => {} });
  const row = [...f.models.GeneralWriteRuns.rows.values()][0];
  assert.equal(row.status, 'complete'); assert.equal(row.batches[0].state, 'answered'); assert.equal(row.items['case-record'].qboId, '101');
});


test('a persistence conflict after QuickBooks saved stays unknown and cannot retire a saved receipt', async () => {
  const f = fixture(), Runs = f.models.GeneralWriteRuns, update = Runs.findOneAndUpdate;
  Runs.findOneAndUpdate = (filter, changes) => {
    if (changes.$set?.items?.['case-record']?.outcome === 'saved') throw Object.assign(new Error('Concurrent receipt update'), { status: 409, code: 'GENERAL_WRITE_REFUSED' });
    return update(filter, changes);
  };
  await runEngine({ ...f.options, runModel: async (_m, tool) => { await define(tool); await find(tool); await create(tool); } });
  assert.equal(f.writes.length, 1); assert.equal(f.state.outcomeUnknown, true); assert.equal(f.plan.steps[0].result.outcomeUnknown, true);
  await assert.rejects(settleCaseGeneralResult({ step: f.plan.steps[0], scope, caseId: f.session._id, planId: f.plan._id, Runs,
    Receipts: { find: () => chain([{ state: 'saved' }]) }, decision: { status: 'failed' } }), /durable rejection/);
});
