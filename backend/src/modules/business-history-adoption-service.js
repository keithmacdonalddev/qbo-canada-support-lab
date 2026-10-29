'use strict';
// Owner-authorized history adoption (step 7). review(): saved evidence, then
// read-only QuickBooks evidence and the FIFO stock replay. adopt(): one app
// transaction that settles the import as adopted history. No QuickBooks write.
const { hash, canonical } = require('./business-calendar');
const { createBusinessHistoryAdoption } = require('./business-history-adoption');
const HASH = /^[a-f0-9]{64}$/;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_ADOPTION_BLOCKED' }); }
const fiscalStart = (day, month) => { const year = Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) < month ? 1 : 0); return year + '-' + String(month).padStart(2, '0') + '-01'; };

// overrides: test seams for the evidence pipeline and the saved-evidence re-check.
function createHistoryAdoptionService({ models, transaction, now, bind, fence, readers = {}, overrides = {} }) {
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(5000).lean();
  const population = { ...models, Jobs: models.Jobs || require('../models/BusinessPopulationJob'), Records: models.PopulationRecords || require('../models/BusinessPopulationRecord') };
  const adoption = createBusinessHistoryAdoption({ models: population, now });

  async function evidence(bound, { signal } = {}) {
    const saved = await adoption.review(bound.scope);
    if (!saved.ready) return { ready: false, stage: 'saved-evidence', unmet: saved.unmet, terms: saved.terms, termsHash: saved.termsHash, qboWrites: 0 };
    const active = await require('./business-authority').assertPublishedBusiness({ ...models, scope: bound.scope, requireScheduleAcceptance: true });
    const root = active.value.stockRoot, terms = saved.terms;
    if (active.authority.contentHash !== terms.authorityHash) fail('The published business changed since the review.');
    const period = root ? { fromDate: [terms.fromDate, fiscalStart(terms.through, root.fiscalYearStartMonth)].sort().at(-1), throughDate: terms.through } : null;
    const observed = await adoption.observe(bound.scope, terms, { access: bound.access, signal, period, stockItemIds: root ? root.items.map(item => item.itemId) : [], readInventory: readers.inventory, readReports: readers.reports, checkInventory: readers.checkInventory, evaluateReports: readers.evaluateReports });
    const unmet = [...observed.unmet];
    let stock = null;
    if (root) {
      const replay = await require('./business-adopted-stock').replayAdoptedStock({ models: { Records: population.Records }, scope: bound.scope, root, jobId: terms.jobId, through: observed.evidence.through });
      const stockSource = await (readers.stock || require('./business-stock-source').createBusinessStockReader({ access: bound.access, now, purpose: 'operations.preview' }))(bound.scope, replay.state, { signal });
      try { (readers.assertQuantities || require('./business-stock-evidence').assertQuantities)(replay.state, stockSource); }
      catch (error) { if (error.code !== 'BUSINESS_STOCK_COST_UNVERIFIED') throw error; unmet.push({ code: 'stock-quantity', detail: 'QuickBooks quantities on hand differ from the replayed imported purchases and sales.' }); }
      const balances = (readers.balances || stockBalances)(observed.reports, root);
      if (balances.inventoryAsset !== replay.summary.valueCents) unmet.push({ code: 'stock-value', detail: 'The inventory asset balance (' + balances.inventoryAsset + ' cents) differs from the replayed FIFO value (' + replay.summary.valueCents + ' cents).' });
      if (balances.costOfGoods !== replay.carry.costCents) unmet.push({ code: 'stock-cost', detail: 'Cost of goods sold this fiscal year (' + balances.costOfGoods + ' cents) differs from the replayed FIFO cost (' + replay.carry.costCents + ' cents).' });
      stock = { stateHash: replay.state.stateHash, replayHash: replay.carry.replayHash, costCents: replay.carry.costCents, valueCents: replay.summary.valueCents, quantity: replay.summary.quantity, lines: replay.replay.lines };
    }
    // Days between the import's last date and the adoption date have no imported
    // business activity; the owner accepts that gap when adopting.
    const gapDays = Math.round((Date.parse(observed.evidence.through) - Date.parse(terms.through)) / 86400000);
    const gap = gapDays ? { fromDate: require('./business-calendar').shift(terms.through, 1), throughDate: observed.evidence.through, days: gapDays, meaning: 'No imported scheduled activity exists for these days; only transactions entered outside the app.' } : null;
    const result = { ready: !unmet.length, stage: 'quickbooks-evidence', unmet, terms, through: observed.evidence.through, gap, termsHash: saved.termsHash, evidenceHash: observed.evidenceHash, contentHash: observed.contentHash, evidence: observed.evidence, stock, qboWrites: 0 };
    return { ...result, reviewHash: hash({ termsHash: result.termsHash, through: result.through, contentHash: result.contentHash, stock, gap }) };
  }
  function stockBalances(reports, root) {
    const { balances } = require('./business-financial-movements'), { unpackReport } = require('./business-report-source');
    const { sourceHash, evaluation, ...source } = reports;
    return balances(unpackReport('TrialBalance', source.reports.TrialBalance, source.version), source.accounts, root.accounts, source.period);
  }

  async function review(user, { signal } = {}) {
    const bound = await bind(user, 'operations.execute', true);
    return { scope: bound.scope, ...(await evidence(bound, { signal })) };
  }

  async function adopt(user, input, { signal } = {}) {
    if (!input || Object.keys(input).sort().join(',') !== 'confirmProduction,reason,reviewHash' || !HASH.test(input.reviewHash || '') || typeof input.reason !== 'string' || input.reason.trim().length < 20 || input.reason.length > 2000 || typeof input.confirmProduction !== 'boolean') fail('Adopt the exact reviewed history with a recorded reason.', 400);
    const bound = await bind(user, 'operations.execute', true), { scope, ownerId, actorId } = bound;
    if (scope.environment === 'production' && input.confirmProduction !== true) fail('Confirm the real Production company explicitly.', 400);
    const adoptionId = hash({ adoption: input.reviewHash }).slice(0, 24), auditId = hash({ adoptionAudit: input.reviewHash }).slice(0, 24);
    const prior = (await read(models.Calendars, scope))?.adoption;
    if (prior) { if (prior.adoptionId !== adoptionId) fail('Different history was already adopted.'); return { adopted: true, reused: true, adoptionId, through: prior.through, qboWrites: 0 }; }
    const reviewed = await (overrides.evidence || evidence)(bound, { signal });
    if (!reviewed.ready) fail('History adoption is not ready: ' + reviewed.unmet.map(item => item.detail).join(' '));
    if (reviewed.reviewHash !== input.reviewHash) fail('The company changed after the adoption review. Review it again.');
    const { terms } = reviewed, company = { environment: scope.environment, realmId: scope.realmId };
    return transaction(async session => {
      await fence(bound, session, 'operations.execute');
      const calendar = await read(models.Calendars, scope, session);
      if (calendar?.adoption) { if (calendar.adoption.adoptionId !== adoptionId) fail('Different history was already adopted.'); return { adopted: true, reused: true, adoptionId, through: calendar.adoption.through }; }
      const again = await (overrides.pending || adoption.pending)(scope, session);
      if (again.unmet.length || again.termsHash !== reviewed.termsHash) fail('The saved import changed during adoption. Review it again.');
      const { writer, job } = again, original = again.original;
      const policy = await read(models.Policies, company, session);
      if (!policy || policy.state !== 'active' || String(policy.connectionId) !== scope.connectionId) fail('Company write coordination changed.');
      const marker = { version: 1, kind: 'adopted-history', jobId: terms.jobId, adoptionId, auditId, through: reviewed.through, importedThrough: terms.through, termsHash: reviewed.termsHash, evidenceHash: reviewed.evidenceHash, contentHash: reviewed.contentHash, gap: reviewed.gap, reviewHash: input.reviewHash, original: terms.original, stock: reviewed.stock && { stateHash: reviewed.stock.stateHash, replayHash: reviewed.stock.replayHash, costCents: reviewed.stock.costCents }, limitations: terms.limitations, adoptedAt: new Date(now()).toISOString(), actorId };
      if (Buffer.byteLength(canonical(marker)) > 16000) fail('The adoption marker exceeds its budget.');
      if (original) {
        const run = await read(models.Runs, { _id: original.operationId, ...scope }, session);
        if (!run || run.planHash !== original.planHash) fail('The original operation changed.');
        const retired = await models.Runs.findOneAndUpdate({ _id: run._id, ...scope, planHash: run.planHash, status: run.status, executionRevision: run.executionRevision, writerRevision: run.writerRevision, leaseToken: run.leaseToken ?? null },
          { $set: { status: 'retired', retirement: { version: 2, kind: 'superseded-by-population', jobId: terms.jobId, importedHash: terms.importedHash, adoptionId, reviewHash: input.reviewHash, reason: input.reason.trim(), actorId, retiredAt: new Date(now()).toISOString(), auditId }, leaseToken: null, leaseExpiresAt: null, lastError: 'Superseded by the adopted import history; its saved records are retained.' }, $inc: { executionRevision: 1, writerRevision: 1, evidenceRevision: 1 } }, { new: true, session }).lean();
        if (!retired) fail('The original operation changed during adoption.');
      }
      const released = await models.Writers.findOneAndUpdate({ _id: writer._id, ...company, revision: writer.revision, unresolved: null, 'populationDelegation.jobId': terms.jobId }, { $set: { populationDelegation: null, operationId: null, planHash: null }, $inc: { revision: 1 } }, { new: true, session }).lean();
      const advanced = await models.Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, revision: calendar.revision, writerRevision: calendar.writerRevision, verifiedThrough: null, pendingCommit: null, adoption: null, stopRequested: false }, { $set: { verifiedThrough: reviewed.through, adoption: marker, currentOperationId: null }, $inc: { revision: 1, writerRevision: 1 } }, { new: true, session }).lean();
      const touched = await models.Policies.findOneAndUpdate({ _id: policy._id, ...company, revision: policy.revision, state: 'active' }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      const closed = await population.Jobs.findOneAndUpdate({ _id: terms.jobId, ...scope, revision: job.revision, status: job.status }, { $set: { status: 'adopted', adoption: { adoptionId, through: reviewed.through, auditId } }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!released || !advanced || !touched || !closed) fail('Company ownership changed before adoption.');
      await models.Audits.create([{ _id: auditId, userId: ownerId, actorUserId: actorId !== ownerId ? actorId : undefined, realmId: scope.realmId, action: 'Imported business history adopted', actionType: 'manual', outcome: 'success',
        beforeState: { ...scope, jobId: terms.jobId, jobStatus: job.status, manifestHash: terms.manifestHash, importedHash: terms.importedHash, original, writerRevision: writer.revision, calendarRevision: calendar.revision, verifiedThrough: null },
        afterState: { ...scope, marker, evidence: reviewed.evidence, basis: 'adopted', qboWrites: 0, reason: input.reason.trim() } }], { session });
      return { adopted: true, reused: false, adoptionId, through: reviewed.through, qboWrites: 0 };
    });
  }
  return { review, adopt, evidence };
}
module.exports = { createHistoryAdoptionService };
