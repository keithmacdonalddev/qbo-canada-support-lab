'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessCompilationRuntime } = require('../src/modules/business-compilation-runtime');
const { compileBusinessTransaction } = require('../src/modules/business-transaction-compiler');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { fixture, scope, now, clone } = require('./helpers/business-transaction-fixtures');
const operationId = 'b'.repeat(24), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24), planHash = hash('plan');
const entities = ['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment'];
function harness(entity = 'Estimate') {
  const f = fixture(entity); f.refresh(); f.approve();
  if (['Estimate', 'Invoice', 'SalesReceipt', 'PurchaseOrder', 'Bill'].includes(entity)) {
    const base = f.step.details.baseAmountCents, tax = Math.round(base * 0.13);
    f.policy.readbackTax = { version: 1, totalTaxCents: tax, lines: [{ rateId: '950', percent: 13, taxableCents: base, amountCents: tax }] };
  }
  const h = { f, clock: now, calls: [], queries: [], graphCalls: 0, fenceCalls: 0, active: 0, maximum: 0, graphComplete: true, allowed: true, actor: { actorId, ownerId }, deposits: [] };
  h.intent = { version: 1, scope, operationId, planHash, logicalKey: f.step.logicalKey, entity, kind: 'create', fingerprint: hash(f.step), step: clone(f.step), policy: clone(f.policy), dependencies: clone(f.step.dependencies) };
  h.client = Object.create(QBOClient.prototype);
  Object.defineProperty(h.client, 'apiBase', { value: 'https://sandbox-quickbooks.api.intuit.com/v3/company/123' });
  Object.assign(h.client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    assert.equal(options.method, 'GET'); h.calls.push(options.url); h.active++; h.maximum = Math.max(h.maximum, h.active);
    try {
      if (h.onRead) await h.onRead(options);
      if (options.url.includes('/query?')) {
        const query = new URL(options.url).searchParams.get('query'); h.queries.push(query); if (h.queryBody) return { status: 200, json: await h.queryBody(query) };
        return { status: 200, json: { QueryResponse: { Deposit: clone(h.deposits), startPosition: 1, maxResults: h.deposits.length } } };
      }
      const value = [...f.referenceEvidence, ...f.parents].find(value => options.url.endsWith('/' + value.entity.toLowerCase() + '/' + value.record.Id)); assert.ok(value, options.url);
      return { status: 200, json: { [value.entity]: clone(value.record) } };
    } finally { h.active--; }
  } } });
  h.authorize = async () => { if (!h.allowed) throw new Error('permission revoked'); return clone(h.actor); };
  h.deps = { scope, operationId, planHash, access: { authorize: h.authorize, resolveClient: async () => h.client }, plans: { loadIntent: async () => clone(h.intent) }, steps: {
    verifyGraph: async (_scope, op, roots) => { assert.deepEqual(_scope, scope); assert.equal(op, operationId); assert.deepEqual(roots, h.intent.dependencies.map(value => value.logicalKey)); h.graphCalls++; return { complete: h.graphComplete, persisted: h.graphComplete }; },
    evidence: async (_scope, op, key) => { assert.deepEqual(_scope, scope); assert.equal(op, operationId); const parent = f.parents.find(value => value.logicalKey === key); return { state: 'verified', fresh: true, qboId: parent.qboId, fingerprint: parent.fingerprint, verification: { kind: 'business-readback', observedHash: h.parentHash || parent.recordHash, syncToken: parent.record.SyncToken, observedAt: new Date(now).toISOString() } }; },
  }, verification: {
    readFence: async () => { h.fenceCalls++; if (h.onFence) await h.onFence(); return { scope, operationId, revision: h.writerRevision || 4, unresolved: null }; },
    readRecord: async (_scope, type, id, options) => { const { createBusinessTransactionReader } = require('../src/modules/business-reference'); return createBusinessTransactionReader({ authorize: h.authorize, resolveClient: async () => h.client, now: () => h.clock })(_scope, type, id, options); },
  }, assertReady: async () => {}, now: () => h.clock };
  h.read = signal => createBusinessCompilationRuntime(h.deps)({ scope, operationId, logicalKey: h.intent.logicalKey, intent: clone(h.intent), signal });
  return h;
}
for (const entity of entities) test('loads current observations and preflights ' + entity, async () => {
  const h = harness(entity), values = await h.read(), compiled = compileBusinessTransaction({ scope, step: h.intent.step, policy: h.intent.policy, ...values, now });
  assert.equal(compiled.entity, entity); assert.equal(values.referenceEvidence.length, h.f.referenceEvidence.length); assert.equal(values.parents.length, h.f.parents.length); assert.equal(values.observationFence.writerRevision, 4); assert.ok(h.maximum <= 3);
  assert.equal(h.graphCalls, h.f.parents.length ? 1 : 0); assert.equal(h.queries.length, entity === 'Deposit' ? 2 : 0);
  if (entity === 'Deposit') assert.equal(values.parents[0].availability.status, 'available');
});
test('intent changes, unsupported disposition and company overrides fail before QBO reads', async () => {
  const h = harness(), reader = createBusinessCompilationRuntime(h.deps), base = { scope, operationId, logicalKey: h.intent.logicalKey, intent: clone(h.intent) };
  for (const value of [{ ...base, scope: { ...scope, realmId: '999' } }, { ...base, operationId: 'e'.repeat(24) }, { ...base, intent: { ...base.intent, fingerprint: hash('other') } }]) await assert.rejects(reader(value));
  h.intent.kind = 'existing'; await assert.rejects(h.read()); assert.equal(h.calls.length, 0);
});
test('incomplete dependency graphs stop observations and cannot be used as proof', async () => {
  const h = harness('Invoice'); h.graphComplete = false; await assert.rejects(h.read(), /not completely verified/); assert.equal(h.calls.length, 0);
});
test('changed originating records fail despite a current stored verified status', async () => {
  const h = harness('Invoice'); h.parentHash = hash('old observed content'); await assert.rejects(h.read(), /changed after graph/);
});
test('current customer presentation compiles while missing tax expectations and incompatible parties refuse', async () => {
  const h = harness(); h.f.referenceEvidence.find(value => value.entity === 'Customer').record.DisplayName = 'Changed'; assert.ok((await h.read()).referenceEvidence.length);
  for(const patch of [{CurrencyRef:{value:'USD'}},{IsProject:true},{Active:false}]){const risk=harness();Object.assign(risk.f.referenceEvidence.find(o=>o.entity==='Customer').record,patch);await assert.rejects(risk.read());}
  const tax = harness(); delete tax.intent.policy.readbackTax; await assert.rejects(tax.read(), /tax expectations/);
});
test('writer changes, authority loss and observation deadline stop before dispatch', async () => {
  const writer = harness(); writer.onFence = () => { if (writer.fenceCalls === 2) writer.writerRevision = 5; }; await assert.rejects(writer.read(), /Company activity changed/);
  const permission = harness(); permission.onRead = () => { permission.allowed = false; }; await assert.rejects(permission.read(), /permission revoked/);
  const elapsed = harness(); elapsed.onRead = () => { elapsed.clock += 180001; }; await assert.rejects(elapsed.read(), /budget/);
});
test('cancelled compilation launches no provider calls', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(); await assert.rejects(h.read(controller.signal), /cancelled/); assert.equal(h.calls.length, 0);
});
const deposit = (id, paymentId) => ({ Id: id, SyncToken: '0', Line: [{ Amount: 282.5, ...(paymentId ? { LinkedTxn: [{ TxnId: paymentId, TxnType: 'Payment' }] } : { DepositLineDetail: { AccountRef: { value: '600' } } }) }] });
test('a payment linked to any deposit is unavailable even when its own UI link is absent', async () => {
  const h = harness('Deposit'); h.deposits = [deposit('9000', h.f.parents[0].qboId)]; await assert.rejects(h.read(), /already belongs/); assert.equal(h.queries.length, 1);
});
test('deposit scans must be complete, non-sparse and unchanged across both observations', async () => {
  for (const body of [{}, { QueryResponse: { Warnings: { message: 'partial' } } }, { QueryResponse: { Deposit: [deposit('9000')], startPosition: 2, maxResults: 1 } }, { QueryResponse: { Deposit: [{ ...deposit('9000'), sparse: true }], startPosition: 1, maxResults: 1 } }, { QueryResponse: { Deposit: [deposit('9000'), deposit('9000')], startPosition: 1, maxResults: 2 } }, { QueryResponse: { Deposit: [], totalCount: 1 } }]) {
    const h = harness('Deposit'); h.queryBody = async () => body; await assert.rejects(h.read());
  }
  const h = harness('Deposit'); h.queryBody = async () => ({ QueryResponse: { Deposit: h.queries.length === 1 ? [] : [deposit('9000')], startPosition: 1, maxResults: h.queries.length === 1 ? 0 : 1 } }); await assert.rejects(h.read(), /changed during availability/);
});
test('deposit paging includes later pages and requires an identical complete second scan', async () => {
  const h = harness('Deposit'), firstPage = Array.from({ length: 1000 }, (_, index) => deposit(String(9000 + index)));
  h.queryBody = async query => { const start = Number(query.match(/STARTPOSITION (\d+)/)[1]), rows = start === 1 ? firstPage : [deposit('10000')]; return { QueryResponse: { Deposit: rows, startPosition: start, maxResults: rows.length, totalCount: rows.length } }; }; // QuickBooks counts each page
  const result = await h.read(); assert.equal(result.parents[0].availability.status, 'available'); assert.equal(h.queries.length, 4); assert.match(h.queries[1], /STARTPOSITION 1001/);
});
test('a changed payment after the deposit scan prevents availability proof', async () => {
  const h = harness('Deposit'); h.queryBody = async () => { if (h.queries.length === 2) h.f.parents[0].record.SyncToken = '1'; return { QueryResponse: {} }; };
  await assert.rejects(h.read(), /payment changed/);
});

