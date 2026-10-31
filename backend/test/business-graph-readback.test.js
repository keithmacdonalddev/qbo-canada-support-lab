'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessVerificationRuntime } = require('../src/modules/business-verification-runtime');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { reconcileBusinessGraph, createBusinessGraphReader, MAX_BYTES } = require('../src/modules/business-graph-readback');
const { sample, bindParent, scope, now, clone } = require('./helpers/business-readback-fixtures');
function saved(entity, id, configure) { const h = sample(entity, configure); h.observed.record.Id = id; h.receipt.qboId = id; h.refresh(); return h; }
function entry(h) {
  const c = h.compiled;
  return { intent: { version: 1, scope, operationId: 'b'.repeat(24), planHash: hash('operation plan'), logicalKey: c.logicalKey, entity: c.entity, fingerprint: c.intentHash, ...clone(h.intent), policy: { ...clone(h.intent.policy), ...(h.taxPolicy ? { readbackTax: { version: 1, totalTaxCents: h.taxPolicy.totalTaxCents, lines: clone(h.taxPolicy.lines) } } : {}) } }, step: { contractVersion: 1, ...scope, operationId: 'b'.repeat(24), planHash: hash('operation plan'), logicalKey: c.logicalKey, entity: c.entity, fingerprint: c.intentHash, state: 'saved', revision: 4, qboId: h.receipt.qboId,
    dependencies: c.relationships.map(link => ({ logicalKey: link.logicalKey, entity: link.entity, fingerprint: link.fingerprint })), compilation: clone(c), dispatch: { key: h.receipt.dispatchKey, requestHash: h.receipt.requestHash, compilationHash: c.compilationHash, evidenceHash: c.evidenceHash }, receipt: clone(h.receipt) }, observed: clone(h.observed), taxPolicy: clone(h.taxPolicy) };
}
function graph(kind = 'sales') {
  let activities;
  if (kind === 'sales') {
    const estimate = saved('Estimate', '5001'), time = saved('TimeActivity', '5002', f => bindParent(f, 0, estimate));
    const invoice = saved('Invoice', '5003', f => { bindParent(f, 0, estimate); bindParent(f, 1, time); });
    const payment = saved('Payment', '5004', f => bindParent(f, 0, invoice));
    const deposit = saved('Deposit', '5005', f => bindParent(f, 0, payment));
    estimate.observed.record.TxnStatus = 'Closed';
    estimate.observed.record.LinkedTxn = [{ TxnType: 'Invoice', TxnId: '5003' }];
    time.observed.record.BillableStatus = 'HasBeenBilled'; time.observed.record.LinkedTxn = [{ TxnType: 'Invoice', TxnId: '5003' }];
    invoice.observed.record.Balance = 0; invoice.observed.record.LinkedTxn.push({ TxnType: 'Payment', TxnId: '5004' });
    payment.observed.record.LinkedTxn = [{ TxnType: 'Deposit', TxnId: '5005' }];
    activities = [estimate, time, invoice, payment, deposit];
  } else {
    const po = saved('PurchaseOrder', '6001'), bill = saved('Bill', '6002', f => bindParent(f, 0, po));
    const sale = saved('SalesReceipt', '6003', f => bindParent(f, 0, bill)), payment = saved('BillPayment', '6004', f => bindParent(f, 0, bill));
    po.observed.record.Line[0].Received = 12; po.observed.record.POStatus = 'Closed'; po.observed.record.LinkedTxn = [{ TxnType: 'Bill', TxnId: '6002' }];
    bill.observed.record.Balance = 0; bill.observed.record.LinkedTxn.push({ TxnType: 'BillPayment', TxnId: '6004' });
    activities = [po, bill, sale, payment];
  }
  for (const h of activities) { h.observed.record.SyncToken = '1'; h.refresh(); }
  return { scope, roots: [activities[0].compiled.logicalKey], entries: activities.map(entry), now };
}
function harness(value = graph()) {
  const h = { value, clock: now, actor: { actorId: 'owner' }, writer: { scope, revision: 12, operationId: 'b'.repeat(24), unresolved: null }, reads: [], queryCount: 0, opened: 0, closed: 0, retained: [], active: 0, maxActive: 0 };
  h.models = { find(filter, _projection, findOptions) {
    h.queryCount++; let session, maximum = Infinity;
    const query = { select() { return query; }, sort(value) { assert.deepEqual(value, { logicalKey: 1 }); return query; }, session(v) { session = v; return query; }, limit(v) { maximum = v; return query; }, maxTimeMS(v) { assert.equal(v, 10000); return query; }, lean() { return query; }, cursor(options) {
      assert.ok(session); assert.equal(options.batchSize, 100); assert.equal(findOptions?.singleBatch, true); assert.equal(findOptions.batchSize, 100); h.opened++;
      const rows = value.entries.map(e => e.step).filter(row => row.environment === filter.environment && row.realmId === filter.realmId && (!filter.logicalKey || ((!filter.logicalKey.$in || filter.logicalKey.$in.includes(row.logicalKey)) && (!filter.logicalKey.$gt || row.logicalKey > filter.logicalKey.$gt))) && (!filter['dependencies.logicalKey'] || row.dependencies.some(link => filter['dependencies.logicalKey'].$in.includes(link.logicalKey))) && (!filter.state || filter.state.$in.includes(row.state))).sort((a,b) => a.logicalKey.localeCompare(b.logicalKey)).slice(0, Math.min(maximum, h.bytePageLimit || 100));
      (h.pages ||= []).push({ rows: rows.length, maximum, filter: clone(filter) });
      let i = 0, closed = false;
      return { next: async () => { if (h.onNext) await h.onNext(); return closed ? null : clone(rows[i++] || null); }, close: async () => { if (!closed) { closed = true; h.closed++; } } };
    } }; return query;
  } };
  h.dependencies = { Steps: h.models, transaction: async work => work({ snapshot: true }), assertReady: async () => {}, authorize: async () => { if (h.onAuthorize) await h.onAuthorize(); return h.actor; }, readFence: async () => { if (h.onFence) await h.onFence(); return clone(h.writer); }, now: () => h.clock,
    readRecord: async (_scope, entity, qboId, options) => { assert.deepEqual(_scope, scope); h.reads.push(entity + ':' + qboId); h.active++; h.maxActive = Math.max(h.maxActive, h.active); try { if (h.onRead) await h.onRead(entity, qboId, options); return clone(value.entries.find(e => e.step.entity === entity && e.step.qboId === qboId).observed); } finally { h.active--; } },
    loadTaxPolicy: async (_scope, compiled) => clone(value.entries.find(e => e.step.logicalKey === compiled.logicalKey).taxPolicy) };
  h.reader = () => createBusinessGraphReader(h.dependencies)({ scope, roots: value.roots, signal: h.signal }); return h;
}
for (const kind of ['sales', 'purchase']) test('reconciles complete ' + kind + ' chain in two passes with exact current versions', () => {
  const h = graph(kind), result = reconcileBusinessGraph(h); assert.equal(result.complete, true, JSON.stringify(result.failures)); assert.equal(result.recordCount, h.entries.length); assert.equal(result.persisted, false);
  for (const record of result.records) { assert.equal(record.proof.kind, 'business-readback'); assert.equal(record.proof.syncToken, '1'); assert.equal(record.proof.matchesIntent, true); }
  const shuffled = { ...h, entries: [...h.entries].reverse() }; assert.equal(reconcileBusinessGraph(shuffled).evidenceHash, result.evidenceHash);
});
test('mismatched financial content prevents the affected graph from passing', () => {
  const h = graph(), invoice = h.entries.find(e => e.step.entity === 'Invoice'); invoice.observed.record.Balance = 1; invoice.observed.recordHash = hash(invoice.observed.record);
  const result = reconcileBusinessGraph(h); assert.equal(result.complete, false); assert.ok(result.failures.some(e => e.entity === 'Invoice' && e.issues.some(x => /balance/.test(x)))); assert.ok(result.records.every(r => r.proof === null));
});
test('unknown external transaction links cannot become managed descendants', () => {
  const h = graph(), invoice = h.entries.find(e => e.step.entity === 'Invoice'); invoice.observed.record.LinkedTxn.push({ TxnType: 'Payment', TxnId: '9999' }); invoice.observed.recordHash = hash(invoice.observed.record);
  const result = reconcileBusinessGraph(h); assert.equal(result.complete, false); assert.ok(result.failures.some(e => e.issues.includes('An unplanned transaction link is present.')));
});
test('missing sources, duplicate IDs, altered receipts and unapproved tax are not complete evidence', () => {
  for (const change of [h => { h.entries.shift(); }, h => { h.entries.push(clone(h.entries[0])); }, h => { h.entries[0].step.receipt.requestHash = hash('other'); }, h => { h.entries[0].step.connectionId = 'c'.repeat(24); }, h => { h.entries[0].step.state = 'unknown'; }]) { const h = graph(); change(h); assert.throws(() => reconcileBusinessGraph(h)); }
  const h = graph(); h.entries[2].taxPolicy = null; assert.equal(reconcileBusinessGraph(h).complete, false);
});
test('the root set must be valid and all supplied records related to a requested root', () => {
  const h = graph(); assert.throws(() => reconcileBusinessGraph({ ...h, roots: [] })); assert.throws(() => reconcileBusinessGraph({ ...h, roots: [h.roots[0], h.roots[0]] }));
  h.entries.push(...graph('purchase').entries); assert.throws(() => reconcileBusinessGraph(h), /Unrelated/);
  h.roots.push(graph('purchase').roots[0]); assert.equal(reconcileBusinessGraph(h).complete, true);
});
test('reader discovers the full connected chain in storage and uses no more than three read workers', async () => {
  const h = harness(); h.value.roots = [h.value.entries[2].step.logicalKey];
  h.onRead = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const result = await h.reader(); assert.equal(result.complete, true); assert.equal(h.reads.length, 5); assert.equal(new Set(h.reads).size, 5); assert.equal(h.maxActive, 3); assert.equal(h.active, 0); assert.equal(h.opened, h.closed); assert.ok(h.opened > 0); assert.equal(result.writerFence.revision, 12);
});
test('known unresolved children block before any provider read', async () => {
  const h = harness(); h.value.entries.at(-1).step.state = 'dispatched'; await assert.rejects(h.reader(), /unresolved/); assert.equal(h.reads.length, 0); assert.equal(h.opened, h.closed);
});
test('a foreign connection child is not silently omitted', async () => {
  const h = harness(); h.value.entries.at(-1).step.connectionId = 'c'.repeat(24); await assert.rejects(h.reader(), /unresolved/); assert.equal(h.reads.length, 0); assert.equal(h.opened, h.closed);
});
test('writer changes and revoked read authority discard the completed observations', async () => {
  const h = harness(); h.onRead = async () => { h.writer.revision = 13; }; await assert.rejects(h.reader(), /changed while/);
  const g = harness(); g.onRead = async () => { g.actor = null; }; await assert.rejects(g.reader(), /changed while/); assert.equal(g.active, 0);
});
test('cancellation during final fence cannot return a completed proof', async () => {
  const h = harness(), controller = new AbortController(); h.signal = controller.signal; let calls = 0;
  h.onFence = async () => { if (++calls === 2) controller.abort(); };
  await assert.rejects(h.reader(), error => error.code === 'BUSINESS_GRAPH_CANCELLED'); assert.equal(h.active, 0); assert.equal(h.opened, h.closed);
});
test('cancellation closes a storage cursor and does not start provider reads', async () => {
  const h = harness(), controller = new AbortController(); h.signal = controller.signal;
  h.onNext = async () => { controller.abort(); };
  await assert.rejects(h.reader(), error => error.code === 'BUSINESS_GRAPH_CANCELLED'); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.opened, h.closed); assert.equal(h.reads.length, 0);
});
test('read deadline aborts pending workers without producing proof', async () => {
  const h = harness(); h.onRead = async () => { h.clock += 180001; };
  await assert.rejects(h.reader(), error => error.code === 'BUSINESS_GRAPH_EXPIRED'); assert.equal(h.active, 0); assert.ok(h.reads.length <= 3);
});
test('one failed read cancels peers and prevents further queued requests', async () => {
  const h = harness(); let first = true;
  h.onRead = async (_entity, _id, { signal }) => { if (first) { first = false; throw new Error('provider unavailable'); } await new Promise((_, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); };
  await assert.rejects(h.reader(), /provider unavailable/); assert.equal(h.active, 0); assert.ok(h.reads.length <= 3);
});
test('oversized observations are rejected as they arrive instead of accumulating the whole graph', async () => {
  const h = harness(); h.dependencies.readRecord = async (_scope, entity, qboId) => { h.reads.push(qboId); return { ...clone(h.value.entries.find(e => e.step.entity === entity && e.step.qboId === qboId).observed), unrelated: 'x'.repeat(MAX_BYTES + 1) }; };
  await assert.rejects(h.reader(), /size budget/); assert.ok(h.reads.length <= 3);
});

test('preparation returns only bounded storage metadata without provider reads', async () => {
  const h = harness(), reader = createBusinessGraphReader(h.dependencies);
  const result = await reader({ scope, roots: h.value.roots, mode: 'prepare' });
  assert.equal(result.prepared, true); assert.equal(result.kind, 'business-graph-preparation'); assert.equal(result.recordCount, 5); assert.equal(h.reads.length, 0); assert.equal(h.opened, h.closed);
  assert.equal(result.evidenceHash, hash({ version: 1, scope, roots: result.roots, records: result.records, writerFence: result.writerFence }));
  for (const record of result.records) { assert.equal(Object.hasOwn(record, 'compilation'), false); assert.equal(Object.hasOwn(record, 'proof'), false); assert.equal(Object.hasOwn(record, 'observed'), false); }
});
test('expected writer snapshot must match before any graph provider reads', async () => {
  const h = harness(); await assert.rejects(createBusinessGraphReader(h.dependencies)({ scope, roots: h.value.roots, expectedWriterFence: { scope, revision: 11, operationId: h.writer.operationId } }), /changed before/); assert.equal(h.reads.length, 0);
});

for (const kind of ['sales', 'purchase']) test('concrete verification runtime reads complete ' + kind + ' chain from QBO client and original plans', async () => {
  const h = harness(graph(kind)), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24);
  h.models.findOne = filter => { const query = { select() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.value.entries.find(entry => entry.step.logicalKey === filter.logicalKey && entry.step.connectionId === filter.connectionId)?.step || null) }; return query; };
  const client = Object.create(QBOClient.prototype), gets = [];
  Object.defineProperty(client, 'apiBase', { value: 'https://sandbox-quickbooks.api.intuit.com/v3/company/123' });
  Object.assign(client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    assert.equal(options.method, 'GET'); gets.push(options.url);
    const query = new URL(options.url).searchParams.get('query');
    if (query) { const entity = /FROM (\w+)/.exec(query)?.[1], ids = /WHERE Id IN \(([^)]+)\)/.exec(query)?.[1]?.split(',').map(id => id.trim().replaceAll("'",'')); assert.ok(ids); const rows = h.value.entries.filter(value => value.step.entity === entity && ids.includes(value.step.qboId)).map(value => clone(value.observed.record)); return { status: 200, json: { QueryResponse: { [entity]: rows, startPosition: 1, maxResults: rows.length } } }; }
    const entry = h.value.entries.find(value => options.url.endsWith('/' + value.step.entity.toLowerCase() + '/' + value.step.qboId)); assert.ok(entry);
    return { status: 200, json: { [entry.step.entity]: clone(entry.observed.record) } };
  } } });
  const runtime = createBusinessVerificationRuntime({ scope, operationId: h.writer.operationId, planHash: hash('operation plan'), Steps: h.models, transaction: h.dependencies.transaction, assertReady: h.dependencies.assertReady, access: { authorize: async () => ({ actorId, ownerId }), resolveClient: async () => client }, writerFence: { graphSnapshot: async () => ({ scope, operationId: h.writer.operationId, revision: h.writer.revision }) }, plans: { loadIntent: async (_scope, op, key) => { assert.deepEqual(_scope, scope); assert.equal(op, h.writer.operationId); return clone(h.value.entries.find(entry => entry.step.logicalKey === key).intent); } }, now: () => h.clock });
  const result = await runtime.loadGraphReadback({ scope, roots: h.value.roots });
  assert.equal(result.complete, true); assert.equal(result.persisted, false); assert.equal(result.recordCount, h.value.entries.length); assert.equal(new Set(gets).size, h.value.entries.length); assert.equal(h.opened, h.closed);
  delete h.value.entries[0].intent.policy.readbackTax;
  const incomplete = await runtime.loadGraphReadback({ scope, roots: h.value.roots });
  assert.equal(incomplete.complete, false); assert.ok(incomplete.failures.some(value => value.issues.some(issue => /tax/.test(issue)))); assert.equal(h.opened, h.closed);
});

