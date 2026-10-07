'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { createBusinessReferenceReader } = require('./business-reference');
const { compileBusinessTransaction } = require('./business-transaction-compiler');
const { taxExpectation } = require('./business-verification-runtime');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const TAXED = new Set(['Estimate', 'Invoice', 'SalesReceipt', 'PurchaseOrder', 'Bill']);
const sameScope = (a, b) => ['environment', 'realmId', 'connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_COMPILATION_UNAVAILABLE' }); }
// A complete, repeated deposit-link observation is required. No filtered name,
// date or amount search can prove a saved payment is still undeposited.
async function depositSet(client, paymentId, call, check) {
  const rows = new Map(); let bytes = 0, declaredTotal = null;
  for (let start = 1; start <= 10001; start += 1000) {
    const query = 'SELECT * FROM Deposit ORDERBY Id ASC STARTPOSITION ' + start + ' MAXRESULTS 1000';
    const body = await call(() => client.query(query)); check();
    if (!body || Object.keys(body).some(key => !['QueryResponse', 'time'].includes(key)) || !body.QueryResponse || Object.getPrototypeOf(body.QueryResponse) !== Object.prototype) fail('Deposit links could not be read completely.');
    const page = body.QueryResponse;
    if (Object.keys(page).some(key => !['Deposit', 'startPosition', 'maxResults', 'totalCount'].includes(key)) || (page.Deposit !== undefined && !Array.isArray(page.Deposit))) fail('Deposit query returned incomplete or unsupported evidence.');
    const values = page.Deposit || [];
    if (values.length > 1000 || (values.length && page.startPosition !== start) || (page.startPosition !== undefined && page.startPosition !== start) || (page.maxResults !== undefined && page.maxResults !== values.length)) fail('Deposit query pagination is inconsistent.');
    if (page.totalCount !== undefined) {
      if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.totalCount > 10000 || (declaredTotal !== null && declaredTotal !== page.totalCount)) fail('Deposit query count changed or exceeds its budget.');
      declaredTotal = page.totalCount;
    }
    for (const record of values) {
      check(); bytes += Buffer.byteLength(canonical(record));
      if (!record || Object.getPrototypeOf(record) !== Object.prototype || typeof record.Id !== 'string' || !QBO_ID.test(record.Id) || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken) || (record.sparse !== undefined && record.sparse !== false) || !Array.isArray(record.Line) || !record.Line.length || rows.has(record.Id) || rows.size >= 10000 || bytes > 32000000) fail('Deposit records are incomplete, repeated or exceed the observation budget.');
      for (const line of record.Line) {
        if (!line || Object.getPrototypeOf(line) !== Object.prototype || typeof line.Amount !== 'number' || !Number.isFinite(line.Amount) || (line.DetailType !== undefined && line.DetailType !== 'DepositLineDetail') || (line.sparse !== undefined && line.sparse !== false)) fail('A deposit line is incomplete or unsupported.');
        const linked = Array.isArray(line.LinkedTxn) && line.LinkedTxn.length > 0;
        const manual = line.DepositLineDetail && Object.getPrototypeOf(line.DepositLineDetail) === Object.prototype && typeof line.DepositLineDetail.AccountRef?.value === 'string' && QBO_ID.test(line.DepositLineDetail.AccountRef.value);
        if (!linked && !manual) fail('A deposit line lacks complete transaction links or a direct-deposit account.');
      }
      const groups = [record.LinkedTxn, ...record.Line.map(line => line.LinkedTxn)].filter(value => value !== undefined);
      for (const group of groups) {
        if (!Array.isArray(group) || group.some(link => !link || typeof link.TxnId !== 'string' || !QBO_ID.test(link.TxnId) || typeof link.TxnType !== 'string' || !link.TxnType)) fail('Deposit transaction links are incomplete.');
        if (group.some(link => link.TxnId === paymentId)) fail('The payment already belongs to a deposit.');
      }
      rows.set(record.Id, hash(record));
    }
    if (values.length < 1000) {
      if (declaredTotal !== null && declaredTotal !== rows.size) fail('Deposit query omitted records.');
      return hash([...rows].sort((a, b) => a[0].localeCompare(b[0])));
    }
  }
  fail('Deposit observation exceeds the supported record budget.');
}
function createBusinessCompilationRuntime({ scope, operationId, planHash, access, plans, steps, verification, assertReady, now = () => Date.now() }) {
  scope = scoped(scope);
  if (!ID.test(operationId || '') || !HASH.test(planHash || '') || [access?.authorize, access?.resolveClient, plans?.loadIntent, steps?.verifyGraph, steps?.evidence, verification?.readRecord, verification?.readFence, assertReady, now].some(value => typeof value !== 'function')) throw new TypeError('Compilation needs an exact operation and concrete observation adapters');
  const { authorize, resolveClient } = access, { loadIntent } = plans;
  const references = createBusinessReferenceReader({ authorize, resolveClient, now });
  return async function loadCompilationEvidence(input) {
    if (!input || !sameScope(input.scope, scope) || input.operationId !== operationId || !HASH.test(input.logicalKey || '')) fail('Compilation cannot switch the bound operation or company.');
    const supplied = structuredClone(input.intent), logicalKey = input.logicalKey, signal = input.signal;
    const started = now(), controller = new AbortController();
    const abort = () => controller.abort(); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 180000); timer.unref?.();
    const check = () => { if (controller.signal.aborted || !Number.isFinite(now()) || now() < started || now() - started > 180000) fail('Compilation observations were cancelled or exceeded their three-minute budget.'); };
    const call = factory => new Promise((resolve, reject) => {
      const cancel = () => { try { check(); } catch (error) { reject(error); } };
      if (controller.signal.aborted) { cancel(); return; }
      controller.signal.addEventListener('abort', cancel, { once: true });
      Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancel));
    });
    try {
      check(); await call(() => assertReady(scope)); check();
      const actor = await call(() => authorize(scope, 'operations.execute', { signal: controller.signal })); check();
      if (!ID.test(actor?.actorId || '') || !ID.test(actor?.ownerId || '')) fail('Current business execution authority is required.');
      const intent = structuredClone(await call(() => loadIntent(scope, operationId, logicalKey))); check();
      if (!intent || intent.version !== 1 || intent.kind !== 'create' || !sameScope(intent.scope, scope) || intent.operationId !== operationId || intent.planHash !== planHash || intent.logicalKey !== logicalKey || intent.step?.logicalKey !== logicalKey || intent.fingerprint !== hash(intent.step) || canonical(intent) !== canonical(supplied) || !Array.isArray(intent.step.references) || intent.step.references.length > 100 || !Array.isArray(intent.dependencies) || intent.dependencies.length > 20 || !Array.isArray(intent.step.dependencies) || canonical(intent.dependencies) !== canonical(intent.step.dependencies.map(link => ({ logicalKey: link.logicalKey, entity: link.entity, fingerprint: link.fingerprint })))) fail('The original approved creation intent changed.');
      const roots = intent.dependencies.map(value => value.logicalKey);
      if (roots.length) {
        const graph = await call(() => steps.verifyGraph(scope, operationId, roots, { signal: controller.signal })); check();
        if (graph?.complete !== true || graph.persisted !== true) fail('Originating records are not completely verified.');
      }
      const before = await call(() => verification.readFence(scope, { signal: controller.signal })); check();
      if (!sameScope(before?.scope, scope) || before.operationId !== operationId || before.unresolved !== null || !Number.isSafeInteger(before.revision) || before.revision < 0 || before.revision >= Number.MAX_SAFE_INTEGER) fail('The operation writer is not ready for current observations.');
      const tag = { operationId, writerRevision: before.revision };
      const unique = new Map();
      for (const binding of intent.step.references) unique.set(binding.entity + ':' + binding.id, binding);
      const referenceEvidence = [], parents = [], jobs = [];
      for (const binding of unique.values()) jobs.push(async () => {
        const observed = await call(() => references(scope, binding.entity, binding.id, { signal: controller.signal })); check();
        referenceEvidence.push({ ...observed, ...tag });
      });
      for (const dependency of intent.dependencies) jobs.push(async () => {
        const saved = await call(() => steps.evidence(scope, operationId, dependency.logicalKey)); check();
        if (saved?.state !== 'verified' || saved.fresh !== true || saved.fingerprint !== dependency.fingerprint || typeof saved.qboId !== 'string' || !QBO_ID.test(saved.qboId)) fail('An originating activity lacks current persisted proof.');
        const observed = await call(() => verification.readRecord(scope, dependency.entity, saved.qboId, { signal: controller.signal })); check();
        const proof = saved.verification;
        if (!proof || proof.kind !== 'business-readback' || proof.observedHash !== observed.recordHash || proof.syncToken !== observed.record?.SyncToken || typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt)) || now() - Date.parse(proof.observedAt) > 300000 || Date.parse(proof.observedAt) > now()) fail('An originating record changed after graph verification.');
        parents.push({ ...observed, ...tag, logicalKey: dependency.logicalKey, entity: dependency.entity, fingerprint: dependency.fingerprint, state: 'verified', qboId: saved.qboId, syncToken: observed.record.SyncToken });
      });
      let next = 0, error;
      await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
        while (!error && next < jobs.length) { const job = jobs[next++]; try { check(); await job(); } catch (cause) { error ||= cause; controller.abort(); } }
      })); if (error) throw error; check();
      if (intent.entity === 'Deposit') {
        const payment = parents.find(value => value.entity === 'Payment'); if (!payment || parents.length !== 1) fail('A deposit needs one exact verified payment.');
        const client = await call(() => resolveClient(scope, { signal: controller.signal })); check();
        const { QBOClient } = require('./qbo-client');
        const expectedBase = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
        const clientScope = () => { if (!(client instanceof QBOClient) || client.query !== QBOClient.prototype.query || client.apiCall !== QBOClient.prototype.apiCall || client.apiBase !== expectedBase || client.realmId !== scope.realmId || String(client.connection?._id) !== scope.connectionId || String(client.connection?.userId) !== actor.ownerId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active') fail('Deposit observation client changed company.'); };
        clientScope(); const stamp = new Date(now()).toISOString();
        const query = factory => call(() => { clientScope(); return factory(); });
        const first = await depositSet(client, payment.qboId, query, check); clientScope();
        const second = await depositSet(client, payment.qboId, query, check); clientScope();
        if (first !== second) fail('Deposit records changed during availability verification.');
        const current = await call(() => verification.readRecord(scope, 'Payment', payment.qboId, { signal: controller.signal })); check();
        if (current.recordHash !== payment.recordHash) fail('The payment changed during deposit verification.');
        payment.availability = { ...tag, scope, observedAt: stamp, kind: 'undeposited_payment', status: 'available', recordHash: payment.recordHash, evidenceHash: hash({ scope, ...tag, recordHash: payment.recordHash, depositSetHash: first }) };
      }
      const after = await call(() => verification.readFence(scope, { signal: controller.signal })); check();
      if (canonical(before) !== canonical(after)) fail('Company activity changed during compilation observations.');
      const current = await call(() => authorize(scope, 'operations.execute', { signal: controller.signal })); check();
      if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('The operation actor changed during observations.');
      referenceEvidence.sort((a, b) => (a.entity + ':' + a.record.Id).localeCompare(b.entity + ':' + b.record.Id)); parents.sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
      const evidence = { referenceEvidence, parents, observationFence: { scope, ...tag, observedAt: new Date(started).toISOString() } };
      // Preflight all business constraints, including independent tax expectations,
      // before handing any observations to durable dispatch. This creates nothing.
      const compiled = compileBusinessTransaction({ scope, step: intent.step, policy: intent.policy, ...evidence, now: now() });
      if (TAXED.has(intent.entity) && !taxExpectation(intent.policy, compiled)) fail('Approved tax expectations are required before creating this transaction.');
      check(); return evidence;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
module.exports = { createBusinessCompilationRuntime };
