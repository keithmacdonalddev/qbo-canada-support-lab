'use strict';
const { hash, canonical, date, shift } = require('./business-calendar');
const { assertAuthorityDocument } = require('./business-authority');
const { draftView } = require('./blueprint-draft');
const { activityDefinition, activityTemplateVersion } = require('./business-activity-preview');
const { validateBaselineObservation, assertBaselineDocumentSize } = require('./business-baseline');
const MAX_AUTHORITIES = 64;
const HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_CONTINUITY_UNVERIFIED' }); }
function stableBusiness(previous, next) {
  for (const key of ['openingDate', 'fiscalYearStartMonth']) if (previous.business[key] !== next.business[key]) fail('Keep the original business opening and fiscal calendar.');
  if (canonical(previous.business.stockCosting ?? null) !== canonical(next.business.stockCosting ?? null)) fail('Keep the published stock-cost method and tax evidence; existing purchase layers cannot be reset by a business revision.');
  const before = activityTemplateVersion(previous.business), after = activityTemplateVersion(next.business);
  if ((before !== after && !(before === 2 && after === 3)) || canonical(previous.mappings) !== canonical(next.mappings)) fail('Keep the original schedule or review the continuing-to-customer-credit upgrade, retaining every account and tax mapping.');
  for (const [key, id] of Object.entries(previous.masterBindings || {})) if (id && next.masterBindings?.[key] !== id) fail('Retain every previously selected business record, including dormant roles: ' + key + '.');
}
function retainedBaselineIdentity(row, root, scope) {
  if (!row || row.contractVersion !== 2 || String(row._id) !== root.value.baselineId || String(row.ownerId) !== root.value.ownerId || row.status !== 'captured') fail('The exact scoped original opening observation is unavailable.');
  assertBaselineDocumentSize(row);
  const payload = row.payload, { sourceHash, evaluation: ignored, ...source } = row.sources || {}, { sourceHash: inventoryHash, ...inventory } = row.inventorySources || {};
  if (Buffer.byteLength(canonical(payload)) > 14000000 || Buffer.byteLength(canonical(source)) > 7000000 || Buffer.byteLength(canonical(inventory)) > 25000000) fail('Original opening evidence exceeds its retained size budget.');
  if (row.evidenceHash !== root.value.baselineHash || hash(payload) !== row.evidenceHash || payload.version !== 2 || canonical(payload.scope) !== canonical(scope) || payload.ownerId !== root.value.ownerId || payload.actorId !== String(row.actorId) || payload.accepted !== false || payload.activated !== false || payload.ownership !== 'unverified' || payload.purpose !== 'opening-balances' || payload.blueprint?.id !== root.value.blueprintId || payload.blueprint.contentHash !== root.value.blueprintHash || payload.blueprint.openingDate !== root.value.openingDate || payload.period?.throughDate !== shift(root.value.openingDate, -1)) fail('The original accepted opening identity or payload changed.');
  if (row.requestHash !== payload.requestHash || hash(row.request) !== row.requestHash || row.request.connectionId !== scope.connectionId || row.request.blueprintId !== root.value.blueprintId || row.request.blueprintHash !== root.value.blueprintHash || row.request.purpose !== payload.purpose || canonical({ fromDate: row.request.fromDate, throughDate: row.request.throughDate }) !== canonical(payload.period)) fail('The original opening request changed.');
  if (![2, 3].includes(source.version) || canonical(source.scope) !== canonical(scope) || canonical(source.period) !== canonical(payload.period) || sourceHash !== payload.sourceHash || hash(source) !== sourceHash || inventory.version !== 1 || canonical(inventory.scope) !== canonical(scope) || hash(inventory) !== inventoryHash || payload.inventory?.sourceHash !== inventoryHash || hash(inventory.records) !== root.value.inventoryHash) fail('The original encoded report or inventory sources changed.');
  return payload;
}
async function readAuthorityLineage({ Authorities, Versions, Audits, Baselines, scope, head, session, verifyBaseline = false }) {
  if (![Authorities, Versions, Audits].every(Boolean)) fail('Complete business authority storage is required.');
  const read = (Model, filter) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const reverse = [], seen = new Set(); let row = head;
  while (row) {
    const value = assertAuthorityDocument(row, scope);
    if (reverse.length >= MAX_AUTHORITIES || seen.has(row.contentHash)) fail('The business authority chain is cyclic or exceeds its complete-history budget.');
    seen.add(row.contentHash);
    const blueprint = await read(Versions, { _id: value.blueprintId, ...scope, contractVersion: 2 });
    if (!blueprint || !blueprint.auditId || blueprint.contentHash !== value.blueprintHash || hash(blueprint.definition) !== value.blueprintHash) fail('An original business definition is unavailable or changed.');
    const view = draftView(blueprint, scope.connectionId);
    if (activityTemplateVersion(view.business) !== value.activityTemplateVersion || hash(activityDefinition(view.business)) !== value.activityRulesHash || view.business.openingDate !== value.openingDate) fail('An original business schedule changed.');
    if ((view.business.stockCosting !== undefined) !== (value.stockRoot !== undefined)) fail('An original stock-cost requirement changed.');
    if (value.stockRoot) require('./business-stock-root').validateStockRoot(value.stockRoot, scope, view);
    const action = value.version === 1 ? 'Business published and opening evidence accepted' : 'Future business revision accepted';
    const audit = await read(Audits, { _id: row.auditId, userId: value.ownerId, realmId: scope.realmId, action, outcome: 'success', 'afterState.authorityHash': row.contentHash });
    if (!audit || audit.afterState?.blueprintHash !== value.blueprintHash || audit.afterState?.baselineHash !== value.baselineHash || audit.afterState?.inventoryHash !== value.inventoryHash) fail('An original business authority audit is unavailable or changed.');
    if (value.version === 2 && (audit.afterState.parentAuthorityHash !== value.continuity.parentAuthorityHash || audit.afterState.reviewHash !== value.continuity.reviewHash || audit.afterState.effectiveFrom !== value.continuity.effectiveFrom || audit.afterState.verifiedThrough !== value.continuity.review.verifiedThrough)) fail('The retained business revision audit differs from its exact decision.');
    reverse.push({ authority: row, value, blueprint, view });
    if (value.version === 1) break;
    row = await read(Authorities, { ...scope, contentHash: value.continuity.parentAuthorityHash });
    if (!row) fail('The complete original business authority chain is unavailable.');
  }
  if (!reverse.length || reverse.at(-1).value.version !== 1) fail('The original business publication is unavailable.');
  const entries = reverse.reverse(), root = entries[0];
  for (let index = 1; index < entries.length; index++) {
    const current = entries[index], previous = entries[index - 1], c = current.value.continuity;
    if (c.sequence !== index || c.rootAuthorityHash !== root.authority.contentHash || c.parentAuthorityHash !== previous.authority.contentHash || current.value.ownerId !== root.value.ownerId) fail('The business authority lineage has a gap or a different owner.');
    for (const key of ['businessKey', 'openingDate', 'baselineId', 'baselineHash', 'inventoryHash', 'country', 'ownershipDisposition']) if (current.value[key] !== root.value[key]) fail('A business revision changed the original accepted starting point.');
    const priorDate = previous.value.version === 1 ? root.value.openingDate : previous.value.continuity.effectiveFrom;
    if (c.effectiveFrom <= priorDate || c.effectiveFrom <= c.review.verifiedThrough || c.review.previousAuthorityHash !== previous.authority.contentHash || c.review.lineageHash !== hash(entries.slice(0, index).map(segment))) fail('The business revision windows overlap or differ from their original review.');
    stableBusiness(previous.view, current.view);
    if (canonical(previous.value.stockRoot ?? null) !== canonical(current.value.stockRoot ?? null)) fail('A business revision cannot replace its original stock-cost root.');
  }
  if (entries.length > 1 || verifyBaseline) {
    if (!Baselines) fail('The original accepted opening evidence is unavailable.');
    const baseline = await read(Baselines, { _id: root.value.baselineId, ...scope, ownerId: root.value.ownerId });
    const payload = retainedBaselineIdentity(baseline, root, scope);
    if (verifyBaseline) validateBaselineObservation(baseline);
    const audit = await read(Audits, { _id: baseline.auditId, userId: root.value.ownerId, realmId: scope.realmId, action: 'Business baseline observation saved', outcome: 'success' });
    if (!audit || audit.afterState?.evidenceHash !== baseline.evidenceHash || audit.afterState?.sourceHash !== payload.sourceHash || audit.afterState?.inventoryHash !== baseline.inventorySources.sourceHash) fail('The original opening observation audit is unavailable.');
  }
  const segments = entries.map(segment);
  return { entries, root, segments, lineageHash: hash(segments) };
}
function segment(entry) {
  return { authorityHash: entry.authority.contentHash, blueprintId: entry.value.blueprintId, blueprintHash: entry.value.blueprintHash, effectiveFrom: entry.value.version === 1 ? entry.value.openingDate : entry.value.continuity.effectiveFrom };
}
function assertContinuityDocument(value) {
  const c = value.continuity, r = c?.review;
  if (c?.version !== 1 || !Number.isSafeInteger(c.sequence) || c.sequence < 1 || c.sequence >= MAX_AUTHORITIES || ![c.parentAuthorityHash, c.rootAuthorityHash, c.reviewHash].every(v => HASH.test(v || '')) || !r || hash(r) !== c.reviewHash || r.version !== 1 || r.previousAuthorityHash !== c.parentAuthorityHash || r.blueprintId !== value.blueprintId || r.blueprintHash !== value.blueprintHash || r.effectiveFrom !== c.effectiveFrom || canonical(r.scope) !== canonical(value.scope)) fail('The exact reviewed business revision is unavailable.');
  date(c.effectiveFrom); date(r.verifiedThrough);
  if (r.verifiedThrough >= c.effectiveFrom) fail('A business revision cannot rewrite verified activity.');
}
module.exports = { MAX_AUTHORITIES, stableBusiness, readAuthorityLineage, assertContinuityDocument, retainedBaselineIdentity };
