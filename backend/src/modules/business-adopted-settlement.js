'use strict';
// Evidence for settling an obligation from the adopted import history: the
// adoption marker, the obligation's saved import record (with its financial
// proof and posting account) and a fresh QuickBooks read of the obligation.
// Read-only. The transaction compiler decides whether the settlement is allowed.
const ID = /^\d{1,30}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_ADOPTED_SETTLEMENT_UNVERIFIED' }); }
// job: the adopted import job; the record must have been saved by that job and
// its financial proof must have matched, with no failed relationship recheck.
function importedObligation(row, scope, adoption, entity, qboId, job) {
  if (!job || String(job._id) !== String(adoption.jobId) || job.status !== 'adopted' || !/^[a-f0-9]{64}$/.test(job.authorityHash || '') || row?.authorityHash !== job.authorityHash || row.financialProof?.matchesFinancialIntent !== true || row.relationshipCheck?.outcome === 'error') fail('This ' + entity.toLowerCase() + ' is not a verified record of the adopted import.');
  if (!row || row.environment !== scope.environment || row.realmId !== scope.realmId || String(row.connectionId) !== scope.connectionId || row.entity !== entity || row.qboId !== qboId || row.state !== 'saved' || row.receipt?.qboId !== qboId || !row.financialProof || row.txnDate > adoption.importedThrough || typeof row.compilation?.request?.body !== 'string') fail('This ' + entity.toLowerCase() + ' is not a saved, financially verified record of the adopted import.');
  const payload = JSON.parse(row.compilation.request.body), details = row.step?.details || {};
  const accountId = entity === 'Invoice' ? payload.ARAccountRef?.value : payload.APAccountRef?.value, partyKey = entity === 'Invoice' ? details.customerKey : details.vendorKey;
  if (!ID.test(accountId || '') || typeof partyKey !== 'string' || !partyKey) fail('The imported obligation lacks its original party or control account.');
  return { logicalKey: row.logicalKey, entity, qboId, txnDate: row.txnDate, accountId, partyKey, adoptionId: adoption.adoptionId };
}
async function adoptedJob(Jobs, adoption) {
  return (Jobs || require('../models/BusinessPopulationJob')).findOne({ _id: adoption.jobId }).select('status authorityHash').maxTimeMS(3000).lean();
}
function createAdoptedSettlementReader({ Calendars, PopulationRecords, PopulationJobs, readRecord }) {
  return async function adoptedSources(scope, settlement, { signal } = {}) {
    if (!Calendars || !PopulationRecords || typeof readRecord !== 'function') fail('Adopted settlement evidence needs the calendar, the import records and a record reader.');
    if (!settlement || !['Invoice', 'Bill'].includes(settlement.entity) || !ID.test(settlement.qboId || '')) fail('Name one adopted invoice or bill.');
    const calendar = await Calendars.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId }).select('adoption').maxTimeMS(3000).lean();
    const adoption = calendar?.adoption;
    if (adoption?.kind !== 'adopted-history' || !/^[a-f0-9]{24}$/.test(adoption.adoptionId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(adoption.importedThrough || '')) fail('No adopted import history exists for this company.');
    const row = await PopulationRecords.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, entity: settlement.entity, qboId: settlement.qboId }).maxTimeMS(3000).lean();
    const population = importedObligation(row, scope, adoption, settlement.entity, settlement.qboId, await adoptedJob(PopulationJobs, adoption));
    const observed = await readRecord(scope, settlement.entity, settlement.qboId, { signal });
    return { ...observed, population };
  };
}
module.exports = { createAdoptedSettlementReader, importedObligation, adoptedJob };