test('a byte-short graph page still discovers every later child before completion', async () => {
  const h = harness(); h.bytePageLimit = 1;
  const result = await h.reader();
  assert.equal(result.complete, true); assert.equal(result.recordCount, 5);
  assert.equal(h.reads.length, 5); assert.equal(h.opened, h.closed);
  assert.ok(h.pages.some(page => page.rows === 0));
});
function wideGraph(children) {
  const estimate = saved('Estimate', '7000'), entries = [entry(estimate)];
  for (let index = 0; index < children; index++) entries.push(entry(saved('TimeActivity', String(7100 + index), f => { f.step.logicalKey = hash('paged time ' + index); bindParent(f, 0, estimate); })));
  return { scope, roots: [estimate.compiled.logicalKey], entries, now };
}
test('graph preparation keeps more than 100 related children across complete single-batch pages', async () => {
  const h = harness(wideGraph(101));
  const result = await createBusinessGraphReader(h.dependencies)({ scope, roots: h.value.roots, mode: 'prepare' });
  assert.equal(result.prepared, true); assert.equal(result.recordCount, 102);
  assert.equal(new Set(result.records.map(row => row.logicalKey)).size, 102);
  assert.equal(h.reads.length, 0); assert.equal(h.opened, h.closed);
  assert.ok(h.pages.some(page => page.rows === 100)); assert.ok(h.pages.some(page => page.rows === 0));
});
test('single-batch graph scans retain the original 1000-record boundary', async () => {
  const h = harness(wideGraph(999));
  const accepted = await createBusinessGraphReader(h.dependencies)({ scope, roots: h.value.roots, mode: 'prepare' });
  assert.equal(accepted.recordCount, 1000); assert.equal(h.opened, h.closed);
  const tooLarge = harness(wideGraph(1000));
  await assert.rejects(createBusinessGraphReader(tooLarge.dependencies)({ scope, roots: tooLarge.value.roots, mode: 'prepare' }), /budget/);
  assert.equal(tooLarge.reads.length, 0); assert.equal(tooLarge.opened, tooLarge.closed);
});