test('malformed or unrecognized deposit lines cannot establish absence of payment links', async () => {
  for (const line of [null, {}, { Amount: 1 }, { Amount: 1, DetailType: 'AccountBasedExpenseLineDetail', DepositLineDetail: { AccountRef: { value: '600' } } }, { Amount: 1, LinkedTxn: [] }, { Amount: 1, LinkedTxn: [null] }, { Amount: 1, DepositLineDetail: { AccountRef: { value: 600 } } }, { Amount: 1, sparse: true, LinkedTxn: [{ TxnId: '9999', TxnType: 'Payment' }] }]) {
    const h = harness('Deposit'); h.deposits = [{ Id: '9000', SyncToken: '0', Line: [line] }]; await assert.rejects(h.read(), /deposit line|Deposit transaction links/);
  }
});

test('stock compilation reads Item quantity after a prior receipt instead of its definition mirror', async () => {
  const h = harness('SalesReceipt'), item = h.f.referenceEvidence.find(x => x.entity === 'Item' && x.record.Type === 'Inventory');
  const stale = clone(item); stale.record.QtyOnHand = 0; stale.recordHash = hash(stale.record); stale.source.recordHash = stale.recordHash;
  let itemCopies = 0;
  h.deps.observations = { read: async (_scope, entity, id) => { if (entity === 'Item' && id === item.record.Id) { itemCopies++; return stale; } return null; } };
  assert.equal((await h.deps.observations.read(scope, 'Item', item.record.Id)).record.QtyOnHand, 0); itemCopies = 0;
  const values = await h.read();
  assert.equal(itemCopies, 0, 'Stage 1A uses the live inventory GET without a historical definition witness');
  assert.equal(values.referenceEvidence.find(x => x.entity === 'Item' && x.record.Id === item.record.Id).source.kind, 'qbo-full-entity-get');
  assert.equal(values.referenceEvidence.find(x => x.entity === 'Item' && x.record.Id === item.record.Id).record.QtyOnHand, 12);
  item.record.QtyOnHand = 0;
  await assert.rejects(h.read(), /stock availability/);
});

