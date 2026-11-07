'use strict';
const { hash, canonical } = require('./business-calendar');
const { activityTemplateVersion } = require('./business-activity-preview');
const { draftView } = require('./blueprint-draft');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_AUTHORITY_CHANGED' }); }
function assertAuthorityDocument(row, scope) {
  const value = row?.payload;
  if (!row || ![1, 2].includes(row.contractVersion) || row.contractVersion !== value?.version || !row.auditId || hash(value) !== row.contentHash || ![1, 2].includes(value?.version) || value.status !== 'published' || canonical(value.scope) !== canonical(scope) || typeof value.ownerId !== 'string' || value.ownershipDisposition !== 'retain-unmanaged' || ![1, 2, 3].includes(value.activityTemplateVersion) || !/^[a-f0-9]{64}$/.test(value.baselineHash || '') || !/^[a-f0-9]{64}$/.test(value.inventoryHash || '')) fail('The exact published business authority is unavailable.');
  if (value.stockRoot !== undefined) {
    require('./business-stock-root').validateStockRoot(value.stockRoot, scope);
    if (value.stockRoot.baselineHash !== value.baselineHash || value.stockRoot.inventoryHash !== value.inventoryHash || value.stockRoot.openingDate !== value.openingDate) fail('Published stock evidence differs from the accepted business opening.');
  }
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
  if (activityTemplateVersion(view.business) !== value.activityTemplateVersion) fail('The published activity rules no longer match this application version.');
  if (view.business.datedTax !== undefined) require('./business-dated-tax').bindDatedTax(view.business, view.mappings);
  if ((view.business.stockCosting !== undefined) !== (value.stockRoot !== undefined)) fail('The published stock-cost requirement changed.');
  if (value.stockRoot) require('./business-stock-root').validateStockRoot(value.stockRoot, scope, view);
  const lineage = value.version === 2 ? await require('./business-authority-lineage').readAuthorityLineage({ Authorities, Versions, Audits, Baselines, scope, head: row, session, verifyBaseline }) : null;
  return { authority: row, value, calendar, view, lineage };
}
async function assertPublishedBusiness(input) {
  const active = await readPublishedBusiness(input), { authority: row, value, calendar, lineage } = active;
  const { Calendars, scope, manifest, session, fence = false } = input;
  // Publication hashes describe history. New admission uses the current head,
  // while retaining the accepted opening, occurrence ownership and writer fence.
  if (manifest) {
    const origin = value.version === 2 ? lineage.entries.find(entry => entry.authority.contentHash === manifest.authorityHash)?.value : value;
    if (!origin || (value.version === 1 && manifest.authorityHash !== row.contentHash) || manifest.baselineHash !== value.baselineHash || (manifest.businessKey !== undefined && manifest.businessKey !== value.businessKey) || (manifest.openingDate !== undefined && manifest.openingDate !== value.openingDate) || (manifest.scope && canonical(manifest.scope) !== canonical(scope)) || origin.blueprintHash !== manifest.blueprintHash) fail('The operation belongs to a different accepted business opening or company.');
    if (lineage && manifest.authorityHash !== row.contentHash) {
      const next = lineage.segments[lineage.entries.findIndex(entry => entry.value === origin) + 1];
      const origins = manifest.continuity?.origins || manifest.entries?.filter(entry => entry.kind === 'create').map(entry => ({ ...entry.step.details?.origin, authorityHash: manifest.authorityHash, blueprintHash: manifest.blueprintHash }));
      if (origins?.length && origins.every(origin => typeof origin.occurrence === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(origin.occurrence))) {
        for (const occurrence of origins) {
          const selected = lineage.segments.filter(segment => segment.effectiveFrom <= occurrence.occurrence).at(-1);
          if (!selected || selected.authorityHash !== occurrence.authorityHash || selected.blueprintHash !== occurrence.blueprintHash) fail('Refresh unsent activity under the current instructions for its occurrence date.');
        }
      } else if (!next || !manifest.throughDate || manifest.throughDate >= next.effectiveFrom) fail('Current occurrence origins are required before continuing an earlier business plan.');
    }
  }
  if (input.requireScheduleAcceptance === true) require('./business-activity-preview').assertActivityTemplateAccepted(active.view.business, scope);
  if (calendar.pendingCommit || (manifest && (calendar.baseline?.evidenceHash !== manifest.baselineHash || calendar.verifiedThrough !== manifest.expectedCursor))) fail('The active calendar differs from this reviewed operation.');
  if (manifest) {
    const required = manifest.requiredAssertions?.some(row => row.key === 'stock-costs');
    // Same-day activity proved by record read-back alone carries no stock-cost proof (monthly close, 2026-11-06).
    const recordsOnly = Array.isArray(manifest.requiredAssertions) && manifest.requiredAssertions.length > 0 && manifest.requiredAssertions.every(row => row.evidenceType === 'record-readback');
    if (!recordsOnly && Boolean(value.stockRoot) !== Boolean(required)) fail('The operation cannot omit or invent its published stock-cost requirement.');
    if (manifest.records && required && !manifest.stockCostExpectation) fail('The operation lost its original stock-cost expectation.');
    if (manifest.stockCostExpectation && (manifest.stockCostExpectation.rootHash !== value.stockRoot?.rootHash || manifest.stockCostExpectation.policyHash !== value.stockRoot?.policyHash)) fail('The operation differs from its published stock-cost root.');
  }
  if (fence) {
    // Runtime compositions include general storage; isolated non-general stores do not.
    if (input.GeneralWriteRuns) {
      // History edits no longer hold the business for re-verification (monthly close, 2026-11-06).
    }
    if (!session?.inTransaction?.()) fail('Active business authority requires a transaction fence.');
    const touched = await Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, authorityHash: row.contentHash, revision: calendar.revision, writerRevision: calendar.writerRevision, currentOperationId: calendar.currentOperationId, pendingCommit: null }, { $inc: { authorityRevision: 1 } }, { new: true, session }).lean();
    if (!touched) fail('Business publication changed during admission.');
  }
  return active;
}
module.exports = { assertAuthorityDocument, readPublishedBusiness, assertPublishedBusiness };