test('same-operation invoice parent stays current before and after Payment after preceding saved records', async () => {
  const { createBusinessCompilationRuntime } = require('../src/modules/business-compilation-runtime');
  const { fixture } = require('./helpers/business-transaction-fixtures');
  const value = graph(), invoice = value.entries.find(e => e.step.entity === 'Invoice');
  value.entries = value.entries.slice(0, 3);
  invoice.observed.record.Balance = invoice.observed.record.TotalAmt;
  invoice.observed.record.LinkedTxn = invoice.observed.record.LinkedTxn.filter(link => link.TxnType !== 'Payment');
  delete invoice.observed.record.ARAccountRef;
  for (const e of value.entries) { e.observed.record.SyncToken = '0'; e.observed.recordHash = hash(e.observed.record); }
  // Nine independent saves precede this chain in the same operation. Every read
  // advances the clock; a frozen clock conceals a create-response/proof inversion.
  for (let i = 0; i < 9; i++) value.entries.push(entry(saved('Estimate', String(7000+i), f => { f.step.logicalKey = hash('preceding '+i); })));
  value.roots = value.entries.map(e => e.step.logicalKey);
  const h = harness(value), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24), calls = [];
  h.actor = { ownerId, actorId };
  const f = fixture('Payment'); bindParent(f, 0, { compiled: invoice.step.compilation, observed: invoice.observed }); f.approve();
  const paymentIntent = { version:1, scope, operationId:invoice.step.operationId, planHash:invoice.step.planHash, logicalKey:f.step.logicalKey, entity:'Payment', kind:'create', fingerprint:hash(f.step), step:f.step, policy:f.policy, dependencies:f.step.dependencies };
  h.models.findOne = filter => { const q = { select(){return q;},maxTimeMS(){return q;},lean:async()=>clone(value.entries.find(e=>filter.logicalKey?e.step.logicalKey===filter.logicalKey:e.step.entity===filter.entity&&e.step.qboId===filter.qboId)?.step||null) }; return q; };
  const report = require('./helpers/business-receivables-fixture').routingFixture().input.report;
  report.Rows.Row[0].Rows.Row[0].ColData[1].id=invoice.step.qboId;
  const client=Object.create(QBOClient.prototype);
  Object.defineProperty(client,'apiBase',{value:'https://sandbox-quickbooks.api.intuit.com/v3/company/123'});
  Object.assign(client,{realmId:scope.realmId,connection:{_id:scope.connectionId,realmId:scope.realmId,userId:ownerId,status:'active'},_requestLog:[],_retryAfterUntil:0,_windowMs:60000,ensureFreshToken:async()=>{},requestMeter:{record(){}},oauthClient:{makeApiCall:async options=>{
    assert.equal(options.method,'GET'); calls.push(options); h.clock+=200;
    if(options.url.includes('/reports/'))return {status:200,json:clone(report)};
    const reference=f.referenceEvidence.find(e=>options.url.endsWith('/'+e.entity.toLowerCase()+'/'+e.record.Id));
    if(reference)return {status:200,json:{[reference.entity]:clone(reference.record)}};
    const e=value.entries.find(e=>options.url.endsWith('/'+e.step.entity.toLowerCase()+'/'+e.step.qboId)); assert.ok(e,options.url);
    return {status:200,json:{[e.step.entity]:clone(e.observed.record)}};
  }}});
  const originals=new Map(value.entries.map(e=>[e.step.entity+':'+e.step.qboId,clone(e.observed)]));
  let applied=false;
  const observations={read:async()=>null,saved:async(_s,entity,id)=>{
    if(applied&&entity==='Invoice')return null;
    const observed=clone(originals.get(entity+':'+id)); if(!observed)return null;
    return {...observed,source:{kind:'qbo-write-response'}};
  },retain:async()=>{}};
  const access={authorize:async()=>clone(h.actor),resolveClient:async()=>client};
  const plans={loadIntent:async(_s,_o,key)=>clone(key===paymentIntent.logicalKey?paymentIntent:value.entries.find(e=>e.step.logicalKey===key).intent)};
  const runtime=createBusinessVerificationRuntime({scope,operationId:invoice.step.operationId,planHash:invoice.step.planHash,Steps:h.models,transaction:async work=>work({snapshot:true}),assertReady:async()=>{},access,writerFence:{graphSnapshot:async()=>clone(h.writer)},plans,observations,now:()=>h.clock});
  const persist=async roots=>{const result=await runtime.loadGraphReadback({scope,roots});assert.equal(result.complete,true,JSON.stringify(result.failures));for(const record of result.records){const e=value.entries.find(e=>e.step.logicalKey===record.logicalKey);e.step.state='verified';e.step.verification=record.proof;}return {...result,persisted:true};};
  await persist(value.roots); assert.equal(value.entries.length,12); h.clock+=1000;
  const read=createBusinessCompilationRuntime({scope,operationId:invoice.step.operationId,planHash:invoice.step.planHash,access,plans,verification:runtime,assertReady:async()=>{},steps:{verifyGraph:async(_s,_o,roots)=>persist(roots),evidence:async(_s,_o,key)=>{const row=value.entries.find(e=>e.step.logicalKey===key).step;return {...clone(row),fresh:true};}},now:()=>h.clock});
  const evidence=await read({scope,operationId:invoice.step.operationId,logicalKey:paymentIntent.logicalKey,intent:paymentIntent});
  const compiled=require('../src/modules/business-transaction-compiler').compileBusinessTransaction({scope,step:f.step,policy:f.policy,...evidence,now:h.clock});
  assert.equal(compiled.entity,'Payment');assert.equal(JSON.parse(compiled.request.body).Line[0].LinkedTxn[0].TxnId,invoice.step.qboId);
  assert.equal(evidence.parents[0].source.kind,'qbo-full-entity-get');
  // Apply the simulated Payment: old create response remains retained, but its
  // parent must now be obtained live and graph-verified with the exact new links.
  const payment=entry(saved('Payment','5004',p=>bindParent(p,0,{compiled:invoice.step.compilation,observed:invoice.observed})));
  value.entries.push(payment); originals.set('Payment:5004',clone(payment.observed));applied=true;
  invoice.observed.record.Balance=0;invoice.observed.record.LinkedTxn.push({TxnType:'Payment',TxnId:'5004'});invoice.observed.recordHash=hash(invoice.observed.record);
  // The batch query is also an independent full record observation.
  const originalCall=client.oauthClient.makeApiCall;
  client.oauthClient.makeApiCall=async options=>options.url.includes('/query?')?{status:200,json:{QueryResponse:{Invoice:[clone(invoice.observed.record)],startPosition:1,maxResults:1}}}:originalCall(options);
  await persist([payment.step.logicalKey]);
  invoice.observed.record.Balance=1;invoice.observed.recordHash=hash(invoice.observed.record);
  const changed=await runtime.loadGraphReadback({scope,roots:[payment.step.logicalKey]});assert.equal(changed.complete,false,'incorrect parent balances still fail verification');
});

