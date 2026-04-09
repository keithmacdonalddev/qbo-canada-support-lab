const express = require('express');
const Connection = require('../models/Connection');
const CompanyProfile = require('../models/CompanyProfile');
const SeedRun = require('../models/SeedRun');
const { authenticate } = require('../middleware/auth');
const { createAuditEntry } = require('../middleware/auditLogger');
const { createQBOClient } = require('../modules/qbo-client');

const router = express.Router();

// --- Seed data templates (mirrors Phase 0 patterns) ---

function generateCustomers(count) {
  const list = [];
  for (let i = 1; i <= count; i++) {
    list.push({
      DisplayName: `TestCust-${String(i).padStart(3, '0')}`,
      CompanyName: `Test Customer ${i} Ltd`,
      PrimaryEmailAddr: { Address: `cust${i}@example.com` },
      BillAddr: {
        Line1: `${i * 10} Main St`,
        City: 'Toronto',
        CountrySubDivisionCode: 'ON',
        PostalCode: 'M5V 1A1',
      },
      PrimaryPhone: { FreeFormNumber: `416-555-${String(i).padStart(4, '0')}` },
    });
  }
  return list;
}

function generateVendors(count) {
  const list = [];
  for (let i = 1; i <= count; i++) {
    list.push({
      DisplayName: `TestVendor-${String(i).padStart(3, '0')}`,
      CompanyName: `Test Vendor ${i} Inc`,
      PrimaryEmailAddr: { Address: `vendor${i}@example.com` },
      PrimaryPhone: { FreeFormNumber: `905-555-${String(i).padStart(4, '0')}` },
    });
  }
  return list;
}

function generateServiceItems(count, incomeAccountId) {
  const list = [];
  for (let i = 1; i <= count; i++) {
    list.push({
      Name: `TestSvc-${String(i).padStart(3, '0')}`,
      Type: 'Service',
      IncomeAccountRef: incomeAccountId ? { value: incomeAccountId } : undefined,
      Description: `Test service item ${i}`,
      UnitPrice: 50 + i * 5,
    });
  }
  return list;
}

// --- Helpers ---

/**
 * Query existing entities and return a Set of display name values for
 * idempotent creation (skip entities that already exist).
 */
async function findExisting(qbo, entity, nameField) {
  const result = await qbo.query(
    `SELECT ${nameField} FROM ${entity} MAXRESULTS 1000`
  );
  const records = result.QueryResponse?.[entity] || [];
  return new Set(records.map(r => r[nameField]));
}

/**
 * Create entities one-by-one, skipping existing ones.
 * Returns { created, skipped, errors }.
 */
async function createBatch(qbo, entity, items, nameField) {
  const existing = await findExisting(qbo, entity, nameField);
  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const item of items) {
    if (existing.has(item[nameField])) {
      skipped++;
      continue;
    }
    try {
      await qbo.create(entity.toLowerCase(), item);
      created++;
    } catch (err) {
      errors.push({
        entity: entity.toLowerCase(),
        name: item[nameField],
        error: err.message || String(err),
      });
    }
  }

  return { created, skipped, errors };
}

/**
 * Helper -- find the user's active Connection.
 */
async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

// --- Routes ---

/**
 * Run seeding in the background, updating SeedRun progress as it goes.
 */
