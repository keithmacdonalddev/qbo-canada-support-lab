const GenerationRun = require('../models/GenerationRun');
const CompanyProfile = require('../models/CompanyProfile');
const { createAuditEntry } = require('../middleware/auditLogger');
const { buildGenerationPlan, queryEntities, queryAccounts } = require('./generation-plan');
const { LEASE_MS, SUMMARY_KEYS } = require('./generation-state');
const { redactLogSecrets } = require('./log-diagnostic');

function resolveReferences(value, steps) {
  if (typeof value === 'string') {
    return value.replace(/\$step:(\d+)/g, (_match, index) => {
      const parent = steps[Number(index)];
      if (parent?.state !== 'succeeded' || !parent.receipt?.Id) throw new Error('A linked transaction has not been confirmed.');
      return parent.receipt.Id;
    });
  }
  if (Array.isArray(value)) return value.map(v => resolveReferences(v, steps));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveReferences(v, steps)]));
  return value;
}

// Only an explicit API rejection proves the write did not take effect.
function isDefiniteRejection(error) {
  return error.qboStage === 'api' && [400, 401, 403, 404, 405, 422, 429].includes(error.status);
}

async function runGenerationJob(run, connection, dependencies = {}) {
  const Runs = dependencies.Runs || GenerationRun;
  const Profiles = dependencies.Profiles || CompanyProfile;
  const audit = dependencies.audit || createAuditEntry;
  const clientFactory = dependencies.clientFactory || require('./qbo-client').createQBOClient;
  const buildPlan = dependencies.buildPlan || buildGenerationPlan;
  const clock = dependencies.now || (() => Date.now());
  const token = run.leaseToken;
  const scope = { _id: run._id, leaseToken: token };
  let ownershipLost = false;
  let planSaved = !!run.steps?.length;
  let dirtyStepIndex = null;

  async function save({ beforeWrite = false, release = false } = {}) {
    const now = clock();
    const filter = beforeWrite ? { ...scope, leaseExpiresAt: { $gt: new Date(now) } } : scope;
    run.leaseExpiresAt = release ? new Date(0) : new Date(now + LEASE_MS);
    const fields = { status: run.status, leaseExpiresAt: run.leaseExpiresAt,
      leaseToken: release ? null : token, progress: run.progress, txnsSummary: run.txnsSummary,
      lastError: run.lastError, completedAt: run.completedAt };
    if (!planSaved && run.steps?.length) fields.steps = run.steps;
    else if (dirtyStepIndex !== null) fields['steps.' + dirtyStepIndex] = run.steps[dirtyStepIndex];
    if (release) {
      fields.createdTransactions = run.createdTransactions;
      fields.generationErrors = run.generationErrors;
    }
    const result = await Runs.updateOne(filter, { $set: fields });
    if (result.matchedCount !== 1) {
      ownershipLost = true;
      throw new Error('Generation ownership changed. No further transactions were sent.');
    }
    if (run.steps?.length) planSaved = true;
  }

  function refreshProgress() {
    const succeeded = (run.steps || []).filter(s => s.state === 'succeeded');
    run.txnsSummary = Object.fromEntries(Object.values(SUMMARY_KEYS).map(k => [k, 0]));
    run.createdTransactions = succeeded.map(step => {
      run.txnsSummary[SUMMARY_KEYS[step.entity]]++;
      return { ...step.transaction, qboId: step.receipt.Id, docNumber: step.receipt.DocNumber || '',
        linkedTo: resolveReferences(step.transaction.linkedTo || '', run.steps), timestamp: step.completedAt };
    });
    run.generationErrors = (run.steps || []).filter(s => ['rejected', 'uncertain', 'sending'].includes(s.state)).map(s => ({
      type: s.entity, detail: s.error || 'Result not confirmed. Inspect QuickBooks before retrying.', txnDate: s.payload.TxnDate,
    }));
    run.progress = { phase: 'generating', detail: succeeded.length + ' of ' + (run.steps || []).length + ' records created', totalTxns: succeeded.length };
  }

  try {
    // Include setup failures in persisted final state; do not strand pending jobs.
    const qbo = await clientFactory(connection);
    if (!run.steps?.length) {
      const customers = await queryEntities(qbo, 'Customer', 'DisplayName', 'TestCust');
      const vendors = await queryEntities(qbo, 'Vendor', 'DisplayName', 'TestVendor');
      const items = await queryEntities(qbo, 'Item', 'Name', 'TestSvc');
      const expenseAccounts = await queryAccounts(qbo, 'Expense');
      const bankAccounts = await queryAccounts(qbo, 'Bank');
      const incomeAccounts = await queryAccounts(qbo, 'Income');
      if (!customers.length || !vendors.length || !items.length) throw new Error('Master data not found. Run seeding first.');
      if (!bankAccounts.length || !expenseAccounts.length || !incomeAccounts.length) throw new Error('Required Bank, Expense, or Income accounts were not found.');
      run.steps = await buildPlan(run.config, { customers, vendors, items, expenseAccounts, bankAccounts, incomeAccounts });
      if (!run.steps.length) throw new Error('The generation plan is empty.');
      await save({ beforeWrite: true }); // Entire plan is durable before any write.
    }
    for (const [index, step] of run.steps.entries()) {
      dirtyStepIndex = index;
      if (['sending', 'uncertain'].includes(step.state)) throw new Error('An earlier transaction needs inspection in QuickBooks.');
      if (step.state !== 'succeeded') {
        const payload = resolveReferences(step.payload, run.steps);
        const previousState = step.state;
        step.state = 'sending';
        step.error = null;
        try {
          await save({ beforeWrite: true });
        } catch (error) {
          // Dispatch has not occurred. A retry can safely persist the old state.
          step.state = previousState;
          throw error;
        } // Fenced dispatch barrier; never replay sending.
        let receipt;
        try {
          const result = await qbo.create(step.entity, payload);
          receipt = result[step.transaction.entity];
          if (!receipt?.Id || typeof receipt.Id !== 'string') throw new Error('QuickBooks did not return a confirmed record ID.');
        } catch (error) {
          step.state = isDefiniteRejection(error) ? 'rejected' : 'uncertain';
          step.error = redactLogSecrets(error.message || 'Transaction result could not be confirmed.');
          await save();
          throw error;
        }
        step.state = 'succeeded';
        step.receipt = { Id: receipt.Id, DocNumber: receipt.DocNumber || '' };
        step.completedAt = new Date(clock());
        refreshProgress();
        await save(); // Save accepted QBO ID before audit or any subsequent write.
      }
      if (!step.audited) {
        const entry = await audit(run.userId, run.realmId, 'Generated ' + step.transaction.entity + ' #' + step.receipt.Id, {
          actionType: 'generate_txn', outcome: 'success',
          afterState: { genRunId: run._id, environment: run.environment, ...step.transaction, qboId: step.receipt.Id,
            linkedTo: resolveReferences(step.transaction.linkedTo || '', run.steps) },
        });
        if (!entry) throw new Error('Could not save the transaction audit. Resume to repair it without recreating records.');
        step.audited = true;
        await save();
      }
    }
    refreshProgress();
    const completedAudit = await audit(run.userId, run.realmId, 'Historical generation successful', {
      actionType: 'generate', outcome: 'success', afterState: { genRunId: run._id, environment: run.environment, totalTransactions: run.createdTransactions.length },
    });
    if (!completedAudit) throw new Error('Could not save the completion audit. Resume to finish without recreating records.');
    run.status = 'completed';
    run.lastError = null;
    run.progress.phase = 'done';
    run.progress.detail = 'Successful: ' + run.createdTransactions.length + ' records created';
    run.completedAt = new Date(clock());
  } catch (error) {
    if (ownershipLost) return;
    refreshProgress();
    run.status = run.steps?.some(s => ['sending', 'uncertain'].includes(s.state)) ? 'interrupted'
      : run.createdTransactions.length ? 'partial' : 'failed';
    run.lastError = redactLogSecrets(error.message || 'Generation failed.');
    run.progress.phase = run.status;
    run.progress.detail = run.lastError;
    run.completedAt = new Date(clock());
  }
  // Failures here leave the lease and durable step barrier intact. A later read
  // reports interruption; no background retry or startup rewrite sends more work.
  await save({ release: true });
  await Profiles.findOneAndUpdate({ userId: run.userId, realmId: run.realmId }, { $set: {
    generationStatus: run.status,
    ...(run.status === 'completed' ? { lastGenerationDate: new Date(clock()) } : {}),
    lastActivityAt: new Date(clock()),
  } });
}

module.exports = { runGenerationJob, resolveReferences, isDefiniteRejection };