test('execution compilation uses full current Item and TaxCode records without historical witnesses',async()=>{
 const {referenceDefinition}=require('../src/modules/business-reference');
 const h=harness('Estimate'),witnesses=new Map();
 for(const entity of ['Item','TaxCode']) {
  const selected=h.f.referenceEvidence.find(o=>o.entity===entity);
  const retained=clone(selected);
  if(entity==='Item')retained.record.IncomeAccountRef.name='fixture income';
  else retained.record.SalesTaxRateList={TaxRateDetail:[{TaxRateRef:{value:'950',name:'fixture tax'}}]};
  retained.recordHash=hash(retained.record);retained.observedAt=new Date(now-8*86400000).toISOString();
  retained.source={version:1,kind:'qbo-retained-mirror',scope,entity,id:retained.record.Id,recordHash:retained.recordHash,generation:'previous-sync',retainedAt:retained.observedAt};
  witnesses.set(entity+':'+retained.record.Id,retained);
  const binding=h.intent.step.references.find(b=>b.entity===entity&&b.id===retained.record.Id);binding.definition=referenceDefinition(scope,entity,retained.record,1);
  if(entity==='TaxCode'){selected.record.SalesTaxRateList=clone(retained.record.SalesTaxRateList);delete selected.record.SalesTaxRateList.TaxRateDetail[0].TaxRateRef.name;}
 }
 h.intent.fingerprint=hash(h.intent.step);h.intent.policy.stepHash=h.intent.fingerprint;
 h.deps.observations={read:async()=>null,definition:async(_s,entity,id)=>clone(witnesses.get(entity+':'+id)||null)};
 const result=await h.read();
 assert.equal(result.referenceEvidence.filter(o=>o.definitionObservation).length,0);
 assert.equal(compileBusinessTransaction({scope,step:h.intent.step,policy:h.intent.policy,...result,now}).entity,'Estimate');
 h.f.referenceEvidence.find(o=>o.entity==='Item').record.IncomeAccountRef.value='999';
 await assert.rejects(h.read(),/income account changed/);
});


