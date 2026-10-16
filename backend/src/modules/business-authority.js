'use strict';
const { hash, canonical } = require('./business-calendar');
const { activityDefinition, activityTemplateVersion } = require('./business-activity-preview');
const { draftView } = require('./blueprint-draft');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_AUTHORITY_CHANGED' }); }
function assertAuthorityDocument(row, scope) {
  const value = row?.payload;
  if (!row || ![1, 2].includes(row.contractVersion) || row.contractVersion !== value?.version || !row.auditId || hash(value) !== row.contentHash || ![1, 2].includes(value?.version) || value.status !== 'published' || canonical(value.scope) !== canonical(scope) || typeof value.ownerId !== 'string' || value.ownershipDisposition !== 'retain-unmanaged' || ![1, 2, 3].includes(value.activityTemplateVersion) || !/^[a-f0-9]{64}$/.test(value.baselineHash || '') || !/^[a-f0-9]{64}$/.test(value.inventoryHash || '')) fail('The exact published business authority is unavailable.');
  if (value.version === 2) require('./business-authority-lineage').assertContinuityDocument(value);
  return value;
}
async function readPublishedBusiness({ Authorities, Versions, Calendars, Connections, Audits, Baselines, scope, session, verifyBaseline = false }) {
  if (!Authorities || !Versions || !Calendars || !Connections || !Audits) fail('Published business authority storage is required.');
  const read = (Model, filter) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const calendar = await read(Calendars, { _id: scope.environment + ':' + scope.realmId, ...scope });
  if (!calendar || !calendar.authorityHash) fail('The active calendar differs from this reviewed operation.');
  const row = await read(Authorities, { ...scope, contentHash: calendar.authorityHash }), value = assertAuthorityDocument(row, scope);
  const owner = await read(Connections, { _id: scope.connectionId, realmId: scope.realmId, userId: value.ownerId, status: 'active' });
  const audit = await read(Audits, { _id: row.auditId, userId: value.ownerId, realmId: scope.realmId, action: value.version === 1 ? 'Business published and opening evidence accepted' : 'Future business revision accepted', outcome: 'success', 'afterState.authorityHash': row.contentHash });
  if (!owner || !audit || audit.afterState?.blueprintHash !== value.blueprintHash || audit.afterState?.baselineHash !== value.baselineHash || audit.afterState?.inventoryHash !== value.inventoryHash) fail('The accepted business owner or publication audit changed.');
  if (calendar.blueprintHash !== value.blueprintHash || String(calendar.blueprintId) !== value.blueprintId || calendar.businessKey !== value.businessKey || calendar.openingDate !== value.openingDate || calendar.baseline?.status !== 'verified' || calendar.baseline.evidenceHash !== value.baselineHash) fail('The calendar is not bound to its exact accepted baseline and business.');
  const blueprint = await read(Versions, { _id: value.blueprintId, ...scope, contractVersion: 2 });
  if (!blueprint || blueprint.contentHash !== value.blueprintHash || hash(blueprint.definition) !== value.blueprintHash || !blueprint.auditId) fail('The published business definition changed.');
  const view = draftView(blueprint, scope.connectionId);
  if (activityTemplateVersion(view.business) !== value.activityTemplateVersion || hash(activityDefinition(view.business)) !== value.activityRulesHash) fail('The published activity rules no longer match this application version.');
  const lineage = value.version === 2 ? await require('./business-authority-lineage').readAuthorityLineage({ Authorities, Versions, Audits, Baselines, scope, head: row, session, verifyBaseline }) : null;
  return { authority: row, value, calendar, view, lineage };
}
async function assertPublishedBusiness(input) {
  const active = await readPublishedBusiness(input), { authority: row, value, calendar, lineage } = active;
  const { Calendars, scope, manifest, session, fence = false } = input;
  if (input.requireScheduleAcceptance === true) require('./business-activity-preview').assertActivityTemplateAccepted(active.view.business, scope);
  if (calendar.pendingCommit || (manifest && (manifest.authorityHash !== calendar.authorityHash || calendar.blueprintHash !== manifest.blueprintHash || calendar.baseline?.evidenceHash !== manifest.baselineHash || calendar.verifiedThrough !== manifest.expectedCursor || calendar.revision !== manifest.expectedRevision))) fail('The active calendar differs from this reviewed operation.');
  if (manifest && (value.version === 2 ? manifest.continuity?.lineageHash !== lineage.lineageHash || manifest.continuity?.authorityHash !== row.contentHash || canonical(manifest.continuity?.segments || null) !== canonical(lineage.segments) : manifest.continuity !== undefined)) fail('The operation differs from its complete reviewed business lineage.');
  if (fence) {
    if (!session?.inTransaction?.()) fail('Active business authority requires a transaction fence.');
    const touched = await Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, authorityHash: row.contentHash, revision: calendar.revision, writerRevision: calendar.writerRevision, currentOperationId: calendar.currentOperationId, pendingCommit: null }, { $inc: { authorityRevision: 1 } }, { new: true, session }).lean();
    if (!touched) fail('Business publication changed during admission.');
  }
  return active;
}
module.exports = { assertAuthorityDocument, readPublishedBusiness, assertPublishedBusiness };
