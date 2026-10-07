'use strict';
const { canonical, hash, date } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { validateReferenceBinding } = require('./business-reference');
const { operationHistoryRoots } = require('./business-operation-preview');
const { validateOperationCandidate, validateOperationEntry } = require('./business-operation-plan-store');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/, QBO_ID = /^\d{1,30}$/;
const MAX_BYTES = 8000000, MAX_ENTRIES = 1000;
const ENTITIES = new Set(['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment']);
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_CANDIDATE_UNVERIFIED' }); }
function snapshot(value) {
  let text; try { text = canonical(value); } catch { fail('Operation assembly requires plain JSON.'); }
  if (Buffer.byteLength(text) > MAX_BYTES) fail('Operation assembly exceeds its size budget.');
  return JSON.parse(text);
}
function fresh(value, now) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(now) || !Number.isFinite(time) || new Date(time).toISOString() !== value || time > now || now - time > 300000) fail('Operation preparation or history is stale. Read it again.');
}
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => a?.[key] === b?.[key]);
// Pure structural assembly. Callers must obtain these inputs on the server.
// Hashes are integrity checks, not signatures, ownership proof or authorization.
// No storage, policy approval, activation or QuickBooks request occurs here.
function assembleBusinessOperation({ prepared, history, context, now = Date.now() }) {
  ({ prepared, history, context } = snapshot({ prepared, history, context }));
  const { operationHash, preparedAt, readyToExecute, persisted, summary, limitations, ...payload } = prepared;
  const scope = scoped(payload.scope);
  if (payload.version !== 1 || readyToExecute !== false || persisted !== false || !HASH.test(operationHash || '') || hash(payload) !== operationHash || !Array.isArray(payload.steps) || payload.steps.length > 500) fail('The prepared activity is missing or changed.');
  fresh(preparedAt, now);
  const deferred = new Set(['baseline', 'business_policy', 'period_control', 'execution']);
  if (!Array.isArray(payload.remaining) || payload.remaining.length > 100 || new Set(payload.remaining.map(item => item?.key)).size !== payload.remaining.length || payload.remaining.some(item => !deferred.has(item?.key) || typeof item.reason !== 'string' || !item.reason || item.reason.length > 1000)) fail('Resolve the outstanding operation-wide requirements before assembly.');
  if (!sameScope(context.scope, scope) || context.blueprintHash !== payload.blueprintHash || context.blueprintId !== payload.blueprintId || context.businessKey !== payload.businessKey || context.openingDate !== payload.openingDate) fail('Preparation differs from its company or business plan.');
  const base = { version: 1, scope, businessKey: context.businessKey, blueprintId: context.blueprintId, blueprintHash: context.blueprintHash, baselineHash: context.baselineHash,
    openingDate: context.openingDate, fromDate: payload.fromDate, throughDate: payload.throughDate,
    expectedCursor: context.expectedCursor, expectedRevision: context.expectedRevision, requiredAssertions: context.requiredAssertions };
  // Validate dates, scope, calendar continuity and required checks without inventing policies.
  validateOperationCandidate({ ...base, entries: [] }, scope, now);
  if (!history || typeof history !== 'object') fail('Read original saved activity history before assembly.');
  const { sourceHash, ...source } = history;
  if (source.version !== 1 || !sameScope(source.scope, scope) || !HASH.test(sourceHash || '') || hash(source) !== sourceHash || source.requiresCurrentReadback !== true || !Array.isArray(source.entries) || source.entries.length > MAX_ENTRIES || !Array.isArray(source.missing) || source.missing.length > MAX_ENTRIES || canonical(source.roots) !== canonical(operationHistoryRoots(prepared))) fail('Original history does not match this prepared operation.');
  fresh(source.observedAt, now);
  if (payload.savedHistory && payload.savedHistory.sourceHash !== sourceHash) fail('Prepared history changed. Prepare the activity again.');
  const current = new Map(), original = new Map(), physical = new Set();
  for (const step of payload.steps) {
    if (!step || !ENTITIES.has(step.entity) || !HASH.test(step.calendarFingerprint || '') || !HASH.test(step.detailsHash || '') || !HASH.test(step.logicalKey || '') || current.has(step.logicalKey) || !Array.isArray(step.references) || step.references.length > 100 || !Array.isArray(step.dependencies) || step.dependencies.length > 20 || !Array.isArray(step.blockers)) fail('Prepared activities have missing or duplicate identities.');
    if (step.blockers.some(blocker => !['prior_record', 'blocked_dependency'].includes(blocker?.kind))) fail('Resolve the outstanding activity requirements before assembly.');
    for (const blocker of step.blockers) if (!step.dependencies.some(link => link.logicalKey === blocker.key && (blocker.kind !== 'prior_record' || !payload.steps.some(row => row.logicalKey === blocker.key)))) fail('The outstanding dependency requirements are inconsistent.');
    if (new Set(step.references.map(ref => ref.entity + ':' + ref.key)).size !== step.references.length || new Set(step.dependencies.map(link => link.logicalKey)).size !== step.dependencies.length || step.dependencies.some(link => !HASH.test(link.logicalKey || '') || !ENTITIES.has(link.entity))) fail('Activity references or dependencies are ambiguous.');
    for (const binding of step.references) validateReferenceBinding(binding);
    date(step.txnDate);
    if (step.txnDate < base.fromDate || step.txnDate > base.throughDate || step.details?.version !== 1 || step.details.currency !== 'CAD' || hash({ calendarFingerprint: step.calendarFingerprint, details: step.details }) !== step.detailsHash || !Array.isArray(step.details.lines) || step.details.lines.length > 100) fail('Prepared transaction details are missing or changed.');
    current.set(step.logicalKey, step);
  }
  for (const entry of source.entries) {
    if (!entry || !HASH.test(entry.logicalKey || '') || original.has(entry.logicalKey)) fail('Original activity ownership is ambiguous.');
    if (current.has(entry.logicalKey)) fail('Current activity already belongs to a saved operation. Resume that operation instead.');
    if (entry.businessKey !== base.businessKey || typeof entry.operationId !== 'string' || !ID.test(entry.operationId || '') || !HASH.test(entry.planHash || '') || !['saved', 'verified'].includes(entry.state) || typeof entry.qboId !== 'string' || !QBO_ID.test(entry.qboId || '') || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || entry.entity !== entry.step?.entity || entry.logicalKey !== entry.step?.logicalKey || entry.fingerprint !== hash(entry.step)) fail('The earlier activity has no exact saved business ownership.');
    const identity = entry.entity + ':' + entry.qboId;
    if (physical.has(identity)) fail('Several earlier activities claim the same QuickBooks record.');
    physical.add(identity);
    validateOperationEntry({ kind: 'existing', step: entry.step, policy: entry.policy }, scope, base.fromDate, base.throughDate);
    original.set(entry.logicalKey, entry);
  }
  // All current activities must have been queried and found locally absent.
  // This says nothing about unmanaged QBO records; baseline ownership is still required.
  if (canonical([...source.missing].sort()) !== canonical([...current.keys()].sort())) fail('History has missing earlier activities or incomplete current coverage.');
  if (current.size + original.size > MAX_ENTRIES) fail('Operation assembly exceeds 1,000 activities.');
  const visiting = new Set(), retained = new Map(), origins = []; let bytes = Buffer.byteLength(canonical(base));
  const visit = key => {
    if (visiting.has(key)) fail('Operation dependencies contain a cycle.');
    if (retained.has(key)) return retained.get(key);
    const previous = original.get(key), proposed = current.get(key), input = previous?.step || proposed;
    if (!input) fail('An original dependency is missing.');
    visiting.add(key);
    const dependencies = input.dependencies.map(link => {
      const parent = visit(link.logicalKey), fingerprint = hash(parent.step);
      if (parent.step.entity !== link.entity || parent.step.txnDate > input.txnDate || (previous && link.fingerprint !== fingerprint) || (!previous && link.fingerprint !== undefined && link.fingerprint !== fingerprint)) fail('A dependency differs from its exact originating activity.');
      return { logicalKey: link.logicalKey, entity: link.entity, fingerprint };
    });
    let entry;
    if (previous) {
      // Preserve original canonical content, including its original policy and refs.
      entry = { kind: 'existing', step: previous.step, policy: previous.policy };
      origins.push({ logicalKey: key, operationId: previous.operationId, planHash: previous.planHash, fingerprint: previous.fingerprint, qboId: previous.qboId, state: previous.state, revision: previous.revision });
    } else {
      const references = input.references.map(ref => ({ key: ref.key, entity: ref.entity, id: ref.id, syncToken: ref.syncToken, status: ref.status, definition: ref.definition })).sort((a, b) => (a.entity + ':' + a.key).localeCompare(b.entity + ':' + b.key));
      const step = { logicalKey: input.logicalKey, entity: input.entity, txnDate: input.txnDate, calendarFingerprint: input.calendarFingerprint, detailsHash: input.detailsHash, details: input.details, references, dependencies: dependencies.sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) };
      const detailLinks = (step.details.references || []).map(link => ({ logicalKey: link.logicalKey, entity: link.entity })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
      if (canonical(detailLinks) !== canonical(step.dependencies.map(({ logicalKey, entity }) => ({ logicalKey, entity })))) fail('Transaction details and dependencies differ.');
      entry = { kind: 'create', step };
    }
    bytes += Buffer.byteLength(canonical(entry)); if (bytes > MAX_BYTES) fail('Operation assembly exceeds its size budget.');
    visiting.delete(key); retained.set(key, entry); return entry;
  };
  for (const key of [...current.keys()].sort()) visit(key);
  if (retained.size !== current.size + original.size) fail('History contains unrelated earlier activities.');
  const value = { version: 1, candidate: { ...base, entries: [...retained.values()] }, sources: { operationHash, historyHash: sourceHash, preparedAt, historyObservedAt: source.observedAt }, origins,
    requirements: payload.remaining.map(({ key, reason }) => ({ key, reason })),
    policyRequests: [...retained.values()].filter(entry => entry.kind === 'create').map(entry => ({ logicalKey: entry.step.logicalKey, stepHash: hash(entry.step) })),
    persisted: false, readyToExecute: false, requiresActivationFence: true, requiresOwnershipReview: true, requiresFreshReadback: true };
  const result = { ...value, assemblyHash: hash(value) }; snapshot(result); return result;
}
// A matching status/hash is not proof of authorization. The production caller
// must load reviewed policies itself and fence their current activation on approve.
function bindApprovedOperationPolicies(assembly, policies, now = Date.now()) {
  ({ assembly, policies } = snapshot({ assembly, policies }));
  const { assemblyHash, ...value } = assembly;
  if (value.version !== 1 || value.persisted !== false || value.readyToExecute !== false || value.requiresActivationFence !== true || value.requiresOwnershipReview !== true || value.requiresFreshReadback !== true || !HASH.test(assemblyHash || '') || hash(value) !== assemblyHash || !Array.isArray(value.policyRequests) || !Array.isArray(policies) || policies.length !== value.policyRequests.length) fail('The reviewed assembly or exact policy set changed.');
  fresh(value.sources.preparedAt, now); fresh(value.sources.historyObservedAt, now);
  const expected = value.candidate.entries.filter(entry => entry.kind === 'create').map(entry => ({ logicalKey: entry.step.logicalKey, stepHash: hash(entry.step) }));
  if (canonical(expected) !== canonical(value.policyRequests)) fail('The assembly policy requests differ from its finalized activities.');
  const expectedKeys = new Set(expected.map(entry => entry.logicalKey));
  const byKey = new Map();
  for (const supplied of policies) {
    if (!supplied || !HASH.test(supplied.logicalKey || '') || !expectedKeys.has(supplied.logicalKey) || byKey.has(supplied.logicalKey)) fail('Every new activity needs one exact approved policy.');
    byKey.set(supplied.logicalKey, supplied.policy);
  }
  const entries = value.candidate.entries.map(entry => {
    if (entry.kind !== 'create') return entry;
    const policy = byKey.get(entry.step.logicalKey);
    if (!policy || policy.stepHash !== hash(entry.step)) fail('The approved policy does not match the finalized activity.');
    return { kind: 'create', step: entry.step, policy };
  });
  const candidate = { ...value.candidate, entries }, checked = validateOperationCandidate(candidate, candidate.scope, now);
  return { candidate: { ...candidate, entries: checked.entries }, candidateHash: hash({ ...candidate, entries: checked.entries }), planHash: checked.planHash,
    assemblyHash, requirements: value.requirements, persisted: false, readyToExecute: false, requiresActivationFence: true, requiresOwnershipReview: true, requiresFreshReadback: true };
}
module.exports = { assembleBusinessOperation, bindApprovedOperationPolicies };
