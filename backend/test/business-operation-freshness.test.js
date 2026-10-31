'use strict';
// Chronological v8 builders -> real compilation runtime -> simulated save ->
// period GET guard -> real graph verifier, under ONE writer operation per fixture.
// This seam permits earlier source dates in one operation. Governance still refuses
// preparing an own settlement against a source from today (covered separately).
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, scope, ownerId } = require('./helpers/business-governance-fixture');
const { hash } = require('../src/modules/business-calendar');
const { bindBusinessReference } = require('../src/modules/business-reference');
const { createBusinessObservationStore } = require('../src/modules/business-observation-store');
const { createBusinessVerificationRuntime } = require('../src/modules/business-verification-runtime');
const { createBusinessCompilationRuntime } = require('../src/modules/business-compilation-runtime');
const { compileBusinessTransaction } = require('../src/modules/business-transaction-compiler');
const { readWritePeriodEvidence } = require('../src/modules/qbo-write-period');
const { makeActivityBatch, buildBatchActivity } = require('../src/modules/business-activity-batch');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const clone = value => structuredClone(value), purpose = 'Realistic chronological lifecycle fixture.', cents = n => Math.round(n * 100);
const care = { type: 'invoice-on-terms', customerKey: 'care-client-002', itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 25000, termsDays: 30, purpose };
const field = { type: 'settled-service-sale', customerKey: 'field-client-001', itemKey: 'field-service-hour', quantity: 2, unitPriceCents: 9000, purpose };
const billChoice = { type: 'bill-on-terms', vendorKey: 'overhead-supplier-2', category: 'utilities', amountCents: 40000, termsDays: 30, purpose };
function chain(name, options = {}) {
  const h = fixture({ activityTemplateVersion: 3, openingDate: '2026-11-01', ...options });
  const operationId = 'e'.repeat(24), planHash = hash(name), intents = new Map(), frozen = new Map();
  let revision = 0, index = 0, mirrorHits = 0, graphGets = 0, compilationGets = 0, itemGets = 0;
  const observe = (entity, record) => ({ scope, entity, record: clone(record), recordHash: hash(record), observedAt: new Date(h.clock).toISOString() });
  const q = value => ({ maxTimeMS() { return this; }, lean: async () => clone(value) });
  // A genuinely active store with a current CDC watermark can still contain a
  // computed field from the create representation. Its generation/time is valid.
  const store = createBusinessObservationStore({ now: () => h.clock,
    Agents: { findOne: () => q({ ...scope, sync: { sources: Object.fromEntries([...new Set([...frozen.values()].map(x => x.entity))].map(entity => [entity, { entity, status: 'current', phase: 'incremental', mode: 'cdc', generation: 'fixture', since: new Date(h.clock - 2000).toISOString(), lastSuccessAt: new Date(h.clock).toISOString(), everyMs: 60000 }])) } }) },
    Records: { findOne: f => { const value = frozen.get(f.entity + ':' + f.qboId); if (value) mirrorHits++; return q(value ? { ...scope, entity: f.entity, qboId: f.qboId, generation: 'fixture', deleted: false, record: value.record } : null); } },
    Receipts: { findOne: () => q(null) }, Audits: {}, Writers: {} });
  const access = { authorize: async () => ({ ownerId, actorId: ownerId }), resolveClient: async () => h.client };
  const plans = { loadIntent: async (_s, _o, key) => clone(intents.get(key)) };
  const verification = createBusinessVerificationRuntime({ scope, operationId, planHash, Steps: h.models.Steps, transaction: h.transaction, assertReady: async () => {}, access,
    writerFence: { graphSnapshot: async () => ({ scope, operationId, revision, unresolved: null }) }, plans, observations: store, retainSources: true, now: () => h.clock });
  const persist = async roots => {
    if (!h.data.Steps.length) return;
    const graph = await verification.loadGraphReadback({ scope, roots });
    graphGets += graph.recordCount;
    assert.equal(graph.complete, true, JSON.stringify(graph.failures));
    for (const value of graph.records) { const row = h.data.Steps.find(x => x.logicalKey === value.logicalKey); row.state = 'verified'; row.verification = value.proof; }
    return { ...graph, persisted: true };
  };
  const importedJobs = new Map();
  const adoptedSources = require('../src/modules/business-adopted-settlement').createAdoptedSettlementReader({ Calendars: h.models.Calendars, PopulationRecords: h.models.PopulationRecords, PopulationJobs: { findOne: filter => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => clone(importedJobs.get(filter._id)) }) }, readRecord: verification.rawRecord });
  const compileEvidence = createBusinessCompilationRuntime({ scope, operationId, planHash, access, plans, verification, assertReady: async () => {}, now: () => h.clock,
    steps: { verifyGraph: async (_s, _o, roots) => persist(roots), evidence: async (_s, _o, key) => ({ ...clone(h.data.Steps.find(x => x.logicalKey === key)), fresh: true }) },
    adoptedSources });
  const refs = details => {
    const definition = h.data.Versions[0].definition;
    const used = new Set([details.customerKey, details.vendorKey, details.workerKey, details.itemKey, ...details.lines.map(line => line.itemKey)]);
    return [...Object.entries(definition.mappings), ...Object.entries(definition.masterBindings).filter(([key]) => used.has(key))].map(([key, id]) => {
      const row = [...h.records.values()].find(x => x.record.Id === id);
      const observed = observe(row.entity, row.record); observed.source = { version: 1, kind: 'qbo-full-entity-get', scope, entity: row.entity, id, endpoint: row.entity.toLowerCase() + '/' + id, recordHash: observed.recordHash };
      return bindBusinessReference({ scope, key, entity: row.entity, observed, now: h.clock });
    });
  };
  async function save(intent) {
    intents.set(intent.logicalKey, intent);
    itemGets += intent.step.references.filter(x => x.entity === 'Item').length;
    compilationGets += intent.dependencies.length + (intent.entity === 'Deposit' ? 1 : 0);
    const evidence = await compileEvidence({ scope, operationId, logicalKey: intent.logicalKey, intent });
    const compiled = compileBusinessTransaction({ scope, step: intent.step, policy: intent.policy, ...evidence, now: h.clock });
    const period = await readWritePeriodEvidence(compiled.request, h.client, () => h.clock);
    assert.equal(period.requestHash, compiled.request.requestHash);
    // This is only the in-memory company's transport; never QBOClient POST.
    const reply = await h.client.oauthClient.makeApiCall({ method: 'POST', url: h.client.apiBase + '/' + intent.entity.toLowerCase(), body: compiled.request.body });
    assert.equal(reply.status, 200);
    const record = reply.json[intent.entity], dispatchKey = hash({ operationId, key: intent.logicalKey });
    const receipt = { version: 1, scope, entity: intent.entity, logicalKey: intent.logicalKey, dispatchKey, requestHash: compiled.request.requestHash, qboId: record.Id, syncToken: record.SyncToken, source: 'create-response', evidenceHash: hash(reply.json) };
    const row = { contractVersion: 1, ...scope, operationId, planHash, logicalKey: intent.logicalKey, entity: intent.entity, fingerprint: intent.fingerprint, state: 'saved', revision: ++revision, qboId: record.Id, compilation: compiled, dependencies: intent.dependencies,
      receipt, dispatch: { key: dispatchKey, requestHash: compiled.request.requestHash, compilationHash: compiled.compilationHash, evidenceHash: compiled.evidenceHash } };
    h.data.Steps.push(row); frozen.set(intent.entity + ':' + record.Id, { entity: intent.entity, record: clone(record) });
    // Computed fields can change without SyncToken advancing. Keep tokens fixed
    // across every simulated child save to catch version-only invalidation.
    for (const step of h.data.Steps) h.records.get(step.entity.toLowerCase() + ':' + step.qboId).record.SyncToken = '0';
    h.clock += 100;
    await persist([row.logicalKey]);
    return row;
  }
  async function append(activities, day = '2026-11-01') {
    const batch = makeActivityBatch({ scope, businessKey: hash('fixture business'), day, choices: { decisionKey: name + '-' + (++index), purpose, activities } });
    const built = buildBatchActivity(batch, scope, hash('fixture business')), rows = [];
    for (const event of built.events) {
      const details = clone(built.detailProposal.byLogicalKey[event.logicalKey].details);
      const step = { logicalKey: event.logicalKey, entity: event.entity, txnDate: event.txnDate, calendarFingerprint: event.fingerprint, details, references: refs(details), dependencies: event.dependsOn.map(key => ({ logicalKey: key, entity: intents.get(key).entity, fingerprint: intents.get(key).fingerprint })) };
      step.detailsHash = hash({ calendarFingerprint: step.calendarFingerprint, details });
      const base = details.baseAmountCents, tax = base == null ? null : Math.round(base * 0.13);
      const policy = { version: 1, scope, status: 'approved', country: 'CA', currency: 'CAD', fromDate: '2026-11-01', throughDate: '2026-11-30', stepHash: hash(step), evidenceHash: hash('approved fixture policy'), tax: { calculation: 'TaxExcluded', salesTax: h.mappings.salesTax, purchaseTax: h.mappings.purchaseTax },
        ...(tax === null ? {} : { readbackTax: { version: 1, totalTaxCents: tax, lines: [{ rateId: '950', percent: 13, taxableCents: base, amountCents: tax }] } }) };
      policy.lifecycle = require('../src/modules/business-lifecycle-policy').lifecyclePolicy(step);
      rows.push(await save({ version: 1, kind: 'create', scope, operationId, planHash, logicalKey: step.logicalKey, entity: step.entity, fingerprint: hash(step), step, dependencies: step.dependencies, policy }));
    }
    return rows;
  }
  const current = row => h.records.get(row.entity.toLowerCase() + ':' + row.qboId).record;
  function source(row) {
    const found = new Map(), visit = value => { if (found.has(value.logicalKey)) return; found.set(value.logicalKey, value); for (const link of value.dependencies) visit(h.data.Steps.find(x => x.logicalKey === link.logicalKey)); }; visit(row);
    return { logicalKey: row.logicalKey, txnDate: intents.get(row.logicalKey).step.txnDate, sources: [...found.values()].map(x => ({ logicalKey: x.logicalKey, entity: x.entity, txnDate: intents.get(x.logicalKey).step.txnDate, dependsOn: x.dependencies.map(l => l.logicalKey).sort() })).sort((a,b) => a.logicalKey.localeCompare(b.logicalKey)) };
  }
  async function finish(expected, t) {
    const result = await persist(h.data.Steps.map(x => x.logicalKey)); assert.equal(result.complete, true); assert.equal(result.recordCount, expected);
    assert.ok(h.data.Steps.every(x => x.state === 'verified' && x.operationId === operationId));
    const changed = [...frozen.values()].filter(x => hash(h.records.get(x.entity.toLowerCase() + ':' + x.record.Id).record) !== hash(x.record)).map(x => ({entity:x.entity,qboId:x.record.Id}));
    assert.ok(changed.length, 'a child must actually change an earlier same-operation record');
    for (const row of changed) { const stale = await store.read(scope, row.entity, row.qboId, { transactions: true }); assert.ok(stale); assert.notEqual(stale.recordHash, hash(current(row))); }
    assert.ok(mirrorHits > 0);
    const transactionGets = h.events.filter(e => e.method === 'GET' && /\/(estimate|timeactivity|invoice|payment|deposit|purchaseorder|bill|billpayment|creditmemo)\/\d+$/.test(e.path)).length;
    t?.diagnostic(JSON.stringify({ name, graphGets, compilationGets, itemGets, transactionGets })); return result;
  }
  return { h, append, current, source, finish, save, intents, verification, setImported(row) {
    const intent = intents.get(row.logicalKey), adoptionId = 'f'.repeat(24), jobId = 'd'.repeat(24), authorityHash = hash('adopted fixture authority');
    h.data.Calendars.push({ ...scope, adoption: { kind: 'adopted-history', adoptionId, jobId, importedThrough: intent.step.txnDate } });
    importedJobs.set(jobId, { _id: jobId, status: 'adopted', authorityHash });
    h.data.PopulationRecords.push({ ...scope, entity: row.entity, qboId: row.qboId, logicalKey: row.logicalKey, txnDate: intent.step.txnDate, state: 'saved', authorityHash, financialProof: { matchesFinancialIntent: true }, compilation: clone(row.compilation), receipt: clone(row.receipt), step: clone(intent.step) });
  } };
}