test('a pre-dispatch verification refusal retains its claim and an early retry cannot dispatch',async()=>{
 const h=require('./helpers/business-runtime-fixture').harness();
 h.onObserve=async()=>{throw Object.assign(new Error('The original and current invoice observation times are stale or out of order.'),{code:'BUSINESS_RECEIVABLES_UNVERIFIED'});};
 await assert.rejects(h.execute(),error=>error.code==='BUSINESS_RECEIVABLES_UNVERIFIED');
 assert.equal(h.row().state,'claimed');assert.equal(h.row().dispatch,null);h.clock+=60000;h.onObserve=null;
 await assert.rejects(h.execute(),error=>error.code===undefined&&error.message==='Activity is busy, already dispatched or requires recovery');
 assert.equal(h.sent.length,0);assert.equal(h.row().attempts,1);
});

// A same-operation invoice can bill time while its query/mirror still shows the
// pre-invoice Billable representation. Never substitute just that status field.
function billedTimeRuntime({ source = 'query', queriedStatus = 'Billable', standalone = false, change = () => {} } = {}) {
  const value = graph(); value.entries = value.entries.slice(0, standalone ? 2 : 3);
  const estimate = value.entries[0], time = value.entries[1], invoice = value.entries[2];
  if (invoice) {
    invoice.observed.record.Balance = invoice.observed.record.TotalAmt;
    invoice.observed.record.LinkedTxn = invoice.observed.record.LinkedTxn.filter(link => link.TxnType === 'TimeActivity');
    estimate.observed.record.TxnStatus = 'Pending'; delete estimate.observed.record.LinkedTxn;
  } else {
    delete estimate.observed.record.TxnStatus;
    delete estimate.observed.record.LinkedTxn;
    time.observed.record.BillableStatus = 'Billable'; delete time.observed.record.LinkedTxn;
  }
  for (const e of value.entries) e.observed.recordHash = hash(e.observed.record);
  const queried = clone(time.observed); queried.record.BillableStatus = queriedStatus;
  delete queried.record.LinkedTxn; queried.recordHash = hash(queried.record);
  const live = clone(time.observed); change(live.record); live.recordHash = hash(live.record);
  const h = harness(value), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24), calls = [];
  h.models.findOne = filter => { const q = { select() { return q; }, maxTimeMS() { return q; }, lean: async () => clone(value.entries.find(e => filter.logicalKey ? e.step.logicalKey === filter.logicalKey : e.step.entity === filter.entity && e.step.qboId === filter.qboId)?.step || null) }; return q; };
  const local = (entity, id) => {
    const e = value.entries.find(e => e.step.entity === entity && e.step.qboId === id);
    return { ...clone(e.observed), source: { kind: 'qbo-current-mirror' } };
  };
  const observations = { read: async (_s, entity, id) => entity !== 'TimeActivity' ? local(entity, id) : source === 'mirror' ? { ...clone(queried), source: { kind: 'qbo-current-mirror' } } : null,
    saved: async (_s, entity) => entity === 'TimeActivity' && source === 'saved' ? { ...clone(queried), source: { kind: 'qbo-write-response' } } : null, retain: async () => {} };
  const client = Object.create(QBOClient.prototype);
  Object.defineProperty(client, 'apiBase', { value: 'https://sandbox-quickbooks.api.intuit.com/v3/company/123' });
  Object.assign(client, { realmId: scope.realmId, connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, requestMeter: { record() {} }, oauthClient: { makeApiCall: async options => {
    assert.equal(options.method, 'GET'); calls.push(options.url);
    if (options.url.includes('/query?')) {
      assert.match(new URL(options.url).searchParams.get('query'), /FROM TimeActivity WHERE Id IN/);
      return { status: 200, json: { QueryResponse: { TimeActivity: [clone(queried.record)], startPosition: 1, maxResults: 1 } } };
    }
    assert.ok(options.url.endsWith('/timeactivity/' + time.step.qboId), options.url);
    return { status: 200, json: { TimeActivity: clone(live.record) } };
  } } });
  const runtime = createBusinessVerificationRuntime({ scope, operationId: h.writer.operationId, planHash: hash('operation plan'), Steps: h.models, transaction: h.dependencies.transaction, assertReady: h.dependencies.assertReady, access: { authorize: async () => ({ ownerId, actorId }), resolveClient: async () => client }, writerFence: { graphSnapshot: async () => clone(h.writer) }, plans: { loadIntent: async (_s, _o, key) => clone(value.entries.find(e => e.step.logicalKey === key).intent) }, observations, retainSources: true, now: () => h.clock });
  return { h, calls, time, queried, live, read: () => runtime.loadGraphReadback({ scope, roots: value.roots }) };
}
for (const source of ['query', 'mirror', 'saved']) test('same-operation conversion refreshes Billable time from ' + source + ' using one exact GET', async () => {
  const h = billedTimeRuntime({ source }), original = clone(h.queried);
  const result = await h.read(); assert.equal(result.complete, true, JSON.stringify(result.failures));
  assert.equal(h.calls.filter(url => url.includes('/timeactivity/')).length, 1);
  assert.equal(h.calls.length, source === 'query' ? 2 : 1);
  const retained = JSON.parse(result.sourcesJson).find(e => e.step.entity === 'TimeActivity').observed;
  assert.equal(retained.source.kind, 'qbo-full-entity-get'); assert.deepEqual(retained.record, h.live.record);
  assert.equal(retained.recordHash, hash(h.live.record)); assert.deepEqual(h.queried, original);
  assert.ok(result.records.find(r => r.entity === 'Invoice').proof.estimateLinkDropped);
  assert.equal(h.h.opened, h.h.closed);
});
test('a live time GET still returning Billable cannot verify conversion', async () => {
  const h = billedTimeRuntime({ change: record => { record.BillableStatus = 'Billable'; } });
  const result = await h.read(); assert.equal(result.complete, false);
  assert.ok(result.failures.some(f => f.entity === 'Invoice' && f.issues.includes('The complete Estimate conversion links, states or economics remain unverified.')));
  assert.ok(result.records.every(r => r.proof === null));
});
test('refresh cannot hide changed time economics, customer or unrelated invoice links', async () => {
  for (const change of [r => { r.Hours++; }, r => { r.CustomerRef.value = '999'; }, r => { r.LinkedTxn = [{ TxnType: 'Invoice', TxnId: '999' }]; }]) {
    const h = billedTimeRuntime({ change }), result = await h.read(); assert.equal(result.complete, false);
  }
});
test('already billed or standalone time adds no confirmation GET', async () => {
  for (const options of [{ queriedStatus: 'HasBeenBilled' }, { standalone: true }]) {
    const h = billedTimeRuntime(options), result = await h.read(); assert.equal(result.complete, true, JSON.stringify(result.failures));
    assert.equal(h.calls.length, 1); assert.ok(h.calls[0].includes('/query?'));
  }
});