// A current cache record is not necessarily the exact shape hashed by a v1 approval.
function legacyWitnessHarness(entity) {
  const { referenceDefinition } = require('../src/modules/business-reference');
  const h = harness('Estimate'), selected = h.f.referenceEvidence.find(o => o.entity === entity);
  if (entity === 'Item') selected.record.IncomeAccountRef.name = 'Approved income display';
  else selected.record.SalesTaxRateList = { TaxRateDetail: [{ TaxRateRef: { value: '950', name: 'Approved tax display' } }] };
  const retained = clone(selected); retained.recordHash = hash(retained.record);
  retained.observedAt = new Date(now - 8 * 86400000).toISOString();
  retained.source = { version: 1, kind: 'qbo-retained-mirror', scope, entity, id: retained.record.Id, recordHash: retained.recordHash, generation: 'approved-sync', retainedAt: retained.observedAt };
  if (entity === 'Item') delete selected.record.IncomeAccountRef.name;
  else delete selected.record.SalesTaxRateList.TaxRateDetail[0].TaxRateRef.name;
  const binding = h.intent.step.references.find(b => b.entity === entity && b.id === selected.record.Id);
  binding.definition = referenceDefinition(scope, entity, retained.record, 1);
  h.reapprove = () => { h.intent.fingerprint = hash(h.intent.step); h.intent.policy.stepHash = h.intent.fingerprint; };
  h.reapprove();
  h.definitionCalls = 0;
  h.deps.observations = {
    read: async (_scope, type, id) => {
      if (type !== entity || id !== selected.record.Id) return null;
      const cached = clone(selected); cached.recordHash = hash(cached.record);
      cached.source = { version: 1, kind: 'qbo-current-mirror', scope, entity, id, recordHash: cached.recordHash, generation: 'current-sync', completedAt: new Date(now - 1000).toISOString(), freshUntil: new Date(now + 60000).toISOString() };
      return cached;
    },
    definition: async (_scope, type, id) => { if (type !== entity || id !== selected.record.Id) return null; h.definitionCalls++; return clone(h.retained); },
  };
  return Object.assign(h, { selected, retained, binding });
}
for (const entity of ['Item', 'TaxCode']) test('compilation uses current ' + entity + ' evidence despite legacy display-shape drift', async () => {
  const h = legacyWitnessHarness(entity), before = clone(h.intent), result = await h.read();
  const observed = result.referenceEvidence.find(o => o.entity === entity);
  assert.equal(observed.definitionObservation, undefined);
  assert.equal(h.definitionCalls, 0);
  assert.deepEqual(h.intent, before);
  assert.deepEqual(observed.record, h.selected.record);
  assert.equal(compileBusinessTransaction({ scope, step: h.intent.step, policy: h.intent.policy, ...result, now }).entity, 'Estimate');
});
test('historical witness drift is audit-only while incompatible current Item purpose still refuses', async () => {
  for (const change of [
    h => { h.retained = null; },
    h => { h.retained.record.UnitPrice = (h.retained.record.UnitPrice || 0) + 1; h.retained.recordHash = hash(h.retained.record); h.retained.source.recordHash = h.retained.recordHash; },
    h => { h.retained.scope.realmId = '999'; },
    h => { h.retained.source.generation = ''; },
    h => { h.selected.record.UnitPrice = (h.selected.record.UnitPrice || 0) + 1; },
    h => { h.selected.record.FutureDefinitionField = true; },
    h => { h.binding.syncToken = '2'; h.selected.record.SyncToken = '1'; h.reapprove(); },
  ]) {
    const h = legacyWitnessHarness('Item'); change(h); assert.ok((await h.read()).referenceEvidence.length);assert.equal(h.definitionCalls,0);
  }
  for(const patch of [{IncomeAccountRef:{value:'999'}},{Type:'NonInventory'},{Active:false},{sparse:true},{Id:'999'}]){
    const h=legacyWitnessHarness('Item');Object.assign(h.selected.record,patch);await assert.rejects(h.read());
  }
  const foreign=legacyWitnessHarness('Item');foreign.client.connection.realmId='999';
  await assert.rejects(foreign.read());
});

