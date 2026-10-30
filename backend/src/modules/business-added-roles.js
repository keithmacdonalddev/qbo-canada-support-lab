'use strict';
// Customers, suppliers and service items the accountant added (activity policy v6).
// The registry is derived, append-only evidence: a role exists only when its creating
// list step is verified AND that step's whole operation verified. Nothing here writes,
// so there is no separate activation record to lose or duplicate. A role is never
// reassigned and never adopts a record by name.
const QBO_ID = /^\d{1,30}$/;
const ENTITY = Object.freeze({ customer: 'Customer', supplier: 'Vendor', item: 'Item' });
const MAX_ROLES = 1000;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_ADDED_ROLE_UNVERIFIED' }); }
// The exact fields the creating request sent; drift in any of them refuses later use.
function requestedFields(entity, payload) {
  const pick = keys => Object.fromEntries(keys.filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
  return entity === 'Item' ? pick(['Name', 'Type', 'IncomeAccountRef', 'UnitPrice']) : pick(['DisplayName', 'CurrencyRef', 'PrimaryEmailAddr', 'PrimaryPhone']);
}
function matchesRequested(requested, record) {
  for (const [key, value] of Object.entries(requested)) {
    if (value && typeof value === 'object') { for (const [inner, wanted] of Object.entries(value)) if (record?.[key]?.[inner] !== wanted) return false; }
    else if (key === 'UnitPrice' ? Math.round(Number(record?.[key]) * 100) !== Math.round(value * 100) : record?.[key] !== value) return false;
  }
  return true;
}
async function listAddedRoles(models, scope) {
  const company = { environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId };
  const steps = await models.Steps.find({ ...company, entity: { $in: Object.values(ENTITY) }, state: 'verified' }).select('operationId planHash logicalKey entity qboId compilation receipt verification').limit(MAX_ROLES + 1).maxTimeMS(5000).lean();
  if (steps.length > MAX_ROLES) fail('The accountant-added role registry exceeds its capacity.');
  if (!steps.length) return [];
  const runIds = [...new Set(steps.map(step => String(step.operationId)))];
  const runs = new Map((await models.Runs.find({ ...company, _id: { $in: runIds }, status: 'verified' }).select('planId planHash status').limit(MAX_ROLES + 1).maxTimeMS(5000).lean()).map(run => [String(run._id), run]));
  const roles = [], keys = new Set(), ids = new Set();
  for (const step of steps) {
    const run = runs.get(String(step.operationId));
    if (!run || run.planHash !== step.planHash) continue;
    const intent = await models.Intents.findOne({ ...company, planId: run.planId, planHash: run.planHash, logicalKey: step.logicalKey }).maxTimeMS(3000).lean();
    const role = intent?.step?.details?.listRole, payload = (() => { try { return JSON.parse(step.compilation?.request?.body); } catch { return null; } })();
    if (!role || ENTITY[role.kind] !== step.entity || intent.step.entity !== step.entity || !QBO_ID.test(step.qboId || '') || step.receipt?.qboId !== step.qboId || step.verification?.matchesIntent === false || !payload || step.compilation.entity !== step.entity) fail('An accountant-added role lost its exact creation evidence.');
    const name = step.entity === 'Item' ? payload.Name : payload.DisplayName;
    if (name !== role.name || (step.entity === 'Item' && (payload.Type !== 'Service' || Math.round(payload.UnitPrice * 100) !== role.unitPriceCents))) fail('An accountant-added role differs from its creation request.');
    // Never reassign a role key or let two roles claim one QuickBooks record.
    if (keys.has(role.roleKey) || ids.has(step.entity + ':' + step.qboId)) fail('An accountant-added role is duplicated.');
    keys.add(role.roleKey); ids.add(step.entity + ':' + step.qboId);
    roles.push({ key: role.roleKey, kind: role.kind, entity: step.entity, id: step.qboId, name, ...(step.entity === 'Item' ? { incomeRole: role.incomeRole, unit: role.unit, unitPriceCents: role.unitPriceCents } : {}), operationId: String(step.operationId), logicalKey: step.logicalKey, requested: requestedFields(step.entity, payload) });
  }
  return roles.sort((a, b) => a.key.localeCompare(b.key));
}
// Roles a batch uses must exist, be the right entity, keep their retained capabilities
// and still match their creation request in QuickBooks (definition drift refuses use).
async function resolveBatchRoles({ roles, batch, readRecord }) {
  const { ADDED } = require('./business-activity-batch'), used = new Map();
  const want = (key, kind) => { if (key && ADDED[kind].test(key)) used.set(key, kind); };
  for (const row of batch.activities) { want(row.customerKey, 'customer'); want(row.vendorKey, 'supplier'); want(row.itemKey, 'item'); }
  const resolved = [];
  for (const [key, kind] of used) {
    const role = roles.find(value => value.key === key);
    if (!role || role.kind !== kind) fail('The added ' + kind + ' ' + key + ' is not a verified accountant-added role yet. Use it in a later batch, after the batch that created it verified.');
    for (const row of batch.activities.filter(value => value.itemKey === key)) if (row.incomeRole !== role.incomeRole || row.unit !== role.unit) fail('The added item ' + key + ' sale must use its retained income role and unit.');
    const observed = await readRecord(role.entity, role.id);
    if (!observed || observed.Id !== role.id || observed.Active !== true || typeof observed.SyncToken !== 'string' || !matchesRequested(role.requested, observed)) fail('The added ' + kind + ' ' + role.name + ' changed in QuickBooks after it was created; it cannot be used.');
    resolved.push({ key, entity: role.entity, id: role.id, syncToken: observed.SyncToken, ...(role.entity === 'Item' ? { incomeRole: role.incomeRole } : {}) });
  }
  return resolved;
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
async function assertNamesAvailable({ batch, roles, query }) {
  for (const row of batch.activities.filter(value => ['add-customer', 'add-supplier', 'add-item'].includes(value.type))) {
    const entity = row.type === 'add-item' ? 'Item' : row.type === 'add-customer' ? 'Customer' : 'Vendor', folded = row.name.toLowerCase();
    if (roles.some(role => (entity === 'Item') === (role.entity === 'Item') && role.name.toLowerCase() === folded) || await nameTaken(query, entity, row.name)) fail('The name "' + row.name + '" is already used in QuickBooks. Choose a different name.');
  }
}
function choiceRoles(roles) {
  const view = role => ({ key: role.key, name: role.name, ...(role.entity === 'Item' ? { incomeRole: role.incomeRole, unit: role.unit, unitPriceCents: role.unitPriceCents } : {}) });
  return { addedCustomers: roles.filter(role => role.kind === 'customer').map(view), addedSuppliers: roles.filter(role => role.kind === 'supplier').map(view), addedItems: roles.filter(role => role.kind === 'item').map(view) };
}
module.exports = { listAddedRoles, resolveBatchRoles, assertNamesAvailable, nameTaken, choiceRoles, requestedFields, matchesRequested, ENTITY };