async function runSeedingJob(userId, realmId, seedRunId, connection) {
  const seedRun = await SeedRun.findById(seedRunId);
  const qbo = await createQBOClient(connection);

  try {
    // --- Discover income account for service items ---
    let incomeAccountId = null;
    try {
      const accounts = await qbo.query(
        "SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 5"
      );
      const incomeAcct = accounts.QueryResponse?.Account?.[0];
      if (incomeAcct) incomeAccountId = incomeAcct.Id;
    } catch (_) { /* proceed without income account */ }

    // --- Seed Customers ---
    seedRun.progress = { phase: 'customers', detail: 'Seeding customers (0/50)...' };
    await seedRun.save();
    const custData = generateCustomers(50);
    const custResult = await createBatchWithProgress(qbo, 'Customer', custData, 'DisplayName', seedRun, 'customers', 50);

    // --- Seed Vendors ---
    seedRun.progress = { phase: 'vendors', detail: 'Seeding vendors (0/30)...' };
    await seedRun.save();
    const vendData = generateVendors(30);
    const vendResult = await createBatchWithProgress(qbo, 'Vendor', vendData, 'DisplayName', seedRun, 'vendors', 30);

    // --- Seed Items ---
    seedRun.progress = { phase: 'items', detail: 'Seeding items (0/50)...' };
    await seedRun.save();
    const itemData = generateServiceItems(50, incomeAccountId);
    const itemResult = await createBatchWithProgress(qbo, 'Item', itemData, 'Name', seedRun, 'items', 50);

    // Aggregate errors
    const allErrors = [
      ...custResult.errors,
      ...vendResult.errors,
      ...itemResult.errors,
    ];

    // Update SeedRun
    seedRun.entitiesCreated = {
      customers: custResult.created,
      vendors: vendResult.created,
      items: itemResult.created,
      accounts: 0,
    };
    seedRun.entitiesSkipped = {
      customers: custResult.skipped,
      vendors: vendResult.skipped,
      items: itemResult.skipped,
      accounts: 0,
    };
    seedRun.seedErrors = allErrors;
    seedRun.status = 'completed';
    seedRun.progress = { phase: 'done', detail: 'Seeding complete' };
    seedRun.completedAt = new Date();
    await seedRun.save();

    // Update CompanyProfile
    await CompanyProfile.findOneAndUpdate(
      { userId, realmId },
      {
        seedingStatus: 'completed',
        lastSeedDate: new Date(),
        lastActivityAt: new Date(),
      }
    );

    // Audit
    await createAuditEntry(userId, realmId, 'Master data seeded', {
      actionType: 'seed',
      outcome: allErrors.length > 0 ? 'partial' : 'success',
      afterState: {
        seedRunId: seedRun._id,
        customers: custResult.created,
        vendors: vendResult.created,
        items: itemResult.created,
        errors: allErrors.length,
      },
    });
  } catch (err) {
    // Seeding failed mid-run
    seedRun.status = 'failed';
    seedRun.completedAt = new Date();
    seedRun.progress = { phase: 'error', detail: err.message || 'Unknown error' };
    seedRun.seedErrors.push({
      entity: 'general',
      name: 'seed-run',
      error: err.message || String(err),
    });
    await seedRun.save();

    await CompanyProfile.findOneAndUpdate(
      { userId, realmId },
      { seedingStatus: 'failed' }
    );

    await createAuditEntry(userId, realmId, 'Master data seed failed', {
      actionType: 'seed',
      outcome: 'failure',
      error: err.message || String(err),
    });
  }
}

/**
 * Like createBatch, but updates SeedRun progress after each entity.
 */
async function createBatchWithProgress(qbo, entity, items, nameField, seedRun, phaseName, total) {
  const existing = await findExisting(qbo, entity, nameField);
  let created = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (existing.has(item[nameField])) {
      skipped++;
    } else {
      try {
        await qbo.create(entity.toLowerCase(), item);
        created++;
      } catch (err) {
        errors.push({
          entity: entity.toLowerCase(),
          name: item[nameField],
          error: err.message || String(err),
        });
      }
    }

    // Update progress every 5 entities or on the last one
    if ((i + 1) % 5 === 0 || i === items.length - 1) {
      seedRun.progress = {
        phase: phaseName,
        detail: `Seeding ${phaseName} (${i + 1}/${total})...`,
        created,
        skipped,
      };
      await seedRun.save();
    }
  }

  return { created, skipped, errors };
}

/**
 * POST /start
 * Kicks off master data seeding asynchronously.
 */
router.post('/start', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const realmId = connection.realmId;

    // Prevent duplicate runs
    const existing = await SeedRun.findOne({
      userId: req.user.id,
      realmId,
      status: 'in_progress',
    });
    if (existing) {
      return res.json({ seedRun: existing, message: 'Seeding already in progress' });
    }

    // Create the SeedRun record
    const seedRun = await SeedRun.create({
      userId: req.user.id,
      realmId,
      status: 'in_progress',
      startedAt: new Date(),
      progress: { phase: 'starting', detail: 'Initializing...' },
    });

    // Update CompanyProfile seeding status
    await CompanyProfile.findOneAndUpdate(
      { userId: req.user.id, realmId },
      {
        userId: req.user.id,
        connectionId: connection._id,
        realmId,
        seedingStatus: 'in_progress',
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    // Fire and forget — seeding runs in the background
    runSeedingJob(req.user.id, realmId, seedRun._id, connection).catch((err) => {
      console.error('[seed/background]', err.message);
    });

    return res.json({ seedRun, message: 'Seeding started' });
  } catch (err) {
    console.error('[seed/start]', err.message);
    return res.status(500).json({ error: 'Failed to start seeding' });
  }
});

/**
 * GET /status
 * Returns the latest SeedRun for the user's company.
 */
router.get('/status', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const seedRun = await SeedRun.findOne({
      userId: req.user.id,
      realmId: connection.realmId,
    }).sort({ createdAt: -1 });

    if (!seedRun) {
      return res.json({ seedRun: null, message: 'No seed runs found' });
    }

    return res.json({ seedRun });
  } catch (err) {
    console.error('[seed/status]', err.message);
    return res.status(500).json({ error: 'Failed to fetch seed status' });
  }
});

/**
 * GET /history
 * Returns all SeedRuns for the user's company.
 */
router.get('/history', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const seedRuns = await SeedRun.find({
      userId: req.user.id,
      realmId: connection.realmId,
    }).sort({ createdAt: -1 });

    return res.json({ seedRuns });
  } catch (err) {
    console.error('[seed/history]', err.message);
    return res.status(500).json({ error: 'Failed to fetch seed history' });
  }
});

module.exports = router;