test('an unavailable optional witness does not block an owner-reviewed TaxCode definition', async () => {
  const { referenceDefinition } = require('../src/modules/business-reference');
  const h = legacyWitnessHarness('TaxCode');
  h.intent.policy.taxReferenceDefinitions = h.intent.step.references.filter(b => b.entity === 'TaxCode').map(b => ({ key: b.key, id: b.id, originalDefinitionHash: b.definition.hash, definition: referenceDefinition(scope, 'TaxCode', h.f.referenceEvidence.find(o => o.entity === 'TaxCode' && o.record.Id === b.id).record, 2) }));
  h.deps.observations.definition = async () => { throw new Error('Historical store unavailable'); };
  assert.equal((await h.read()).referenceEvidence.length, h.f.referenceEvidence.length);
});
test('shared physical references use one current observation without a legacy witness', async () => {
  const { referenceDefinition } = require('../src/modules/business-reference');
  const h = legacyWitnessHarness('Item');
  h.intent.step.references.push({ ...clone(h.binding), key: 'same-item-alias', definition: referenceDefinition(scope, 'Item', h.selected.record, 2) });
  h.reapprove();
  const result = await h.read();
  const items=result.referenceEvidence.filter(o=>o.entity==='Item'&&o.record.Id===h.selected.record.Id);assert.equal(items.length,1);assert.equal(items[0].definitionObservation,undefined);assert.equal(h.definitionCalls,0);
  assert.equal(compileBusinessTransaction({scope,step:h.intent.step,policy:h.intent.policy,...result,now}).entity,'Estimate');
});
