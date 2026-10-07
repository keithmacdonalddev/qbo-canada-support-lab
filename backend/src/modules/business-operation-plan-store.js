'use strict';
const { hash, canonical, date, shift } = require('./business-calendar');
const { validateReferenceBinding } = require('./business-reference');
const { businessDate } = require('./business-activity-preview');
const { assertRun, assertRunApproval } = require('./business-period-store');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const ENTITIES = new Set(['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment']);
const REFS = new Set(['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'TaxCode']);
const MAX_RECORDS = 1000, MAX_CREATES = 500, MAX_BYTES = 8000000;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_PLAN_UNVERIFIED' }); }
function scopeOf(scope) {
  if (!scope || typeof scope.realmId !== 'string' || !QBO_ID.test(scope.realmId) || !['production', 'sandbox'].includes(scope.environment) || typeof scope.connectionId !== 'string' || !ID.test(scope.connectionId)) fail('Exact connected company scope is required', 400);
  return { realmId: scope.realmId, environment: scope.environment, connectionId: scope.connectionId };
}
function sameScope(a, b) { return ['realmId', 'environment', 'connectionId'].every(key => String(a?.[key]) === String(b?.[key])); }
function validHash(value) { return typeof value === 'string' && HASH.test(value); }
function snapshot(value) {
  let serialized;
  try { serialized = canonical(value); } catch { fail('The operation plan must contain plain bounded JSON'); }
  if (Buffer.byteLength(serialized) > MAX_BYTES) fail('The operation plan exceeds its storage budget');
  return JSON.parse(serialized);
}
function validateEntry(entry, scope, fromDate, throughDate) {
  const step = entry?.step, policy = entry?.policy;
  if (!['create', 'existing'].includes(entry?.kind) || !step || !validHash(step.logicalKey) || !ENTITIES.has(step.entity) || !validHash(step.calendarFingerprint) || !validHash(step.detailsHash)) fail('A saved activity needs its exact supported intent');
  date(step.txnDate);
  if (step.txnDate > throughDate || (entry.kind === 'create' && step.txnDate < fromDate) || (entry.kind === 'existing' && step.txnDate >= fromDate)) fail('An activity is outside its declared new or earlier period');
  if (step.details?.version !== 1 || step.details.currency !== 'CAD' || hash({ calendarFingerprint: step.calendarFingerprint, details: step.details }) !== step.detailsHash || !Array.isArray(step.details.lines) || step.details.lines.length > 100) fail('Saved business quantities or amounts changed');
  if (!Array.isArray(step.references) || step.references.length > 100 || new Set(step.references.map(ref => ref.entity + ':' + ref.key)).size !== step.references.length || step.references.some(ref => !REFS.has(ref.entity) || typeof ref.key !== 'string' || !ref.key || ref.key.length > 100 || typeof ref.id !== 'string' || !QBO_ID.test(ref.id) || typeof ref.syncToken !== 'string' || !VERSION.test(ref.syncToken) || ref.status !== 'resolved')) fail('Every activity needs exact resolved company record choices');
  for (const binding of step.references) validateReferenceBinding(binding);
  if (!Array.isArray(step.dependencies) || step.dependencies.length > 20 || new Set(step.dependencies.map(link => link.logicalKey)).size !== step.dependencies.length || step.dependencies.some(link => !validHash(link.logicalKey) || !validHash(link.fingerprint) || !ENTITIES.has(link.entity) || link.logicalKey === step.logicalKey)) fail('Every dependency needs its exact saved identity');
  if (!Array.isArray(step.details.references) || canonical(step.details.references.map(link => ({ logicalKey: link.logicalKey, entity: link.entity })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey))) !== canonical(step.dependencies.map(link => ({ logicalKey: link.logicalKey, entity: link.entity })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)))) fail('Activity and detail dependencies differ');
  if (!policy || policy.version !== 1 || policy.status !== 'approved' || !sameScope(policy.scope, scope) || policy.country !== 'CA' || policy.currency !== 'CAD' || policy.stepHash !== hash(step) || !validHash(policy.evidenceHash)) fail('Each activity requires its exact approved Canadian business policy');
  date(policy.fromDate); date(policy.throughDate);
  if (step.txnDate < policy.fromDate || step.txnDate > policy.throughDate || policy.fromDate > policy.throughDate) fail('The business policy does not cover its activity date');
  return { logicalKey: step.logicalKey, entity: step.entity, fingerprint: hash(step), policyHash: hash(policy), kind: entry.kind, relationships: step.dependencies.map(link => link.logicalKey).sort() };
}
// Takes server-owned prepared intent, never an arbitrary route body. Policy
// approval and baseline/blueprint activation must be established by that loader.
function validateOperationCandidate(candidate, scope, now = Date.now()) {
  scope = scopeOf(scope); const copy = snapshot(candidate);
  if (copy.version !== 1 || !sameScope(copy.scope, scope) || typeof copy.businessKey !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(copy.businessKey) || !ID.test(copy.blueprintId || '') || !validHash(copy.blueprintHash) || !validHash(copy.baselineHash) || !Number.isSafeInteger(copy.expectedRevision) || copy.expectedRevision < 0 || copy.expectedRevision >= Number.MAX_SAFE_INTEGER) fail('The operation needs an exact blueprint, baseline and calendar revision');
  date(copy.fromDate); date(copy.throughDate);
  if (!Number.isFinite(now) || copy.fromDate > copy.throughDate || date(copy.throughDate) - date(copy.fromDate) >= 31 * 86400000 || copy.throughDate > businessDate(new Date(now))) fail('Prepare at most 31 elapsed business days');
  date(copy.openingDate);
  if (copy.expectedCursor === null ? copy.fromDate !== copy.openingDate : (date(copy.expectedCursor), shift(copy.expectedCursor, 1) !== copy.fromDate || copy.expectedCursor < copy.openingDate)) fail('The operation must immediately follow the verified business calendar');
  if (!Array.isArray(copy.entries) || copy.entries.length > MAX_RECORDS || copy.entries.filter(entry => entry?.kind === 'create').length > MAX_CREATES) fail('The operation exceeds its bounded record capacity');
  const records = copy.entries.map(entry => validateEntry(entry, scope, copy.fromDate, copy.throughDate));
  const byKey = new Map(copy.entries.map(entry => [entry.step.logicalKey, entry]));
  if (byKey.size !== copy.entries.length) fail('Activity identities must be unique');
  const visiting = new Set(), ordered = [], done = new Set();
  const visit = key => {
    if (visiting.has(key)) fail('Activity dependencies contain a cycle');
    if (done.has(key)) return;
    const entry = byKey.get(key); visiting.add(key);
    for (const link of entry.step.dependencies) {
      const parent = byKey.get(link.logicalKey);
      if (!parent || parent.step.entity !== link.entity || hash(parent.step) !== link.fingerprint || parent.step.txnDate > entry.step.txnDate) fail('The operation lacks the exact complete originating record set');
      visit(link.logicalKey);
    }
    visiting.delete(key); done.add(key); ordered.push(key);
  };
  for (const key of [...byKey.keys()].sort()) visit(key);
  // Earlier entries must actually belong to a new activity's dependency closure.
  const needed = new Set();
  const retain = key => { if (needed.has(key)) return; needed.add(key); for (const link of byKey.get(key).step.dependencies) retain(link.logicalKey); };
  for (const entry of copy.entries.filter(entry => entry.kind === 'create')) retain(entry.step.logicalKey);
  if (needed.size !== byKey.size) fail('The operation contains unrelated earlier records');
  const expectedRecordSetHash = hash(records.map(({ logicalKey, entity, fingerprint, relationships }) => ({ logicalKey, entity, fingerprint, relationships })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)));
  const descriptors = new Map(records.map(row => [row.logicalKey, row]));
  const manifest = { version: 1, scope, businessKey: copy.businessKey, blueprintId: copy.blueprintId, blueprintHash: copy.blueprintHash, baselineHash: copy.baselineHash,
    openingDate: copy.openingDate, fromDate: copy.fromDate, throughDate: copy.throughDate, expectedCursor: copy.expectedCursor, expectedRevision: copy.expectedRevision,
    requiredAssertions: copy.requiredAssertions, recordCount: records.length, createCount: records.filter(row => row.kind === 'create').length, expectedRecordSetHash, records: ordered.map(key => descriptors.get(key)) };
  const planHash = hash(manifest);
  assertRun({ ...scope, ...manifest, contractVersion: 1, planHash }, scope);
  return { manifest, planHash, entries: ordered.map(logicalKey => byKey.get(logicalKey)) };
}
function runFields(manifest, planId, actorId) {
  return { contractVersion: 1, ...manifest.scope, businessKey: manifest.businessKey, blueprintId: manifest.blueprintId, blueprintHash: manifest.blueprintHash, planId, planHash: hash(manifest),
    fromDate: manifest.fromDate, throughDate: manifest.throughDate, expectedCursor: manifest.expectedCursor, expectedRevision: manifest.expectedRevision, baselineHash: manifest.baselineHash,
    expectedRecordSetHash: manifest.expectedRecordSetHash, requiredAssertions: manifest.requiredAssertions, recordCount: manifest.recordCount, createdBy: actorId };
}
// All adapters are explicit. checkCurrent MUST fence activation, policy approval,
// baseline and calendar revision in this transaction, not just return a boolean.
// This module has no default storage, route, execution or production activation.
function createBusinessOperationPlanStore({ Plans, Intents, Runs, Steps, loadCandidate, checkCurrent, assertReady, authorize, transaction, writeAudit, now = () => Date.now(), readOnly = false }) {
  if (typeof readOnly !== 'boolean') throw new TypeError('Saved plan reader mode must be explicit');
  for (const fn of [assertReady, authorize, transaction, now, ...(!readOnly ? [loadCandidate, checkCurrent, writeAudit] : [])]) if (typeof fn !== 'function') throw new TypeError('Operation plans require explicit trusted adapters');
  async function authority(scope, action, session) {
    await assertReady(); const actor = await authorize(scope, action, { session });
    if (!actor || typeof actor.actorId !== 'string' || !ID.test(actor.actorId)) fail('Business operation permission is required', 403);
    return actor.actorId;
  }
  async function audit(scope, actorId, operationId, planHash, phase, session) {
    const eventKey = 'business-plan:' + operationId + ':' + phase;
    const result = await writeAudit(eventKey, { ...scope, actorId, operationId, planHash, phase }, session);
    if (result?.eventKey !== eventKey || typeof result.id !== 'string' || !result.id) fail('Operation plan audit was not saved');
    return result.id;
  }
  async function read(scope, operationId, session, check = () => {}) {
    check();
    if (typeof operationId !== 'string' || !ID.test(operationId)) fail('A valid operation identifier is required', 400);
    const run = await Runs.findOne({ _id: operationId, ...scope }).session(session).maxTimeMS(3000).lean();
    check(); assertRun(run, scope);
    const plan = await Plans.findOne({ _id: run.planId, ...scope }).session(session).maxTimeMS(3000).lean();
    check(); if (!plan || plan.contractVersion !== 1 || plan.planHash !== run.planHash || hash(plan.manifest) !== plan.planHash || !sameScope(plan.manifest.scope, scope) || String(plan.operationId) !== operationId || !plan.auditId) fail('The immutable saved operation plan is missing or changed');
    const expected = runFields(plan.manifest, String(plan._id), String(plan.createdBy));
    for (const [key, value] of Object.entries(expected)) {
      const actual = ['planId', 'blueprintId', 'connectionId', 'createdBy'].includes(key) ? String(run[key]) : run[key];
      if (canonical(actual) !== canonical(value)) fail('The operation run differs from its saved plan');
    }
    return { run, plan };
  }
  async function prepare(scope, request) {
    scope = scopeOf(scope);
    if (!request || typeof request.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(request.requestKey) || !validHash(request.candidateHash) || Object.keys(request).some(key => !['requestKey', 'candidateHash'].includes(key))) fail('Prepare needs an exact server candidate and request identifier', 400);
    request = { ...request };
    const actorId = await authority(scope, 'operations.preview');
    const operationId = hash({ scope, actorId, requestKey: request.requestKey }).slice(0, 24);
    const planId = hash({ operationId, type: 'business-plan' }).slice(0, 24);
    return transaction(async session => {
      if (await authority(scope, 'operations.preview', session) !== actorId) fail('The operation actor changed', 403);
      const existing = await Runs.findOne({ _id: operationId, ...scope }).session(session).lean();
      if (existing) {
        const saved = await read(scope, operationId, session);
        if (saved.plan.candidateHash !== request.candidateHash || saved.plan.requestKey !== request.requestKey || String(saved.plan.createdBy) !== actorId) fail('This preparation identifier already belongs to different work');
        await loadEntries(scope, operationId, 0, MAX_RECORDS, session);
        return { operationId, planHash: saved.plan.planHash, status: saved.run.status, persisted: true, reused: true };
      }
      const candidate = snapshot(await loadCandidate(scope, request.candidateHash, session));
      if (hash(candidate) !== request.candidateHash) fail('The server candidate changed before it could be saved');
      const prepared = validateOperationCandidate(candidate, scope, now());
      const auditId = await audit(scope, actorId, operationId, prepared.planHash, 'prepared', session);
      await Plans.create([{ _id: planId, contractVersion: 1, ...scope, operationId, createdBy: actorId, requestKey: request.requestKey, candidateHash: request.candidateHash, manifest: prepared.manifest, planHash: prepared.planHash, auditId }], { session });
      // Bounded immutable documents keep receipts and future verification out of the plan.
      if (prepared.entries.length) await Intents.insertMany(prepared.entries.map((entry, ordinal) => ({ _id: hash({ planId, logicalKey: entry.step.logicalKey }).slice(0, 24), contractVersion: 1, ...scope, planId, planHash: prepared.planHash, ordinal, kind: entry.kind, step: entry.step, policy: entry.policy, fingerprint: hash(entry.step), logicalKey: entry.step.logicalKey })), { session, ordered: true });
      await Runs.create([{ _id: operationId, ...runFields(prepared.manifest, planId, actorId), status: 'previewed', approval: null }], { session });
      return { operationId, planHash: prepared.planHash, status: 'previewed', persisted: true, reused: false };
    });
  }
  async function approve(scope, operationId, planHash) {
    scope = scopeOf(scope); if (!validHash(planHash)) fail('Exact reviewed plan hash is required', 400);
    const actorId = await authority(scope, 'operations.execute');
    return transaction(async session => {
      if (await authority(scope, 'operations.execute', session) !== actorId) fail('The operation actor changed', 403);
      const { run, plan } = await read(scope, operationId, session);
      if (plan.planHash !== planHash) fail('The reviewed operation plan changed');
      await loadEntries(scope, operationId, 0, MAX_RECORDS, session);
      if (run.status !== 'previewed') {
        assertRunApproval(run);
        return { operationId, planHash, status: run.status, approved: true, reused: true };
      }
      if (plan.manifest.throughDate > businessDate(new Date(now()))) fail('Future periods cannot be approved');
      const fence = await checkCurrent({ scope, operationId, planHash, manifest: snapshot(plan.manifest), actorId, session });
      if (!fence || !sameScope(fence.scope, scope) || fence.operationId !== operationId || fence.planHash !== planHash || fence.actorId !== actorId || fence.expectedRevision !== run.expectedRevision || !validHash(fence.fenceHash)) fail('Current blueprint, baseline, policies and calendar could not be fenced');
      const auditId = await audit(scope, actorId, operationId, planHash, 'approved', session);
      const approval = { actorId, planHash, fenceHash: fence.fenceHash, auditId, approvedAt: new Date(now()).toISOString() };
      const saved = await Runs.findOneAndUpdate({ _id: operationId, ...scope, status: 'previewed', planHash, approval: null }, { $set: { status: 'approved', approval } }, { new: true, session }).lean();
      if (!saved) fail('Operation approval changed concurrently');
      return { operationId, planHash, status: 'approved', approved: true, reused: false };
    });
  }
  async function loadEntries(scope, operationId, offset, limit, session) {
    const { run, plan } = await read(scope, operationId, session);
    const rows = await Intents.find({ ...scope, planId: plan._id, planHash: plan.planHash, ordinal: { $gte: offset, $lt: offset + limit } }).sort({ ordinal: 1 }).limit(limit).session(session).lean();
    const wanted = plan.manifest.records.slice(offset, offset + limit);
    if (rows.length !== wanted.length) fail('Saved operation activities are missing');
    rows.forEach((row, index) => {
      const descriptor = validateEntry(row, scope, plan.manifest.fromDate, plan.manifest.throughDate);
      if (row.contractVersion !== 1 || row.ordinal !== offset + index || row.logicalKey !== descriptor.logicalKey || row.fingerprint !== descriptor.fingerprint || canonical(descriptor) !== canonical(wanted[index])) fail('Saved operation activity differs from its immutable manifest');
    });
    return { run, plan, rows };
  }
  async function page(scope, operationId, offset = 0, limit = 50) {
    scope = scopeOf(scope);
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_RECORDS || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('Operation page must use a bounded offset and limit', 400);
    await authority(scope, 'operations.preview');
    return transaction(async session => {
      await authority(scope, 'operations.preview', session);
      const { run, plan, rows } = await loadEntries(scope, operationId, offset, limit, session);
      return { operationId, planHash: plan.planHash, status: run.status, recordCount: plan.manifest.recordCount, offset, nextOffset: offset + rows.length < plan.manifest.recordCount ? offset + rows.length : null,
        entries: rows.map(row => snapshot({ kind: row.kind, step: row.step, policy: row.policy })) };
    });
  }
  async function loadIntent(scope, operationId, logicalKey) {
    scope = scopeOf(scope); if (!validHash(logicalKey)) fail('An exact activity key is required', 400);
    await authority(scope, 'operations.preview');
    return transaction(async session => {
      await authority(scope, 'operations.preview', session);
      const { plan } = await read(scope, operationId, session), ordinal = plan.manifest.records.findIndex(row => row.logicalKey === logicalKey);
      if (ordinal < 0) fail('The activity is not part of this operation');
      const { rows } = await loadEntries(scope, operationId, ordinal, 1, session), row = rows[0];
      return { version: 1, scope, operationId, planHash: plan.planHash, logicalKey, entity: row.step.entity, fingerprint: row.fingerprint,
        dependencies: row.step.dependencies.map(link => ({ logicalKey: link.logicalKey, entity: link.entity, fingerprint: link.fingerprint })), kind: row.kind, step: snapshot(row.step), policy: snapshot(row.policy) };
    });
  }
  // Local saved history only. Missing entries do not establish QBO absence.
  // Query across connection IDs first so reconnects cannot hide existing work.
  async function history(scope, logicalKeys, { signal } = {}) {
    scope = scopeOf(scope);
    if (!Steps || !Array.isArray(logicalKeys) || logicalKeys.length > MAX_RECORDS || new Set(logicalKeys).size !== logicalKeys.length || logicalKeys.some(key => !validHash(key))) fail('History needs at most 1,000 distinct activity identities', 400);
    const roots = [...logicalKeys].sort(), started = now(), controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30000); timer.unref?.();
    const check = () => { const time = now(); if (controller.signal.aborted || !Number.isFinite(time) || time < started || time - started > 30000) fail('Saved history reading was cancelled or exceeded its time budget'); };
    const call = factory => new Promise((resolve, reject) => {
      const cancelled = () => { try { check(); } catch (error) { reject(error); } };
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
    });
    const historyAuthority = async session => {
      await call(() => assertReady({ signal: controller.signal })); check();
      const actor = await call(() => authorize(scope, 'operations.preview', { session, signal: controller.signal })); check();
      if (!ID.test(actor?.actorId || '')) fail('Business operation permission is required', 403);
      return actor.actorId;
    };
    try {
    const actorId = await historyAuthority(); check();
    const observed = await call(() => transaction(async session => {
      check(); if (await historyAuthority(session) !== actorId) fail('The operation actor changed', 403); check();
      const entries = new Map(), missing = new Set(), queued = new Set(roots), pending = [...roots], plans = new Map(), physical = new Map(); let bytes = 0;
      const retainSize = value => { bytes += Buffer.byteLength(canonical(value)); if (bytes > MAX_BYTES) fail('Saved history exceeds its retained size budget'); };
      while (pending.length) {
        check(); const keys = pending.splice(0, 100);
        const rows = await call(() => Steps.find({ realmId: scope.realmId, environment: scope.environment, logicalKey: { $in: keys } })
          .select('contractVersion realmId environment connectionId operationId planHash logicalKey fingerprint entity dependencies state revision qboId')
          .limit(keys.length + 1).session(session).maxTimeMS(3000).lean()); check();
        const found = new Set(), groups = new Map();
        for (const row of rows) {
          if (!keys.includes(row.logicalKey) || found.has(row.logicalKey)) fail('Saved activity ownership is ambiguous');
          found.add(row.logicalKey);
          if (!sameScope(row, scope)) fail('Saved activity belongs to an earlier or different company connection; it requires reviewed recovery');
          if (row.contractVersion !== 1 || !ID.test(String(row.operationId)) || !validHash(row.planHash) || !validHash(row.fingerprint) || !ENTITIES.has(row.entity) || !['claimed', 'dispatched', 'unknown', 'saved', 'verified', 'rejected'].includes(row.state) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Array.isArray(row.dependencies)) fail('Saved activity ownership is incomplete');
          if (row.qboId != null && (typeof row.qboId !== 'string' || !QBO_ID.test(row.qboId))) fail('Saved activity record identity is invalid');
          if (['saved', 'verified'].includes(row.state) && !row.qboId) fail('Saved activity has no exact QuickBooks record identity');
          if (row.qboId) {
            const key = row.entity + ':' + row.qboId;
            if (physical.has(key) && physical.get(key) !== row.logicalKey) fail('Several activities claim the same QuickBooks record');
            physical.set(key, row.logicalKey);
          }
          const operationId = String(row.operationId);
          if (!plans.has(operationId)) {
            const saved = await call(() => read(scope, operationId, session, check)); check(); assertRunApproval(saved.run);
            if (saved.run.status === 'previewed') fail('Saved activity has no approved originating operation');
            retainSize(saved.plan.manifest);
            plans.set(operationId, { ...saved, byKey: new Map(saved.plan.manifest.records.map((value, ordinal) => [value.logicalKey, { value, ordinal }])) });
          }
          const saved = plans.get(operationId);
          if (saved.plan.planHash !== row.planHash) fail('Saved activity differs from its original operation');
          if (!groups.has(operationId)) groups.set(operationId, []);
          groups.get(operationId).push(row);
        }
        for (const key of keys) if (!found.has(key)) missing.add(key);
        for (const [operationId, steps] of groups) {
          const saved = plans.get(operationId), keys = steps.map(row => row.logicalKey);
          const intents = await call(() => Intents.find({ ...scope, planId: saved.plan._id, planHash: saved.plan.planHash, logicalKey: { $in: keys } })
            .limit(keys.length + 1).session(session).maxTimeMS(3000).lean()); check();
          const byKey = new Map(intents.map(row => [row.logicalKey, row]));
          if (intents.length !== keys.length || byKey.size !== keys.length) fail('Original saved activity intents are missing or ambiguous');
          for (const row of steps) {
            const intent = byKey.get(row.logicalKey), expected = saved.byKey.get(row.logicalKey);
            const descriptor = validateEntry(intent, scope, saved.plan.manifest.fromDate, saved.plan.manifest.throughDate);
            if (!expected || intent.contractVersion !== 1 || intent.kind !== 'create' || intent.ordinal !== expected.ordinal || intent.fingerprint !== row.fingerprint || descriptor.fingerprint !== row.fingerprint || intent.step.entity !== row.entity || canonical(descriptor) !== canonical(expected.value) || canonical(row.dependencies) !== canonical(intent.step.dependencies.map(link => ({ logicalKey: link.logicalKey, fingerprint: link.fingerprint, entity: link.entity })))) fail('Saved activity differs from its original immutable creation intent');
            const value = snapshot({ businessKey: saved.plan.manifest.businessKey, operationId, planHash: row.planHash, runStatus: saved.run.status, logicalKey: row.logicalKey, entity: row.entity, fingerprint: row.fingerprint, state: row.state, revision: row.revision, qboId: row.qboId || null, step: intent.step, policy: intent.policy });
            retainSize(value); entries.set(row.logicalKey, value);
            for (const link of value.step.dependencies) if (!queued.has(link.logicalKey)) {
              if (queued.size >= MAX_RECORDS) fail('Saved dependency history exceeds 1,000 activities');
              queued.add(link.logicalKey); pending.push(link.logicalKey);
            }
          }
        }
      }
      const visiting = new Set(), done = new Set(), ordered = [];
      const visit = key => {
        check(); if (visiting.has(key)) fail('Saved activity history contains a dependency cycle');
        if (done.has(key) || missing.has(key)) return;
        const entry = entries.get(key); if (!entry) fail('Saved activity history is incomplete');
        visiting.add(key);
        for (const link of entry.step.dependencies) {
          const parent = entries.get(link.logicalKey);
          if (!parent || parent.entity !== link.entity || parent.fingerprint !== link.fingerprint || parent.step.txnDate > entry.step.txnDate) fail('An original saved dependency is missing or changed');
          visit(link.logicalKey);
        }
        visiting.delete(key); done.add(key); ordered.push(entry);
      };
      for (const key of roots) visit(key);
      if (await historyAuthority(session) !== actorId) fail('The operation actor changed', 403); check();
      const result = { version: 1, scope, roots, entries: ordered, missing: [...missing].sort(), observedAt: new Date(now()).toISOString(), requiresCurrentReadback: true };
      return { ...result, sourceHash: hash(result) };
    }));
    check(); if (await historyAuthority() !== actorId) fail('The operation actor changed', 403); check();
    return observed;
    } catch (error) {
      // This method performs local storage/validation only, never QBO transport.
      if (!error.code && [400, 403, 409].includes(error.status)) error.code = 'BUSINESS_PLAN_UNVERIFIED';
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  return readOnly ? { page, loadIntent, history } : { prepare, approve, page, loadIntent, history };
}
module.exports = { createBusinessOperationPlanStore, validateOperationCandidate, validateOperationEntry: validateEntry };
