'use strict';
const { hash, canonical } = require('./business-calendar');
const { activityDefinition, TEMPLATE_VERSION } = require('./business-activity-preview');
const { draftView } = require('./blueprint-draft');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_AUTHORITY_CHANGED' }); }
function assertAuthorityDocument(row, scope) {
  const value = row?.payload;
  if (!row || row.contractVersion !== 1 || !row.auditId || hash(value) !== row.contentHash || value?.version !== 1 || value.status !== 'published' || canonical(value.scope) !== canonical(scope) || typeof value.ownerId !== 'string' || value.ownershipDisposition !== 'retain-unmanaged' || value.activityTemplateVersion !== TEMPLATE_VERSION || !/^[a-f0-9]{64}$/.test(value.baselineHash || '') || !/^[a-f0-9]{64}$/.test(value.inventoryHash || '')) fail('The exact published business authority is unavailable.');
  return value;
}
async function assertPublishedBusiness({ Authorities, Versions, Calendars, Connections, Audits, scope, manifest, session, fence = false }) {
  if (!Authorities || !Versions || !Calendars || !Connections || !Audits) fail('Published business authority storage is required.');
  const read = (Model, filter) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const calendar = await read(Calendars, { _id: scope.environment + ':' + scope.realmId, ...scope });
  if (!calendar || !calendar.authorityHash || calendar.pendingCommit || (manifest && (manifest.authorityHash !== calendar.authorityHash || calendar.blueprintHash !== manifest.blueprintHash || calendar.baseline?.evidenceHash !== manifest.baselineHash || calendar.verifiedThrough !== manifest.expectedCursor || calendar.revision !== manifest.expectedRevision))) fail('The active calendar differs from this reviewed operation.');
  const row = await read(Authorities, { ...scope, contentHash: calendar.authorityHash }), value = assertAuthorityDocument(row, scope);
  const owner = await read(Connections, { _id: scope.connectionId, realmId: scope.realmId, userId: value.ownerId, status: 'active' });
  const audit = await read(Audits, { _id: row.auditId, userId: value.ownerId, realmId: scope.realmId, action: 'Business published and opening evidence accepted', outcome: 'success', 'afterState.authorityHash': row.contentHash });
  if (!owner || !audit || audit.afterState?.blueprintHash !== value.blueprintHash || audit.afterState?.baselineHash !== value.baselineHash || audit.afterState?.inventoryHash !== value.inventoryHash) fail('The accepted business owner or publication audit changed.');
  if (calendar.blueprintHash !== value.blueprintHash || String(calendar.blueprintId) !== value.blueprintId || calendar.businessKey !== value.businessKey || calendar.openingDate !== value.openingDate || calendar.baseline?.status !== 'verified' || calendar.baseline.evidenceHash !== value.baselineHash) fail('The calendar is not bound to its exact accepted baseline and business.');
  const blueprint = await read(Versions, { _id: value.blueprintId, ...scope, contractVersion: 2 });
  if (!blueprint || blueprint.contentHash !== value.blueprintHash || hash(blueprint.definition) !== value.blueprintHash || !blueprint.auditId) fail('The published business definition changed.');
  const view = draftView(blueprint, scope.connectionId);
  if (hash(activityDefinition(view.business)) !== value.activityRulesHash) fail('The published activity rules no longer match this application version.');
  if (fence) {
    if (!session?.inTransaction?.()) fail('Active business authority requires a transaction fence.');
    const touched = await Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, authorityHash: row.contentHash, revision: calendar.revision, writerRevision: calendar.writerRevision, currentOperationId: calendar.currentOperationId, pendingCommit: null }, { $inc: { authorityRevision: 1 } }, { new: true, session }).lean();
    if (!touched) fail('Business publication changed during admission.');
  }
  return { authority: row, value, calendar, view };
}
module.exports = { assertAuthorityDocument, assertPublishedBusiness };
