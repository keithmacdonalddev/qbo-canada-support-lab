'use strict';
// Reconstruct a pre-Stage-2B retained observation explicitly. Current approval
// deliberately does not create this historical authorization snapshot.
const { createBusinessReportReader } = require('../../src/modules/business-report-evidence');
const { retainApprovalReports } = require('../../src/modules/business-approval-report-evidence');
async function retainHistoricalApproval(h, operationId) {
  const original = h.data.Runs.find(row => row._id === operationId);
  const scope = Object.fromEntries(['realmId','environment','connectionId'].map(key => [key,String(original[key])]));
  const ownerId = String(original.createdBy), actorId = original.approval.actorId;
  const sources = await createBusinessReportReader({ access: h.accessFor({ actorId, ownerId }), now: () => h.clock })(scope, { fromDate: original.fromDate, throughDate: original.throughDate });
  await h.transaction(async session => {
    const run = h.data.Runs.find(row => row._id === operationId);
    const manifest = h.data.Plans.find(row => row.operationId === operationId).manifest;
    const pointer = await retainApprovalReports({ models:h.models,scope,operationId,planHash:run.planHash,actorId,ownerId,sources,manifest,session,now:h.clock });
    run.approval.reportEvidence = pointer;
    const audit = h.data.Audits.find(row => row._id === run.approval.auditId);
    Object.assign(audit.inputParams.details, {reportEvidenceHash:pointer.evidenceHash,reportSourceHash:pointer.sourceHash});
  });
}
module.exports = { retainHistoricalApproval };