test('single operation: settled sale and deposit', async t => {
  const c = chain('settled-sale-fixture'); await c.append([field]); await c.finish(5, t);
});
test('single operation: invoice on terms, partial collection and full collection, both deposited', async t => {
  const c = chain('own-invoice-fixture'), [invoice] = await c.append([care]);
  const collect = amountCents => ({ type: 'collect-own-invoice', invoiceId: invoice.qboId, customerKey: care.customerKey, amountCents, source: c.source(invoice), purpose });
  assert.throws(() => makeActivityBatch({ scope, businessKey: hash('fixture business'), day: '2026-11-01', choices: { decisionKey: 'same-day-source-refused', purpose, activities: [collect(10000)] } }), /from today/);
  await c.append([collect(10000)], '2026-11-02'); await c.append([collect(cents(c.current(invoice).Balance))], '2026-11-03');
  assert.equal(c.current(invoice).Balance, 0); await c.finish(5, t);
});
test('single operation: bill on terms then pay own bill', async t => {
  const c = chain('own-bill-fixture'), [bill] = await c.append([billChoice]);
  await c.append([{ type: 'pay-own-bill', billId: bill.qboId, vendorKey: billChoice.vendorKey, amountCents: cents(c.current(bill).Balance), source: c.source(bill), purpose }], '2026-11-02');
  assert.equal(c.current(bill).Balance, 0); await c.finish(2, t);
});
test('single operation: send estimate then convert own estimate', async t => {
  const c = chain('own-estimate-fixture'), [estimate] = await c.append([{ type: 'send-estimate', customerKey: field.customerKey, quantity: 2, unitPriceCents: 9000, purpose }]);
  await c.append([{ type: 'convert-own-estimate', estimateId: estimate.qboId, customerKey: field.customerKey, termsDays: 30, source: c.source(estimate), quote: { itemKey: 'field-service-hour', quantity: 2, unitPriceCents: 9000 }, purpose }], '2026-11-02');
  assert.equal(c.current(estimate).TxnStatus, 'Closed'); await c.finish(3, t);
});
test('single operation: order stock then receive purchase order', async t => {
  const c = chain('own-order-fixture'), [po] = await c.append([{ type: 'order-stock', vendorKey: 'stock-supplier-1', lines: [{ itemKey: 'workshop-stock-1', quantity: 3, unitPriceCents: 2050 }], purpose }]);
  await c.append([{ type: 'receive-purchase-order', purchaseOrderId: po.qboId, vendorKey: 'stock-supplier-1', source: { kind: 'managed', logicalKey: po.logicalKey, txnDate: '2026-11-01' }, lines: [{ lineId: '1', itemKey: 'workshop-stock-1', quantity: 3, unitPriceCents: 2050 }], purpose }], '2026-11-02');
  assert.equal(c.current(po).POStatus, 'Closed'); await c.finish(2, t);
});
test('single operation: collect adopted invoice then deposit', async t => {
  const c = chain('adopted-collect-fixture'), [invoice] = await c.append([care]);
  c.h.data.Steps.splice(c.h.data.Steps.indexOf(invoice), 1);
  c.setImported(invoice);
  await c.append([{ type: 'collect-adopted-invoice', invoiceId: invoice.qboId, customerKey: care.customerKey, amountCents: cents(c.current(invoice).Balance), purpose }], '2026-11-02');
  // Adopted parents have no managed graph edge. Verify settlement/deposit separately;
  // its exact original still must have been read fresh by compilation and period guard.
  assert.equal(c.current(invoice).Balance, 0); await c.finish(2, t);
});
test('single operation: customer credit applied', async t => {
  const c = chain('customer-credit-fixture'); await c.h.publish();
  const prepared = await c.h.service.prepare(c.h.user, { requestKey: 'single-operation-credit-fixture', throughDate: '2026-11-20' });
  await c.h.service.approve(c.h.user, prepared.operationId, { planHash: prepared.planHash });
  const native = c.h.data.Intents.map(x => ({ ...clone(x), version: 1, entity: x.step.entity, dependencies: x.step.dependencies }));
  const credit = native.find(x => x.entity === 'CreditMemo'), byKey = new Map(native.map(x => [x.logicalKey, x]));
  const application = native.find(x => x.entity === 'Payment' && x.dependencies.some(d => d.logicalKey === credit.logicalKey));
  for (const original of [byKey.get(credit.dependencies[0].logicalKey), credit, application]) await c.save({ ...original, scope, operationId: 'e'.repeat(24), planHash: hash('customer-credit-fixture') });
  await c.finish(3, t);
});
test('single operation: correct own unpaid invoice with exact credit and application', async t => {
  const c = chain('correction-fixture'), [invoice] = await c.append([care]), intent = c.intents.get(invoice.logicalKey), record = c.current(invoice);
  const tax = { codeId: c.h.mappings.salesTax, ...clone(intent.policy.readbackTax) }; delete tax.version;
  const correction = { kind: 'credit-unpaid-invoice', original: { entity: 'Invoice', qboId: invoice.qboId, logicalKey: invoice.logicalKey, fingerprint: invoice.fingerprint, txnDate: '2026-11-01', policyHash: hash(intent.policy), compilationHash: invoice.compilation.compilationHash }, sources: c.source(invoice).sources, customerKey: care.customerKey, lines: clone(intent.step.details.lines), tax };
  await c.append([{ type: 'correct-own-record', target: { entity: 'Invoice', qboId: invoice.qboId }, correction, purpose }], '2026-11-02');
  assert.equal(record.Balance, 0); await c.finish(3, t);
});
