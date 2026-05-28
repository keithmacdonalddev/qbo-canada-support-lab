const express = require('express');
const Connection = require('../models/Connection');
const CompanyProfile = require('../models/CompanyProfile');
const { authenticate } = require('../middleware/auth');
const { createAuditEntry } = require('../middleware/auditLogger');
const { createQBOClient } = require('../modules/qbo-client');
const { respondQboError } = require('../modules/qbo-error');

const router = express.Router();

/**
 * Helper -- find the user's active Connection or return 404.
 */
async function getActiveConnection(userId) {
  return Connection.findOne({
    userId,
    status: 'active',
  }).sort({ updatedAt: -1 });
}

/**
 * GET /
 * Returns the user's company profile.
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const profile = await CompanyProfile.findOne({
      userId: req.user.id,
      realmId: connection.realmId,
    });

    if (!profile) {
      return res.status(404).json({
        error: 'Company profile not found. Run POST /assess to create one.',
      });
    }

    return res.json({ profile });
  } catch (err) {
    console.error('[company/get]', err.message);
    return res.status(500).json({ error: 'Failed to fetch company profile' });
  }
});

/**
 * POST /assess
 * Reads company info from QBO API, creates/updates CompanyProfile
 * with tier, features, etc.
 */
router.post('/assess', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const qbo = await createQBOClient(connection);

    // Query company info from QBO
    const companyInfo = await qbo.query(
      'SELECT * FROM CompanyInfo MAXRESULTS 1'
    );
    const info = companyInfo.QueryResponse?.CompanyInfo?.[0] || {};

    // Query preferences for feature detection
    let preferences = {};
    try {
      const prefResult = await qbo.query('SELECT * FROM Preferences');
      preferences = prefResult.QueryResponse?.Preferences?.[0] || {};
    } catch (_) { /* preferences query may not be available */ }

    // Determine subscription tier based on available signals
    const tier = detectTier(info, preferences);
    const features = detectFeatures(info, preferences);
    const limitations = detectLimitations(tier);

    // Upsert CompanyProfile
    const profile = await CompanyProfile.findOneAndUpdate(
      { userId: req.user.id, realmId: connection.realmId },
      {
        userId: req.user.id,
        connectionId: connection._id,
        realmId: connection.realmId,
        companyName: info.CompanyName || connection.companyName || 'Unknown',
        subscriptionTier: tier,
        enabledFeatures: features,
        knownLimitations: limitations,
        lastActivityAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Update connection with company name if available
    if (info.CompanyName && info.CompanyName !== connection.companyName) {
      connection.companyName = info.CompanyName;
      await connection.save();
    }

    await createAuditEntry(req.user.id, connection.realmId, 'Company assessed', {
      actionType: 'manual',
      outcome: 'success',
      afterState: {
        tier,
        features,
        companyName: profile.companyName,
      },
    });

    return res.json({ profile });
  } catch (err) {
    console.error('[company/assess]', err.message, err.stack);
    if (respondQboError(res, err)) return;
    return res.status(500).json({ error: `Assessment failed: ${err.message}` });
  }
});

/**
 * GET /health
 * Returns connection health and freshness score.
 */
router.get('/health', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const profile = await CompanyProfile.findOne({
      userId: req.user.id,
      realmId: connection.realmId,
    });

    // Connection health checks
    const now = new Date();
    const tokenValid =
      connection.tokenExpiresAt && connection.tokenExpiresAt > now;
    const tokenExpiresInMs = connection.tokenExpiresAt
      ? connection.tokenExpiresAt.getTime() - now.getTime()
      : 0;

    // Freshness score: 100 = just assessed, decays over 7 days to 0
    const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    let freshnessScore = 0;
    if (profile && profile.lastActivityAt) {
      const age = now.getTime() - profile.lastActivityAt.getTime();
      freshnessScore = Math.max(0, Math.round(100 * (1 - age / FRESHNESS_WINDOW_MS)));
    }

    // Persist freshness score
    if (profile) {
      profile.freshnessScore = freshnessScore;
      await profile.save();
    }

    return res.json({
      connectionStatus: connection.status,
      tokenValid,
      tokenExpiresInMinutes: Math.round(tokenExpiresInMs / 60000),
      lastRefreshedAt: connection.lastRefreshedAt,
      freshnessScore,
      seedingStatus: profile ? profile.seedingStatus : 'pending',
      companyName: profile ? profile.companyName : connection.companyName,
    });
  } catch (err) {
    console.error('[company/health]', err.message);
    return res.status(500).json({ error: 'Health check failed' });
  }
});

// --- Internal helpers ---

/**
 * Detect QBO subscription tier from company info and preferences.
 */
function detectTier(info, preferences) {
  // QBO Online tiers: Simple Start, Essentials, Plus, Advanced
  // Country and feature heuristics
  const country = info.Country || info.CompanyAddr?.Country || '';
  if (preferences.SalesFormsPrefs?.AllowEstimates) return 'Plus';
  if (preferences.VendorAndPurchasesPrefs?.TrackingByCustomer) return 'Plus';
  if (country === 'CA') return 'Essentials'; // default guess for Canadian sandbox
  return 'Essentials';
}

/**
 * Detect enabled features from company info and preferences.
 */
function detectFeatures(info, preferences) {
  const features = [];

  if (preferences.SalesFormsPrefs?.AllowEstimates) features.push('estimates');
  if (preferences.SalesFormsPrefs?.AllowServiceDate) features.push('service_date');
  if (preferences.TaxPrefs?.UsingSalesTax) features.push('sales_tax');
  if (preferences.VendorAndPurchasesPrefs?.TrackingByCustomer) features.push('expense_tracking_by_customer');
  if (preferences.TimeTrackingPrefs?.UseServices) features.push('time_tracking');
  if (preferences.CurrencyPrefs?.MultiCurrencyEnabled) features.push('multi_currency');

  const country = info.Country || info.CompanyAddr?.Country || '';
  if (country === 'CA') features.push('canadian_tax');

  return features;
}

/**
 * Known limitations by tier.
 */
function detectLimitations(tier) {
  const limitations = [];
  if (tier === 'Simple Start') {
    limitations.push('no_bills', 'no_purchase_orders', 'single_user', 'no_budgets');
  }
  if (tier === 'Essentials') {
    limitations.push('no_purchase_orders', 'no_inventory', 'no_budgets');
  }
  return limitations;
}

module.exports = router;
