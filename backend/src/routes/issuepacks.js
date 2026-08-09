const express = require('express');
const Connection = require('../models/Connection');
const IssuePack = require('../models/IssuePack');
const IssuePackRun = require('../models/IssuePackRun');
const { authenticate } = require('../middleware/auth');
const { requireProductionConfirm } = require('../middleware/productionGuard');
const { requireFeatureFlag } = require('../middleware/featureGate');
const { createAuditEntry } = require('../middleware/auditLogger');
const { createQBOClient } = require('../modules/qbo-client');
const { executePack } = require('../modules/issuepack-engine');

const router = express.Router();

async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

/**
 * Load entity data needed by issue pack executors.
 */
async function loadEntityData(qbo) {
  const [custResult, vendResult, itemResult, expResult, bankResult] = await Promise.all([
    qbo.query("SELECT * FROM Customer WHERE DisplayName LIKE 'TestCust%' MAXRESULTS 100"),
    qbo.query("SELECT * FROM Vendor WHERE DisplayName LIKE 'TestVendor%' MAXRESULTS 100"),
    qbo.query("SELECT * FROM Item WHERE Name LIKE 'TestSvc%' MAXRESULTS 100"),
    qbo.query("SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 10"),
    qbo.query("SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 10"),
  ]);

  return {
    customers: custResult.QueryResponse?.Customer || [],
    vendors: vendResult.QueryResponse?.Vendor || [],
    items: itemResult.QueryResponse?.Item || [],
    expenseAccounts: expResult.QueryResponse?.Account || [],
    bankAccounts: bankResult.QueryResponse?.Account || [],
  };
}

/**
 * GET /
 * List all issue pack definitions.
 */
router.get('/', authenticate, async (_req, res) => {
  try {
    const packs = await IssuePack.find().sort({ category: 1, name: 1 });
    return res.json({ packs });
  } catch (err) {
    console.error('[issuepacks/list]', err.message);
    return res.status(500).json({ error: 'Failed to list issue packs' });
  }
});

/**
 * GET /runs
 * List all runs for this user/realm.
 */
router.get('/runs', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const runs = await IssuePackRun.find({
      userId: req.user.id,
      realmId: connection.realmId,
    })
      .populate('issuePackId', 'name slug category severity')
      .sort({ createdAt: -1 });

    return res.json({ runs });
  } catch (err) {
    console.error('[issuepacks/runs]', err.message);
    return res.status(500).json({ error: 'Failed to list runs' });
  }
});

/**
 * GET /runs/:runId
 * Get run detail with execution log.
 */
router.get('/runs/:runId', authenticate, async (req, res) => {
  try {
    const run = await IssuePackRun.findOne({
      _id: req.params.runId,
      userId: req.user.id,
    }).populate('issuePackId', 'name slug category severity');

    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    return res.json({ run });
  } catch (err) {
    console.error('[issuepacks/run-detail]', err.message);
    return res.status(500).json({ error: 'Failed to fetch run' });
  }
});

/**
 * GET /:slug
 * Get single issue pack detail.
 */
router.get('/:slug', authenticate, async (req, res) => {
  try {
    const pack = await IssuePack.findOne({ slug: req.params.slug });
    if (!pack) {
      return res.status(404).json({ error: 'Issue pack not found' });
    }
    return res.json({ pack });
  } catch (err) {
    console.error('[issuepacks/get]', err.message);
    return res.status(500).json({ error: 'Failed to fetch issue pack' });
  }
});

/**
 * POST /:slug/run
 * Execute an issue pack (background).
 */
router.post(
  '/:slug/run',
  authenticate,
  requireFeatureFlag('experimental.issuePackMutations', { message: 'Legacy issue-pack mutations are disabled by server policy' }),
  requireProductionConfirm,
  async (req, res) => {
    try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const pack = await IssuePack.findOne({ slug: req.params.slug });
    if (!pack) {
      return res.status(404).json({ error: 'Issue pack not found' });
    }

    const realmId = connection.realmId;

    // Create run record
    const run = await IssuePackRun.create({
      userId: req.user.id,
      realmId,
      issuePackId: pack._id,
      status: 'in_progress',
      startedAt: new Date(),
    });

    // Fire and forget
    (async () => {
      try {
        const qbo = await createQBOClient(connection);
        const entityData = await loadEntityData(qbo);

        // Check prerequisites
        if (['ar-mismatch', 'tax-code-inconsistency', 'unapplied-credit', 'orphaned-payment'].includes(pack.slug)) {
          if (!entityData.customers.length || !entityData.items.length) {
            throw new Error('Prerequisite failed: need customers and items. Run seeding first.');
          }
        }
        if (['duplicate-payment'].includes(pack.slug)) {
          if (!entityData.vendors.length || !entityData.expenseAccounts.length || !entityData.bankAccounts.length) {
            throw new Error('Prerequisite failed: need vendors, expense accounts, and bank accounts. Run seeding first.');
          }
        }

        const result = await executePack(pack.slug, qbo, entityData);

        run.createdEntities = result.createdEntities;
        run.executionLog = result.log;
        run.status = 'completed';
        run.completedAt = new Date();
        await run.save();

        // Audit each created entity individually
        for (const entity of result.createdEntities) {
          const logEntry = result.log.find((l) => l.step === entity.step);
          await createAuditEntry(req.user.id, realmId, `Issue pack "${pack.name}" created ${entity.entity} #${entity.qboId}`, {
            actionType: 'issue_pack_entity',
            outcome: 'success',
            afterState: {
              runId: run._id,
              slug: pack.slug,
              entity: entity.entity,
              qboId: entity.qboId,
              step: entity.step,
              detail: logEntry?.detail || '',
            },
          });
        }

        await createAuditEntry(req.user.id, realmId, `Issue pack completed: ${pack.name}`, {
          actionType: 'issue_pack',
          outcome: 'success',
          afterState: {
            runId: run._id,
            slug: pack.slug,
            entitiesCreated: result.createdEntities.length,
          },
        });
      } catch (err) {
        run.status = 'failed';
        run.completedAt = new Date();
        run.executionLog.push({
          step: 0,
          action: 'execution',
          outcome: 'failure',
          detail: err.message || String(err),
          timestamp: new Date(),
        });
        await run.save();

        await createAuditEntry(req.user.id, realmId, `Issue pack failed: ${pack.name}`, {
          actionType: 'issue_pack',
          outcome: 'failure',
          error: err.message || String(err),
        });
      }
    })().catch((err) => {
      console.error('[issuepacks/run-bg]', err.message);
    });

    return res.json({ run, message: 'Issue pack execution started' });
    } catch (err) {
    console.error('[issuepacks/run]', err.message);
    return res.status(500).json({ error: 'Failed to start issue pack' });
    }
  }
);

module.exports = router;
