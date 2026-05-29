const express = require('express');
const Connection = require('../models/Connection');
const CompanyProfile = require('../models/CompanyProfile');
const { authenticate } = require('../middleware/auth');
const { createAuditEntry } = require('../middleware/auditLogger');
const { createQBOClient } = require('../modules/qbo-client');
const { respondQboError } = require('../modules/qbo-error');
const { deriveTokenHealth, isAuthFailure } = require('../modules/connection-health');

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
 * GET /snapshot
 * Read-only count summary of the connected company's key entities.
 * Each count is queried independently so one failing count yields null
 * instead of failing the whole snapshot.
 */
router.get('/snapshot', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const qbo = await createQBOClient(connection);

    const [
      customers,
      vendors,
      items,
      accounts,
      openInvoices,
      openBills,
    ] = await Promise.all([
      countOf(qbo, 'SELECT COUNT(*) FROM Customer'),
      countOf(qbo, 'SELECT COUNT(*) FROM Vendor'),
      countOf(qbo, 'SELECT COUNT(*) FROM Item'),
      countOf(qbo, 'SELECT COUNT(*) FROM Account'),
      countOf(qbo, "SELECT COUNT(*) FROM Invoice WHERE Balance > '0'"),
      countOf(qbo, "SELECT COUNT(*) FROM Bill WHERE Balance > '0'"),
    ]);

    return res.json({
      counts: { customers, vendors, items, accounts, openInvoices, openBills },
    });
  } catch (err) {
    console.error('[company/snapshot]', err.message);
    if (respondQboError(res, err)) return;
    return res.status(500).json({ error: 'Failed to load company snapshot' });
  }
});

/**
 * GET /health
 * Returns connection health, freshness score, and refresh-token lifetime.
 *
 * Health reflects the REFRESH token (the long-lived credential), not the
 * short-lived access token, so a routinely-expired access token is not
 * reported as a broken connection.
 *
 * With ?probe=true the endpoint makes ONE cheap read-only QBO call
 * (SELECT * FROM CompanyInfo) to verify the connection is genuinely live right
 * now. That call forces a token refresh if needed (persisted by the client). On
 * an auth failure the connection is marked expired so the UI can prompt a
 * reconnect; transient upstream errors are reported as "could not verify"
 * without falsely downgrading the connection. The probe never returns a 401/502
 * to the caller — it always resolves to a health object so the dashboard can
 * render gracefully.
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

    const now = new Date();

    // Optional live verification.
    let verified;
    let verifiedAt;
    let needsReconnect = false;
    let probeError = false;
    if (req.query.probe === 'true' && deriveTokenHealth(connection, now).usable) {
      try {
        const qbo = await createQBOClient(connection);
        // Cheap, read-only round-trip. Also refreshes the access token via the
        // client when stale, persisting new tokens onto `connection`.
        await qbo.query('SELECT * FROM CompanyInfo');
        verified = true;
        verifiedAt = new Date();
      } catch (err) {
        verified = false;
        if (isAuthFailure(err)) {
          // Refresh token / authorization rejected -> user must reconnect.
          // Audit the lifecycle transition: this GET auto-fires from the
          // dashboard and silently flips connection state, so it needs a trail.
          const beforeStatus = connection.status;
          connection.status = 'expired';
          await connection.save();
          needsReconnect = true;
          await createAuditEntry(req.user.id, connection.realmId, 'QBO connection expired', {
            actionType: 'connection',
            outcome: 'failure',
            beforeState: { status: beforeStatus },
            afterState: { status: 'expired' },
          });
        } else {
          // Transient upstream error (5xx/429/network) -> do not downgrade.
          probeError = true;
        }
        console.error('[company/health] live probe failed', {
          status: err.status || 'unknown',
          intuit_tid: err.intuit_tid || 'unknown',
          needsReconnect,
        });
      }
    }

    // Recompute health AFTER any probe-driven token refresh / status change.
    const health = deriveTokenHealth(connection, now);

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
      connectionStatus: health.effectiveStatus,
      usable: health.usable,
      tokenValid: health.accessTokenValid,
      // Access-token countdown (can be negative); kept for back-compat. The UI
      // should prefer the refresh-token fields below for "connection health".
      tokenExpiresInMinutes: health.accessTokenExpiresInMinutes,
      accessTokenExpiresInMinutes: health.accessTokenExpiresInMinutes,
      refreshTokenValid: health.refreshTokenValid,
      refreshTokenExpiresAt: health.refreshTokenExpiresAt,
      refreshTokenExpiresInDays: health.refreshTokenExpiresInDays,
      verified,
      verifiedAt,
      needsReconnect,
      probeError,
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
 * Run a COUNT(*) query and return the integer count, or null on any failure.
 * Used by GET /snapshot so a single failing count does not fail the request.
 */
async function countOf(qbo, q) {
  try {
    const r = await qbo.query(q);
    return r.QueryResponse?.totalCount ?? null;
  } catch {
    return null;
  }
}

/**
 * Detect QBO subscription tier from company info and preferences.
 *
 * Best-effort: QBO API exposes no reliable documented subscription-tier field;
 * verify against the live company before trusting the label.
 */
function detectTier(info, preferences) {
  // QBO Online tiers: Simple Start, Essentials, Plus, Advanced

  // (a) Best-effort scan of CompanyInfo.NameValue for an offering/SKU/plan
  // hint. There is no documented tier field, so we look at any name that
  // smells like a plan identifier, plus any value that names a known tier.
  const nameValues = Array.isArray(info.NameValue) ? info.NameValue : [];
  const haystackParts = [];
  for (const nv of nameValues) {
    if (!nv || typeof nv !== 'object') continue;
    const name = String(nv.Name || '');
    const value = String(nv.Value || '');
    if (/offering|sku|subscription|plan/i.test(name)) haystackParts.push(value);
    if (/advanced|plus|essentials|simple start/i.test(value)) haystackParts.push(value);
  }
  const haystack = haystackParts.join(' ').toLowerCase();
  if (haystack.includes('advanced')) return 'Advanced';
  if (haystack.includes('plus')) return 'Plus';
  if (haystack.includes('essentials')) return 'Essentials';
  if (haystack.includes('simple start')) return 'Simple Start';

  // (b) Fall back to feature heuristics from preferences.
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
  // 'Advanced' has all features → no known limitations. 'Plus' falls through
  // with no entries here as well.
  if (tier === 'Advanced') {
    return [];
  }
  return limitations;
}

module.exports = router;
