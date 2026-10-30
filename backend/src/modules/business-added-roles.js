'use strict';
// Customers, suppliers and service items the accountant added (activity policy v6).
// The registry is derived, append-only evidence: a role exists only when its creating
// list step is verified with its own creation proof AND that step's whole operation
// verified with its completion evidence. Nothing here writes, so there is no separate
// activation record to lose or duplicate. A role is never reassigned and never adopts
// a record by name. An entry whose evidence is incomplete, duplicated or beyond
// capacity is listed as unusable (with its reason) instead of blocking other work.
const { hash } = require('./business-calendar');
const QBO_ID = /^\d{1,30}$/, HASH = /^[a-f0-9]{64}$/;
const ENTITY = Object.freeze({ customer: 'Customer', supplier: 'Vendor', item: 'Item' });
const KIND = Object.freeze({ Customer: 'customer', Vendor: 'supplier', Item: 'item' });
const LIST_TYPES = Object.freeze(['add-customer', 'add-supplier', 'add-item']);
const MAX_ROLES = 1000;
// Steps that may have created (or may still create) a QuickBooks list record.
const CREATED_STATES = ['dispatched', 'unknown', 'saved', 'verified'];
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_ADDED_ROLE_UNVERIFIED' }); }
const same = (a, b) => a != null && b != null && String(a) === String(b);
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => same(a?.[key], b?.[key]));
function parse(body) { try { const value = JSON.parse(body); return value && typeof value === 'object' ? value : null; } catch { return null; } }
// The step's own creation chain: compiled request for this company, its dispatch,
// the receipt for that dispatch (with its evidence hash), and a read-back
// verification whose evidence hash is recomputed from that receipt and the observed
// record, with the retained full definition of the saved record.
function creationProblem(step, company) {
  const c = step.compilation, d = step.dispatch, r = step.receipt, v = step.verification;
  let request;
  try { request = require('./business-readback').validateCompilation(c); } catch { return 'its saved creation request is invalid'; }
  if (!sameScope(request.scope, company) || c.entity !== step.entity || c.logicalKey !== step.logicalKey || c.intentHash !== step.fingerprint || !d || c.compilationHash !== d.compilationHash || request.requestHash !== d.requestHash) return 'its creation request does not match its dispatch for this company';
  if (!r || r.version !== 1 || !HASH.test(d.key || '') || r.dispatchKey !== d.key || r.requestHash !== d.requestHash || !QBO_ID.test(step.qboId || '') || r.qboId !== step.qboId || !HASH.test(r.evidenceHash || '') || !['create-response', 'request-correlated-readback', 'owner-attributed-readback'].includes(r.source)) return 'its creation receipt does not match its dispatch';
  if (!v || v.kind !== 'business-readback' || v.compilationHash !== d.compilationHash || !HASH.test(v.observedHash || '') || !HASH.test(v.evidenceHash || '') || !HASH.test(v.graphEvidenceHash || '') || !step.lastAuditId) return 'its read-back verification proof is missing';
  if (v.evidenceHash !== require('./business-readback').listReadbackEvidenceHash({ requestHash: d.requestHash, compilationHash: d.compilationHash, receiptHash: r.evidenceHash, recordHash: v.observedHash })) return 'its read-back proof does not match its receipt and observed record';
  // By design, a role verified before definition hashes were retained (none exist:
  // no add-* operation ran before this rule) stays unusable; there is no migration.
  if (!HASH.test(v.listDefinitionHash || '')) return 'its verified QuickBooks definition was not retained';
  return null;
}
// The step's retained receipt must be rebuilt from its stored origin: a business
// dispatch's transport receipt row and its two transport audits (the same proof the
// step store's receipt recovery uses), or an owner-confirmed attribution.
async function receiptProblem(models, company, step) {
  const r = step.receipt, d = step.dispatch, problem = 'its creation receipt or transport audit is missing or changed';
  try {
    if (r.source === 'owner-attributed-readback') { await require('./business-owner-attribution').assertOwnerAttribution(models, company, step, null); return null; }
    if (r.source !== 'request-correlated-readback') return problem;
    const transport = require('./business-dispatch-receipt'), input = { ...company, operationId: String(step.operationId), logicalKey: step.logicalKey, entity: step.entity, dispatch: d };
    const row = await models.Receipts.findOne({ ...company, operationId: String(step.operationId), logicalKey: step.logicalKey, kind: 'business', operation: 'create', dispatchKey: d.key, requestHash: d.requestHash }).maxTimeMS(3000).lean();
    const evidence = row ? transport.businessTransportEvidence(input, row) : null;
    if (!evidence) return problem;
    const audits = [];
    for (const expected of evidence.audits) audits.push(await models.Audits.findOne({ _id: expected.id, realmId: company.realmId }).maxTimeMS(3000).lean());
    transport.assertBusinessTransportAudits(row, evidence, audits);
    const rebuilt = evidence.result.receipt;
    return rebuilt.evidenceHash === r.evidenceHash && rebuilt.qboId === step.qboId && rebuilt.dispatchKey === r.dispatchKey ? null : problem;
  } catch { return problem; }
}
// The step's own verification audit: the 'verify' transition audit for this exact
// step, dispatch and record (business-step-store), written for the company owner.
async function auditProblem(models, company, ownerId, step) {
  const audit = await models.Audits.findOne({ _id: step.lastAuditId, realmId: company.realmId }).maxTimeMS(3000).lean();
  const params = audit?.inputParams, details = params?.details;
  if (!audit || String(audit.userId) !== String(ownerId) || audit.action !== 'Business operation evidence recorded' || audit.outcome !== 'success' || !sameScope(params, company) || !sameScope(details, company) || !same(details.operationId, step.operationId) || details.logicalKey !== step.logicalKey || details.phase !== 'verify' || details.qboId !== step.qboId || details.dispatchKey !== step.dispatch?.key) return 'its verification audit record is missing or differs';
  return null;
}
// The creating operation's completion: a verified additional-activity run proven the
// same way a committed period is proven elsewhere (business-stock-history
// committedReceipt: evidence hash recomputed from the stored proof, the period proof
// revalidated at its observation time, and the completion and evidence audits),
// whose record set contains this exact step.
async function runCompletion(models, company, ownerId, run) {
  try { require('./business-period-store').assertRun(run, company); } catch { return { problem: 'its operation lost its immutable evidence' }; }
  const v = run.verification;
  if (run.status !== 'verified' || !run.activityBatch || !v || !HASH.test(v.evidenceHash || '') || !HASH.test(v.recordSetHash || '') || v.planHash !== run.planHash || v.blueprintHash !== run.blueprintHash || !same(v.operationId, run._id) || !v.completionAuditId) return { problem: 'its operation has no completion proof' };
  let committed;
  try { committed = await require('./business-stock-history').committedReceipt(models, company, String(ownerId), String(run._id), null); } catch { return { problem: 'its operation completion evidence is missing or changed' }; }
  const proof = committed.evidence.proof;
  if (committed.evidence.evidenceHash !== v.evidenceHash || !sameScope(proof, company) || !Array.isArray(proof.records)) return { problem: 'its operation completion evidence is missing or changed' };
  return { records: new Map(proof.records.map(row => [row?.logicalKey, row])) };
}
// Returns { roles, unusable, count, overCapacity }. Never throws for one anomalous
// entry; an unusable entry can never be used and its name stays reserved. ownerId is
// the connected company owner who owns the operation audits.
async function listAddedRoles(models, scope, ownerId) {
  const company = { environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId };
  const steps = await models.Steps.find({ ...company, entity: { $in: Object.values(ENTITY) }, state: { $in: CREATED_STATES } }).sort({ _id: 1 }).select('operationId planHash logicalKey fingerprint entity state qboId dispatch compilation receipt verification lastAuditId').limit(MAX_ROLES + 1).maxTimeMS(5000).lean();
  const registry = { roles: [], unusable: [], count: steps.length, overCapacity: steps.length > MAX_ROLES };
  if (!steps.length) return registry;
  const runIds = [...new Set(steps.map(step => String(step.operationId)))];
  const runs = new Map((await models.Runs.find({ ...company, _id: { $in: runIds } }).limit(runIds.length).maxTimeMS(5000).lean()).map(run => [String(run._id), run]));
  const completions = new Map(), candidates = [];
  for (const [index, step] of steps.entries()) {
    const run = runs.get(String(step.operationId)), payload = parse(step.compilation?.request?.body);
    const intent = run ? await models.Intents.findOne({ ...company, planId: run.planId, planHash: run.planHash, logicalKey: step.logicalKey }).maxTimeMS(3000).lean() : null;
    const role = intent?.step?.details?.listRole;
    const entry = { key: typeof role?.roleKey === 'string' ? role.roleKey : null, kind: KIND[step.entity], entity: step.entity, name: typeof role?.name === 'string' ? role.name : (step.entity === 'Item' ? payload?.Name : payload?.DisplayName) || null, id: QBO_ID.test(step.qboId || '') ? step.qboId : null, operationId: String(step.operationId), logicalKey: step.logicalKey };
    const unusable = reason => registry.unusable.push({ ...entry, reason });
    if (index >= MAX_ROLES) { unusable('the added-record registry is over its capacity of ' + MAX_ROLES); continue; }
    if (step.state !== 'verified') { unusable(['dispatched', 'unknown'].includes(step.state) ? 'its creation outcome is not settled yet' : 'it was saved but not verified'); continue; }
    if (!run || run.planHash !== step.planHash) { unusable('its creating operation is unavailable'); continue; }
    if (run.status !== 'verified') { unusable('its creating batch has not verified (status ' + run.status + ')'); continue; }
    let lifecycle = null;
    try { lifecycle = intent && intent.step?.entity === step.entity && hash(intent.step) === step.fingerprint ? require('./business-activity-batch').batchLifecycle(intent.step) : null; } catch { lifecycle = null; }
    if (lifecycle?.mode !== 'list-record' || lifecycle.listRole.kind !== entry.kind || lifecycle.activityBatch.key !== run.activityBatch?.key) { unusable('its approved creation intent is unavailable or changed'); continue; }
    const problem = creationProblem(step, company);
    if (problem) { unusable(problem); continue; }
    const audited = await receiptProblem(models, company, step) || await auditProblem(models, company, ownerId, step);
    if (audited) { unusable(audited); continue; }
    if (!completions.has(entry.operationId)) completions.set(entry.operationId, await runCompletion(models, company, ownerId, run));
    const completion = completions.get(entry.operationId), record = completion.records?.get(step.logicalKey);
    if (completion.problem) { unusable(completion.problem); continue; }
    if (!record || record.entity !== step.entity || record.qboId !== step.qboId || record.fingerprint !== step.fingerprint || record.state !== 'verified' || !same(record.auditId, step.lastAuditId)) { unusable('its operation evidence does not include this record'); continue; }
    const name = step.entity === 'Item' ? payload?.Name : payload?.DisplayName;
    if (name !== role.name || (step.entity === 'Item' && (payload.Type !== 'Service' || Math.round(payload.UnitPrice * 100) !== role.unitPriceCents))) { unusable('it differs from its creation request'); continue; }
    candidates.push({ key: role.roleKey, kind: entry.kind, entity: step.entity, id: step.qboId, name, ...(step.entity === 'Item' ? { incomeRole: role.incomeRole, unit: role.unit, unitPriceCents: role.unitPriceCents } : {}), operationId: entry.operationId, logicalKey: step.logicalKey, definitionHash: step.verification.listDefinitionHash });
  }
  // Never reassign a role key or let two roles claim one QuickBooks record: every
  // claimant of a duplicated key or record becomes unusable.
  const tally = new Map(), bump = key => tally.set(key, (tally.get(key) || 0) + 1);
  for (const role of candidates) { bump('key:' + role.key); bump('id:' + role.entity + ':' + role.id); }
  for (const role of candidates) {
    if (tally.get('key:' + role.key) > 1 || tally.get('id:' + role.entity + ':' + role.id) > 1) { const { definitionHash, incomeRole, unit, unitPriceCents, ...entry } = role; registry.unusable.push({ ...entry, reason: 'another added record claims the same role or QuickBooks record' }); }
    else registry.roles.push(role);
  }
  registry.roles.sort((a, b) => a.key.localeCompare(b.key));
  return registry;
}
// Every list record that was or may still be created, other than the one exact step
// about to be dispatched (so a resent attempt never counts itself).
async function countAddedRecords(models, scope, except = null) {
  const company = { environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId };
  const rows = await models.Steps.find({ ...company, entity: { $in: Object.values(ENTITY) }, state: { $in: CREATED_STATES } }).select('operationId logicalKey').limit(MAX_ROLES + 2).maxTimeMS(5000).lean();
  const count = rows.filter(row => !(except && same(row.operationId, except.operationId) && row.logicalKey === except.logicalKey)).length;
  return { count, overCapacity: count > MAX_ROLES };
}
// Re-checked when a saved operation starts and immediately before each write, for
// saved and already approved operations too: additions sit in their own batch, and a
// list record is sent only while the registry has room for it. The company writer
// runs one operation at a time, so no other dispatch can add a record in between.
async function assertDispatchable(models, scope, batch, operationId, logicalKey) {
  assertListOnlyBatch(batch);
  if (!logicalKey || !(batch?.activities || []).some(row => LIST_TYPES.includes(row?.type))) return;
  const registry = await countAddedRecords(models, scope, { operationId, logicalKey });
  if (registry.overCapacity || registry.count + 1 > MAX_ROLES) fail('The added customer, supplier and item registry is full (' + registry.count + ' of ' + MAX_ROLES + '); this record was not sent.');
}
// New additions must fit the registry; checked at preparation, at approval and again
// before each list record is sent (assertDispatchable).
function assertCapacity(registry, batch) {
  const additions = (batch?.activities || []).filter(row => LIST_TYPES.includes(row?.type)).length;
  if (additions && (registry.overCapacity || registry.count + additions > MAX_ROLES)) fail('The added customer, supplier and item registry has room for ' + Math.max(0, MAX_ROLES - registry.count) + ' more record(s); this batch adds ' + additions + '.');
}
// Roles a batch uses must exist, be the right entity, keep their retained capabilities
// and still have their verified full QuickBooks definition (any drift refuses use).
async function resolveBatchRoles({ registry, batch, readRecord, scope }) {
  const { ADDED } = require('./business-activity-batch'), { referenceDefinition } = require('./business-reference'), used = new Map();
  const want = (key, kind) => { if (key && ADDED[kind].test(key)) used.set(key, kind); };
  for (const row of batch.activities) { want(row.customerKey, 'customer'); want(row.vendorKey, 'supplier'); want(row.itemKey, 'item'); }
  const resolved = [];
  for (const [key, kind] of used) {
    const role = registry.roles.find(value => value.key === key), blocked = registry.unusable.find(value => value.key === key);
    if (!role && blocked) fail('The added ' + kind + ' ' + (blocked.name || key) + ' cannot be used: ' + blocked.reason + '.');
    if (!role || role.kind !== kind) fail('The added ' + kind + ' ' + key + ' is not a verified accountant-added role yet. Use it in a later batch, after the batch that created it verified.');
    for (const row of batch.activities.filter(value => value.itemKey === key)) if (row.incomeRole !== role.incomeRole || row.unit !== role.unit) fail('The added item ' + key + ' sale must use its retained income role and unit.');
    const observed = await readRecord(role.entity, role.id);
    let definition = null;
    try { definition = referenceDefinition(scope, role.entity, observed).hash; } catch { definition = null; }
    if (!observed || observed.Id !== role.id || observed.Active !== true || typeof observed.SyncToken !== 'string' || definition !== role.definitionHash) fail('The added ' + kind + ' ' + role.name + ' changed in QuickBooks after it was created; it cannot be used.');
    resolved.push({ key, entity: role.entity, id: role.id, syncToken: observed.SyncToken, ...(role.entity === 'Item' ? { incomeRole: role.incomeRole } : {}) });
  }
  return resolved;
}
// A batch that adds customers, suppliers or items contains only those additions, so
// an unrelated sale or expense can never fail the batch after a record was created.
function assertListOnlyBatch(batch) {
  const rows = batch?.activities || [], lists = rows.filter(row => LIST_TYPES.includes(row?.type)).length;
  if (lists && lists !== rows.length) fail('Add customers, suppliers and items in their own batch, without sales, expenses or other activity. Use them in a later batch.');
}
// QuickBooks shares one name space for customers, suppliers and employees; items have
// their own. Inactive records count. A taken name refuses the addition.
const escape = name => name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function nameTaken(query, entity, name) {
  const types = entity === 'Item' ? ['Item'] : ['Customer', 'Vendor', 'Employee'];
  for (const type of types) {
    const field = type === 'Item' ? 'Name' : 'DisplayName';
    const body = await query('SELECT Id FROM ' + type + " WHERE " + field + " = '" + escape(name) + "' AND Active IN (true, false) MAXRESULTS 5");
    const page = body?.QueryResponse;
    if (!page || typeof page !== 'object') fail('QuickBooks names could not be checked completely.');
    if (Array.isArray(page[type]) && page[type].length) return true;
    if (page[type] !== undefined && !Array.isArray(page[type])) fail('QuickBooks names could not be checked completely.');
  }
  return false;
}
async function assertNamesAvailable({ batch, registry, query }) {
  const known = [...registry.roles, ...registry.unusable].filter(role => typeof role.name === 'string');
  for (const row of batch.activities.filter(value => LIST_TYPES.includes(value.type))) {
    const entity = row.type === 'add-item' ? 'Item' : row.type === 'add-customer' ? 'Customer' : 'Vendor', folded = row.name.toLowerCase();
    if (known.some(role => (entity === 'Item') === (role.entity === 'Item') && role.name.toLowerCase() === folded) || await nameTaken(query, entity, row.name)) fail('The name "' + row.name + '" is already used in QuickBooks. Choose a different name.');
  }
}
function choiceRoles(registry) {
  const view = role => ({ key: role.key, name: role.name, ...(role.entity === 'Item' ? { incomeRole: role.incomeRole, unit: role.unit, unitPriceCents: role.unitPriceCents } : {}) });
  const roles = registry.roles;
  return { addedCustomers: roles.filter(role => role.kind === 'customer').map(view), addedSuppliers: roles.filter(role => role.kind === 'supplier').map(view), addedItems: roles.filter(role => role.kind === 'item').map(view),
    unusableAddedRecords: registry.unusable.slice(0, 50).map(row => ({ key: row.key, kind: row.kind, name: row.name, qboId: row.id, reason: row.reason })), addedRecordCapacity: { used: registry.count, limit: MAX_ROLES } };
}
module.exports = { listAddedRoles, countAddedRecords, assertDispatchable, resolveBatchRoles, assertNamesAvailable, assertCapacity, assertListOnlyBatch, nameTaken, choiceRoles, ENTITY, LIST_TYPES, MAX_ROLES };
