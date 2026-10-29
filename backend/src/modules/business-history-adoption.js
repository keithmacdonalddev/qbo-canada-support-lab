'use strict';
// History adoption: settle a completed bulk population as the business's
// starting history so the accountant can continue from the next day.
// So far: review() reads SAVED evidence only; observe() reads QuickBooks through
// the existing GET-only readers. Neither writes. The stock replay and the adopt
// transaction are later steps (docs/architecture/business-agent.md).
const { hash, shift } = require('./business-calendar');
const ISSUE_CODES = ['estimate-invoice-conversion-unverified', 'time-invoice-billing-unverified', 'record-verification-failed'];
const DONE = new Set(['populated', 'populated-with-gaps']);
const IDLE_RUN = new Set(['blocked', 'stopped', 'awaiting-evidence']);
// Same identity the population service retained as job.importedHash at delegation.
const creationIdentity = row => ({ logicalKey: row.logicalKey, entity: row.entity, qboId: row.qboId, fingerprint: row.fingerprint, compilationHash: row.compilation?.compilationHash, receiptHash: hash(row.receipt), dispatchHash: hash(row.dispatch) });

function createBusinessHistoryAdoption({ models, now = () => Date.now() } = {}) {
  const read = (Model, query, session) => Model.findOne(query).session(session).maxTimeMS(5000).lean();
  async function pending(scope, session) {
    const company = { environment: scope.environment, realmId: scope.realmId };
    const unmet = [], add = (code, detail) => unmet.push({ code, detail });
    const calendar = await read(models.Calendars, scope, session), writer = await read(models.Writers, company, session);
    if (!calendar?.authorityHash) add('not-published', 'The business is not published.');
    if (!writer || String(writer.connectionId) !== scope.connectionId) { add('writer-missing', 'The company writer is not saved for this connection.'); return { unmet }; }
    if (calendar?.verifiedThrough !== null || calendar?.adoption) add('calendar-advanced', 'The business calendar already has a verified or adopted date.');
    if (calendar?.pendingCommit) add('completion-pending', 'A period completion is still pending.');
    if (calendar?.stopRequested) add('calendar-stopped', 'Business activity has a saved Stop request.');
    if (writer.unresolved !== null) add('uncertain-write', 'A QuickBooks request may already have been saved and must be settled first.');
    const delegation = writer.populationDelegation;
    if (!delegation || delegation.kind !== 'business-population') { add('no-population', 'No completed bulk population owns the company writer.'); return { unmet, calendar, writer }; }
    const job = await read(models.Jobs, { _id: delegation.jobId, ...scope }, session);
    if (!job) { add('job-missing', 'The delegated population job is not saved.'); return { unmet, calendar, writer }; }
    if (!DONE.has(job.status)) add('job-unfinished', 'The bulk population has not finished (status ' + job.status + ').');
    if (job.batch) add('job-batch', 'The population still holds an unsettled batch.');
    if (job.leaseToken && new Date(job.leaseExpiresAt).getTime() > now()) add('job-active', 'The population worker is still active.');
    if (['queued', 'running'].includes(job.verification?.status)) add('recheck-running', 'A relationship recheck is still running.');
    if (!Array.isArray(job.manifest) || hash(job.manifest) !== job.manifestHash || delegation.manifestHash !== job.manifestHash) add('manifest-changed', 'The approved population manifest no longer matches its saved hash.');
    if (delegation.importedHash !== job.importedHash) add('imported-changed', 'The writer delegation and the population disagree about the original records.');
    if (calendar && job.fromDate !== calendar.openingDate) add('opening-mismatch', 'The population does not start on the business opening date.');
    if (calendar && (job.authorityHash !== calendar.authorityHash || delegation.authorityHash !== calendar.authorityHash)) add('authority-changed', 'The business was republished after the population.');
    const through = job.createdThrough || null;
    if (!through || through !== job.throughDate) add('through-mismatch', 'The population did not create history through its planned date.');

    const records = { environment: scope.environment, realmId: scope.realmId, authorityHash: job.authorityHash, txnDate: { $gte: job.fromDate, $lte: job.throughDate } };
    const [counts] = await models.Records.aggregate([{ $match: records }, { $group: { _id: null, total: { $sum: 1 }, saved: { $sum: { $cond: [{ $eq: ['$state', 'saved'] }, 1, 0] } }, contentChecked: { $sum: { $cond: [{ $and: [{ $eq: ['$state', 'saved'] }, { $ne: [{ $ifNull: ['$financialProof', null] }, null] }] }, 1, 0] } } } }]).option({ maxTimeMS: 10000, session });
    const required = Array.isArray(job.manifest) ? job.manifest.length : 0, total = counts?.total || 0, saved = counts?.saved || 0, checked = counts?.contentChecked || 0;
    if (!required || total !== required || saved !== required) add('records-incomplete', 'Only ' + saved + ' of ' + required + ' population records are saved.');
    if (checked !== saved) add('content-unchecked', (saved - checked) + ' saved records have no content check.');
    const limitations = {};
    for (const code of ISSUE_CODES) limitations[code] = 0;
    const gapped = [];
    for await (const row of models.Records.find({ ...records, $or: [{ 'coverageGaps.0': { $exists: true } }, { 'relationshipCheck.outcome': 'error' }] }).select('_id logicalKey coverageGaps relationshipCheck.outcome').sort({ _id: 1 }).session(session).maxTimeMS(10000).lean().cursor()) {
      const codes = new Set((row.coverageGaps || []).filter(code => ISSUE_CODES.includes(code)));
      if (row.relationshipCheck?.outcome === 'error') codes.add('record-verification-failed');
      for (const code of codes) limitations[code]++;
      if (codes.size) gapped.push(row.logicalKey);
    }

    let original = null;
    if (writer.operationId !== null || delegation.originalOperationId) {
      const operationId = String(writer.operationId || '');
      if (operationId !== String(delegation.originalOperationId || '') || (calendar && String(calendar.currentOperationId || '') !== operationId)) add('original-mismatch', 'The original operation differs between the writer, the delegation and the calendar.');
      const run = operationId ? await read(models.Runs, { _id: operationId, ...scope }, session) : null;
      if (!run) add('original-missing', 'The original operation is not saved.');
      else {
        if (!IDLE_RUN.has(run.status) || run.leaseToken || run.executionRequest?.pending || run.planHash !== writer.planHash) add('original-active', 'The original operation is not idle.');
        const steps = await models.Steps.find({ ...company, operationId: run._id }).select('logicalKey entity fingerprint state compilation dispatch receipt qboId').limit(5001).session(session).maxTimeMS(10000).lean();
        if (steps.length > 5000) add('original-too-large', 'The original operation exceeds its review bound.');
        if (steps.some(row => ['dispatched', 'unknown', 'rejected'].includes(row.state))) add('original-uncertain', 'An original request is still uncertain or rejected.');
        const identities = steps.filter(row => ['saved', 'verified'].includes(row.state)).map(creationIdentity).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
        if (hash(identities) !== job.importedHash) add('original-changed', 'The original saved records no longer match what the population imported.');
        original = { operationId, planHash: run.planHash, status: run.status, savedRecords: identities.length, claimedSteps: steps.filter(row => row.state === 'claimed').length };
      }
    }
    if (await read(models.Receipts, { ...company, state: { $in: ['possibly-sent', 'unknown'] } }, session)) add('receipt-uncertain', 'A QuickBooks request in this company may have been sent without a confirmed result.');
    const policy = models.Policies ? await read(models.Policies, company, session) : null;
    if (models.Policies && policy?.state !== 'active') add('coordination-paused', 'Company write coordination is not active.');
    const cutoff = [policy?.periodControl?.closedThrough, policy?.periodControl?.reconciledThrough].filter(Boolean).sort().at(-1);
    if (cutoff && through && cutoff > through) add('protected-after', 'The company is closed or reconciled through ' + cutoff + ', after the adoption date; new activity could not start the next day.');

    const terms = { version: 1, kind: 'adopted-history', scope, jobId: String(job._id), manifestHash: job.manifestHash, importedHash: job.importedHash, authorityHash: job.authorityHash, fromDate: job.fromDate, through, recordCount: saved, original: original && { operationId: original.operationId, planHash: original.planHash }, limitations, limitedRecordHash: hash(gapped) };
    return { unmet, calendar, writer, job, original, gapped: gapped.length, terms, termsHash: hash(terms) };
  }
  // The owner-facing and agent-facing summary. Ready means the SAVED evidence
  // allows adoption; QuickBooks evidence is still checked at adoption time.
  async function review(scope, { session } = {}) {
    const result = await pending(scope, session);
    const limitationTotal = Object.values(result.terms?.limitations || {}).reduce((sum, value) => sum + value, 0);
    return { ready: !result.unmet.length, unmet: result.unmet, terms: result.terms || null, termsHash: result.termsHash || null, original: result.original || null, limitedRecords: result.gapped || 0, limitationTotal, qboWrites: 0 };
  }
  // Step 4: read-only QuickBooks evidence for the reviewed terms. Readers are the
  // existing scoped GET-only inventory and seven-report readers; nothing is written.
  async function observe(scope, terms, { access, signal, readInventory, readReports, checkInventory, evaluateReports, period: chosen } = {}) {
    const unmet = [], add = (code, detail) => unmet.push({ code, detail });
    const { createBusinessInventoryReader, inventorySummary } = require('./business-record-inventory');
    const inventory = await (readInventory || createBusinessInventoryReader({ access, now, stockMetadata: true }))(scope, { signal });
    (checkInventory || inventorySummary)(inventory, scope);
    const present = new Map(Object.entries(inventory.records).map(([entity, rows]) => [entity, new Set(rows.map(row => row.id))]));
    const after = {};
    for (const [entity, rows] of Object.entries(inventory.records)) for (const row of rows) if (row.transactionDate && row.transactionDate > terms.through) after[entity] = (after[entity] || 0) + 1;
    if (Object.keys(after).length) add('activity-after', 'QuickBooks has transactions dated after ' + terms.through + ' (' + Object.entries(after).map(([entity, n]) => n + ' ' + entity).join(', ') + '). Adoption must cover every transaction up to the day it starts.');
    const missing = {}, unobserved = {};
    const records = { environment: scope.environment, realmId: scope.realmId, authorityHash: terms.authorityHash, txnDate: { $gte: terms.fromDate, $lte: terms.through }, state: 'saved' };
    for await (const row of models.Records.find(records).select('entity qboId').sort({ _id: 1 }).maxTimeMS(20000).lean().cursor()) {
      const ids = present.get(row.entity);
      if (!ids) unobserved[row.entity] = (unobserved[row.entity] || 0) + 1;
      else if (!ids.has(row.qboId)) missing[row.entity] = (missing[row.entity] || 0) + 1;
    }
    if (Object.keys(missing).length) add('records-missing', 'Imported records are no longer in QuickBooks (' + Object.entries(missing).map(([entity, n]) => n + ' ' + entity).join(', ') + ').');
    const period = chosen || { fromDate: [terms.fromDate, shift(terms.through, -365)].sort().at(-1), throughDate: terms.through };
    const { createBusinessReportReader } = require('./business-report-evidence');
    const reports = await (readReports || createBusinessReportReader({ access, now, purpose: 'preparation' }))(scope, period, { signal });
    const evaluation = (evaluateReports || require('./book-evidence').evaluateReportSources)(reports, { allowExplicitZero: true });
    if (evaluation.status !== 'checks-passed') add('reports-failed', 'The accounting reports through ' + terms.through + ' do not pass their named checks (' + evaluation.status + ').');
    const evidence = { version: 1, termsHash: hash(terms), inventorySourceHash: inventory.sourceHash, reportSourceHash: reports.sourceHash, reportStatus: evaluation.status, period, after, missing, unobserved, observedAt: new Date(now()).toISOString() };
    return { ready: !unmet.length, unmet, evidence, evidenceHash: hash(evidence), reports, qboWrites: 0 };
  }
  return { review, pending, observe };
}
module.exports = { createBusinessHistoryAdoption, creationIdentity, ISSUE_CODES };
