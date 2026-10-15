const { createCompanyPermissionGuard } = require('../middleware/companyPermission');
const requireCompanyWrite = createCompanyPermissionGuard('operations.execute');
const express = require('express');
const config = require('../config');
const Connection = require('../models/Connection');
const AISession = require('../models/AISession');
const AIPlan = require('../models/AIPlan');
const { authenticate } = require('../middleware/auth');
const { requireProductionConfirm } = require('../middleware/productionGuard');
const { requireFeatureFlag, publicFeatureFlags } = require('../middleware/featureGate');
const { createAuditEntry } = require('../middleware/auditLogger');
const orchestrator = require('../modules/ai-orchestrator');
const aiNotes = require('../modules/ai-notes');
const { isQboError, respondQboError } = require('../modules/qbo-error');
const caseChanges = require('../modules/case-changes');
const reproduction = require('../modules/reproduction-runner');
const approvals = require('../modules/reproduction-approvals');
const reconciler = require('../modules/reproduction-reconcile');
const { screenBroker } = require('../modules/reproduction-screen');
const { createQBOClient } = require('../modules/qbo-client');
const { createSessionAccess, respondSessionAccess } = require('../modules/ai-session-access');
const savedAccess = createSessionAccess();
const assertSavedRead = (req, session) => savedAccess.assertSession(req.user, session, req.currentAccount);
const savedIdentity = session => JSON.stringify(aiNotes.caseNoteEvidence(session));

const router = express.Router();

const streams = require('../modules/ai-session-streams').sessionStreams();
// Streaming uses the same Authorization header/current-account guard as other routes.
router.use(authenticate);

/**
 * Map a QBO upstream error onto this router's { success: false, ... } envelope.
 *
 * The shared qbo-error helper detects QBO upstream errors (isQboError) and the
 * other routes respond with { error, intuit_tid, qboStatus }; the AI routes
 * additionally include a `success: false` flag that AI frontend pages check.
 * This wrapper reuses that detector but preserves that flag while surfacing the
 * Intuit trace id and mapping QBO upstream errors to 502 (or 429 for rate
 * limits). Critically, it prevents a QBO-side 401 from being emitted as an
 * app-level 401 (which the frontend treats as a session expiry / logout).
 *
 * @param {import('express').Response} res
 * @param {*} err
 * @returns {boolean} true if a QBO error response was sent
 */
function sendQboErrorJson(res, err) {
  if (!isQboError(err)) return false;
  const httpStatus = err.status === 429 ? 429 : 502;
  res.status(httpStatus).json({
    success: false,
    error: err.message || 'QBO API error',
    intuit_tid: err.intuit_tid || null,
    qboStatus: typeof err.status === 'number' ? err.status : null,
  });
  return true;
}

/**
 * Errors from the AI model service (Codex CLI) are reported as themselves,
 * not as QuickBooks failures. Never an app-level 401.
 */
function sendAiProviderError(res, err) {
  if (!err?.aiProvider) return false;
  res.status(safeStatus(err)).json({ success: false, error: err.message, provider: 'ai' });
  return true;
}

/**
 * Upstream auth failures (e.g. a revoked Anthropic key) must not become an
 * HTTP 401: the frontend treats any 401 as session expiry and logs out.
 */
function safeStatus(err) {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  return status === 401 || status === 403 ? 502 : status;
}

/**
 * Helper -- find the user's active QBO Connection.
 */
async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

// A saved session may contain historical or corrupt plan references. Only expose
// plans belonging to that same workspace and original company.
function scopedPlans(session) {
  const plain = typeof session.toObject === 'function' ? session.toObject() : { ...session };
  if (Array.isArray(plain.plans)) plain.plans = plain.plans.filter(plan => plan && String(plan.userId) === String(plain.userId) && plan.realmId === plain.realmId && String(plan.sessionId) === String(plain._id));
  return plain;
}
async function assertLegacySessionRead(req, sessionId) {
  if (!sessionId) return;
  const session = await AISession.findOne({ _id: sessionId, userId: req.user.id }).select('userId realmId mode reproduction');
  await assertSavedRead(req, session);
  if (session.mode === 'reproduce' || session.reproduction) throw Object.assign(new Error('Use the reproduction case endpoint to continue this case.'), { status: 409, caseSessionRequired: true });
}
async function requireSavedPlan(req, res, next) {
  try {
    const plan = await AIPlan.findOne({ _id: req.params.id, userId: req.user.id });
    await assertSavedRead(req, plan);
    if (String(req.companyContext?.connection?.realmId) !== String(plan.realmId)) return res.status(409).json({ success: false, error: 'This plan belongs to a different company. Return to its original company before deciding it.' });
    return next();
  } catch (error) {
    if (respondSessionAccess(res, error)) return;
    return res.status(503).json({ success: false, error: 'Saved plan access could not be verified.' });
  }
}

// --- Routes ---

// Authenticated local-app rendezvous; the companion never receives a JWT.
const screenScope = (req) => ({ userId: String(req.user.id), actorId: String(req.user.actorId || req.user.id), caseId: req.params.id });
router.get('/sessions/:id/screen', async (req, res) => {
  try {
    const session = await AISession.findOne({ _id: req.params.id, userId: req.user.id, mode: 'reproduce' }).select('userId realmId reproduction');
    if (!session) return res.status(404).json({ success: false, error: 'Case not found.' });
    await assertSavedRead(req, session);
    const request = await screenBroker.poll(screenScope(req));
    await assertSavedRead(req, session);
    return res.json({ success: true, data: { request } });
  } catch (error) { if (respondSessionAccess(res, error)) return; return res.status(409).json({ success: false, error: 'The screen check is no longer active.' }); }
});
router.post('/sessions/:id/screen', async (req, res) => {
  try {
    const session = await AISession.findOne({ _id: req.params.id, userId: req.user.id, mode: 'reproduce' }).select('userId realmId reproduction');
    if (!session) return res.status(404).json({ success: false, error: 'Case not found.' });
    await assertSavedRead(req, session);
    if (req.body?.type === 'heartbeat') screenBroker.heartbeat(screenScope(req), req.body.ready === true);
    else if (req.body?.type === 'receipt') await screenBroker.receive(screenScope(req), req.body);
    else return res.status(400).json({ success: false, error: 'Invalid screen message.' });
    await assertSavedRead(req, session);
    return res.json({ success: true });
  } catch (error) { if (respondSessionAccess(res, error)) return; return res.status(409).json({ success: false, error: 'The screen evidence expired or did not match this active case.' }); }
});

// Reproduction is the connected company's normal workflow. The submitted case
// grants its operation scope; legacy plan/production confirmations are not used.
router.post('/reproduce', async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) return res.status(409).json({ success: false, error: 'Connect QuickBooks before starting a case.' });
    if (String(req.body.realmId || '') !== String(connection.realmId) || req.body.environment !== config.qbo.environment) {
      return res.status(409).json({ success: false, error: 'The connected company changed. Refresh the company information before starting.' });
    }
    const session = await reproduction.startCase({
      userId: req.user.id, actorId: req.user.actorId || req.user.id, connection,
      requestId: req.body.requestId, message: req.body.message, sessionId: req.body.sessionId, continueSaved: req.body.continueSaved ?? false,
    });
    return res.status(202).json({ success: true, data: { session: await reproduction.publicState(session) } });
  } catch (err) {
    return res.status(safeStatus(err)).json({ success: false, error: err.message });
  }
});

// The company owner approves or declines a case change to a record that existed
// before the case. Members see the request but cannot decide it.
router.post('/sessions/:id/approvals', async (req, res) => {
  try {
    const { planId, stepNumber, decision } = req.body || {};
    const result = await approvals.decide({ userId: req.user.id, actorId: req.user.actorId || req.user.id,
      sessionId: req.params.id, planId, stepNumber, decision });
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.caseDecision) return res.status(err.status).json({ success: false, error: err.message });
    if (isQboError(err)) return respondQboError(res, err);
    console.error('[ai/sessions/approvals]', err.message);
    return res.status(500).json({ success: false, error: 'The decision could not be completed. Nothing was changed unless the case shows otherwise.' });
  }
});

// The company owner settles case writes whose outcome is unknown, by reading
// QuickBooks only (never re-sending a write), so the case can continue.
// Body: { selections?: [{ planId, stepNumber, recordId | 'none' }] } for creates
// the server could not match on its own.
router.post('/sessions/:id/reconcile', async (req, res) => {
  try {
    const result = await reconciler.reconcile({ userId: req.user.id, actorId: req.user.actorId || req.user.id,
      sessionId: req.params.id, selections: req.body?.selections || [] });
    const session = await AISession.findOne({ _id: req.params.id, userId: req.user.id }).populate('plans');
    return res.json({ success: true, data: { ...result, session: session ? await reproduction.publicState(session) : null } });
  } catch (err) {
    if (err.caseReconcile) return res.status(err.status).json({ success: false, error: err.message });
    if (isQboError(err)) return respondQboError(res, err);
    console.error('[ai/sessions/reconcile]', err.message);
    return res.status(500).json({ success: false, error: 'The case could not be reconciled. Nothing was changed in QuickBooks.' });
  }
});

router.post('/sessions/:id/stop', async (req, res) => {
  try {
    const saved = await AISession.findOne({ _id: req.params.id, userId: req.user.id }).select('userId realmId');
    await assertSavedRead(req, saved);
    const session = await reproduction.stopCase(req.user.id, req.params.id);
    await assertSavedRead(req, session);
    return res.json({ success: true, data: { session: await reproduction.publicState(session) } });
  } catch (err) {
    if (respondSessionAccess(res, err)) return;
    return res.status(safeStatus(err)).json({ success: false, error: err.message });
  }
});



/**
 * GET /config
 * Returns AI feature-flag state so the frontend knows what's available.
 */
router.get('/config', authenticate, async (req, res) => {
  try {
    const aiProvider = require('../modules/ai-provider');
    const User = require('../models/User');
    const user = await User.findById(req.user.actorId || req.user.id).select('+anthropicApiKey');

    const keyConfig = aiProvider.getKeyConfig();
    const hasUserKey = !!(user && user.anthropicApiKey);
    const maskedKey = hasUserKey
      ? '••••' + user.anthropicApiKey.slice(-4)
      : null;

    // Codex CLI = the owner's ChatGPT subscription through the signed-in codex
    // program; no API key needed. ?refresh=true re-checks the sign-in now.
    const codexCli = require('../modules/codex-cli');
    // ?verifyTools=true runs the tool-access check now; otherwise toolAccess is
    // the last check in this process (or null). codex carries version and toolAccess.
    const verified = req.query.verifyTools === 'true' ? await codexCli.verifyToolAccess({ refresh: true }) : null;
    const codex = await codexCli.getStatus({ refresh: req.query.refresh === 'true' || !!verified });
    if (verified) codex.toolAccess = verified;
    const provider = await aiProvider.resolveProvider();
    const anthropicAvailable =
      (keyConfig.userKeysEnabled && hasUserKey) ||
      keyConfig.globalKeySet;

    // Can this user actually use AI right now?
    const available = provider === 'codex'
      ? codex.installed && codex.loggedIn
      : anthropicAvailable;

    return res.json({
      success: true,
      data: {
        ...keyConfig,
        featureFlags: publicFeatureFlags().experimental,
        hasUserKey,
        maskedKey,
        available,
        provider,
        providerSetting: config.ai.provider,
        codex,
      },
    });
  } catch (err) {
    console.error('[ai/config]', err.message);
    return res.status(500).json({ success: false, error: 'AI settings could not be loaded.' });
  }
});

/**
 * POST /chat
 * Send a message in an AI session.
 * Body: { sessionId?, message, mode? }
 */
router.post('/chat', async (req, res) => {
  try {
    const { sessionId, message, mode } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    await assertLegacySessionRead(req, sessionId);
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(400).json({ success: false, error: 'No active QBO connection' });
    }
    const realmId = connection.realmId;

    let result;
    if (mode === 'investigate') {
      result = await orchestrator.investigate(req.user.id, realmId, sessionId, message);
    } else {
      result = await orchestrator.chat(req.user.id, realmId, sessionId, message);
    }

    await createAuditEntry(req.user.id, realmId, 'AI chat message', {
      actionType: 'ai_chat',
      outcome: 'success',
      afterState: { sessionId: result.session?._id, mode: mode || 'suggest' },
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    if (respondSessionAccess(res, err)) return;
    if (err.caseSessionRequired) return res.status(409).json({ success: false, error: err.message, code: 'CASE_ENDPOINT_REQUIRED' });
    console.error('[ai/chat]', err.message);
    if (sendAiProviderError(res, err)) return;
    if (sendQboErrorJson(res, err)) return;
    return res.status(safeStatus(err)).json({ success: false, error: err.message });
  }
});

/**
 * POST /plan/:id/approve
 * Approve a plan (or specific steps).
 * Body: { stepApprovals?: [{ stepNumber, approved }] }
 */
router.post('/plan/:id/approve', requireCompanyWrite, requireSavedPlan, async (req, res) => {
  try {
    const { stepApprovals } = req.body;
    const plan = await orchestrator.approvePlan(req.params.id, req.user.id, stepApprovals);

    const connection = await getActiveConnection(req.user.id);
    if (connection) {
      await createAuditEntry(req.user.id, connection.realmId, 'AI plan approved', {
        actionType: 'ai_plan_approve',
        outcome: 'success',
        afterState: { planId: plan._id, status: plan.status },
      });
    }

    return res.json({ success: true, data: { plan } });
  } catch (err) {
    console.error('[ai/plan/approve]', err.message);
    if (sendAiProviderError(res, err)) return;
    if (sendQboErrorJson(res, err)) return;
    return res.status(safeStatus(err)).json({ success: false, error: err.message });
  }
});

/**
 * POST /plan/:id/reject
 * Reject a plan.
 */
router.post('/plan/:id/reject', requireCompanyWrite, requireSavedPlan, async (req, res) => {
  try {
    const plan = await orchestrator.rejectPlan(req.params.id, req.user.id);

    const connection = await getActiveConnection(req.user.id);
    if (connection) {
      await createAuditEntry(req.user.id, connection.realmId, 'AI plan rejected', {
        actionType: 'ai_plan_reject',
        outcome: 'success',
        afterState: { planId: plan._id, status: plan.status },
      });
    }

    return res.json({ success: true, data: { plan } });
  } catch (err) {
    console.error('[ai/plan/reject]', err.message);
    if (sendAiProviderError(res, err)) return;
    if (sendQboErrorJson(res, err)) return;
    return res.status(safeStatus(err)).json({ success: false, error: err.message });
  }
});

/**
 * POST /plan/:id/execute
 * Execute an approved plan.
 *
 * This is the AI write path into the connected QBO company. In production it is
 * gated by requireProductionConfirm (server-side backstop): the request body
 * must carry `confirmProduction: true` or it returns 412. No-op in sandbox.
 */
router.post(
  '/plan/:id/execute',
  requireFeatureFlag('experimental.aiMutations', { message: 'Legacy AI mutations are disabled by server policy' }),
  requireCompanyWrite,
  requireSavedPlan,
  requireProductionConfirm,
  async (req, res) => {
    try {
    const plan = await orchestrator.executePlan(req.params.id, req.user.id);

    const connection = await getActiveConnection(req.user.id);
    if (connection) {
      await createAuditEntry(req.user.id, connection.realmId, 'AI plan executed', {
        actionType: 'ai_plan_execute',
        outcome: plan.status === 'completed' ? 'success' : 'partial',
        afterState: {
          planId: plan._id,
          status: plan.status,
          stepsCompleted: plan.steps.filter(s => s.status === 'completed').length,
          stepsFailed: plan.steps.filter(s => s.status === 'failed').length,
        },
      });
    }

    return res.json({ success: true, data: { plan } });
    } catch (err) {
    console.error('[ai/plan/execute]', err.message);
    if (sendAiProviderError(res, err)) return;
    if (sendQboErrorJson(res, err)) return;
    return res.status(safeStatus(err)).json({ success: false, error: err.message });
    }
  }
);

/**
 * GET /sessions
 * List user's AI sessions.
 * Query: ?status=active&limit=20&offset=0
 */
router.get('/sessions', async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;

    const scope = await savedAccess.listScope(req.user, req.currentAccount);
    const filter = { ...scope.filter };
    if (status) filter.status = status;

    const sessions = await AISession.find(filter)
      .sort({ updatedAt: -1 })
      .skip(Number(offset))
      .limit(Math.min(Number(limit), 100));

    const total = await AISession.countDocuments(filter);
    await savedAccess.assertListScope(scope, req.user, req.currentAccount);

    return res.json({ success: true, data: { sessions, total, limit: Number(limit), offset: Number(offset) } });
  } catch (err) {
    if (respondSessionAccess(res, err)) return;
    console.error('[ai/sessions]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to list sessions' });
  }
});

/**
 * GET /sessions/:id
 * Get a specific session with messages and plans.
 */
router.get('/sessions/:id', async (req, res) => {
  try {
    const session = await AISession.findOne({
      _id: req.params.id,
      userId: req.user.id,
    }).populate('plans');

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    await assertSavedRead(req, session);
    const scoped = scopedPlans(session);
    const state = await reproduction.publicState(scoped);
    await assertSavedRead(req, session);
    return res.json({ success: true, data: { session: state } });
  } catch (err) {
    if (respondSessionAccess(res, err)) return;
    console.error('[ai/sessions/get]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch session' });
  }
});

// Names change rarely; keep them a few minutes per case and set of referenced records,
// so polling a running case does not repeat the lookups.
const changeNameCache = new Map();
const CHANGE_NAME_TTL_MS = 5 * 60 * 1000;

/**
 * GET /sessions/:id/changes
 * The case's changes to QuickBooks across all its proposals, with customer,
 * vendor, account and document names looked up (read-only) in place of Ids.
 */
router.get('/sessions/:id/changes', async (req, res) => {
  try {
    const session = await AISession.findOne({ _id: req.params.id, userId: req.user.id }).populate('plans');
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    await assertSavedRead(req, session);
    const plans = [...(scopedPlans(session).plans || [])].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const refs = caseChanges.collectRefs(plans);
    // Finished steps are part of the key: a payment that just ran changes the balances shown.
    const finished = plans.flatMap((p) => (p.steps || []).filter((s) => s.status === 'completed').map((s) => `${p._id}.${s.stepNumber}`)).join(',');
    const cacheKey = `${session._id}:${[...refs].map(([type, ids]) => `${type}=${[...ids].sort().join('.')}`).sort().join(';')}:${finished}`;
    let names = changeNameCache.get(cacheKey);
    if (!names || names.expiresAt < Date.now()) {
      let map = new Map();
      let complete = false;
      const connection = await getActiveConnection(req.user.id);
      if (connection && connection.realmId === session.realmId) {
        try {
          map = await caseChanges.loadNames(await createQBOClient(connection), refs);
          complete = map.complete !== false;
        } catch (err) {
          console.error('[ai/sessions/changes] name lookup', err.message);
        }
      }
      // A partial lookup is retried soon; a complete one is kept for a few minutes.
      names = { map, expiresAt: Date.now() + (complete ? CHANGE_NAME_TTL_MS : 20 * 1000) };
      changeNameCache.set(cacheKey, names);
      if (changeNameCache.size > 200) changeNameCache.delete(changeNameCache.keys().next().value);
    }

    const request = (session.messages || []).find((m) => m.role === 'user' && typeof m.content === 'string')?.content || '';
    await assertSavedRead(req, session);
    return res.json({ success: true, data: caseChanges.describeChanges(plans, names.map, { request }) });
  } catch (err) {
    if (respondSessionAccess(res, err)) return;
    console.error('[ai/sessions/changes]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to describe the changes' });
  }
});

/**
 * POST /investigate
 * Start an investigation.
 * Body: { sessionId?, question }
 */
router.post('/investigate', async (req, res) => {
  try {
    const { sessionId, question } = req.body;
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }

    await assertLegacySessionRead(req, sessionId);
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(400).json({ success: false, error: 'No active QBO connection' });
    }
    const realmId = connection.realmId;

    const result = await orchestrator.investigate(req.user.id, realmId, sessionId, question);

    await createAuditEntry(req.user.id, realmId, 'AI investigation', {
      actionType: 'ai_investigate',
      outcome: 'success',
      afterState: { sessionId: result.session?._id, question },
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    if (respondSessionAccess(res, err)) return;
    if (err.caseSessionRequired) return res.status(409).json({ success: false, error: err.message, code: 'CASE_ENDPOINT_REQUIRED' });
    console.error('[ai/investigate]', err.message);
    if (sendAiProviderError(res, err)) return;
    if (sendQboErrorJson(res, err)) return;
    return res.status(safeStatus(err)).json({ success: false, error: err.message });
  }
});

/**
 * POST /generate-note
 * Generate a support note from a session.
 * Body: { sessionId, format: 'escalation'|'internal'|'customer' }
 */
router.post('/generate-note', async (req, res) => {
  try {
    const { sessionId, format } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }
    if (!format || !['escalation', 'internal', 'customer'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be one of: escalation, internal, customer' });
    }

    const session = await AISession.findOne({
      _id: sessionId,
      userId: req.user.id,
    });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    await assertSavedRead(req, session);
    const User = require('../models/User');
    const caseSession = session.reproduction ? await reproduction.publicState(session) : null;
    if (caseSession && req.body.evidence && !aiNotes.matchesCaseNoteEvidence(req.body.evidence, aiNotes.caseNoteEvidence(caseSession))) return res.status(409).json({ success: false, error: 'The saved case evidence changed. Refresh before writing a note.' });
    const user = caseSession ? null : await User.findById(req.user.actorId || req.user.id).select('+anthropicApiKey');
    const note = await aiNotes.generateNote(
      caseSession || { messages: session.messages },
      format,
      { userApiKey: user?.anthropicApiKey || null },
    );

    await assertSavedRead(req, session);
    const connection = caseSession ? null : await getActiveConnection(req.user.id);
    if (caseSession || connection) {
      await createAuditEntry(req.user.id, caseSession?.realmId || connection.realmId, caseSession ? 'Case evidence note generated' : 'AI note generated', {
        actionType: 'ai_generate_note',
        outcome: 'success',
        afterState: { sessionId, format, tokenUsage: note.tokenUsage, ...(caseSession ? { source: note.source, evidence: note.evidence } : {}) },
      });
    }

    const latest = await AISession.findOne({ _id: sessionId, userId: req.user.id });
    await assertSavedRead(req, latest);
    if (caseSession && savedIdentity(await reproduction.publicState(latest)) !== savedIdentity(caseSession)) return res.status(409).json({ success: false, error: 'The saved case evidence changed. Refresh before writing a note.' });
    await assertSavedRead(req, latest);
    return res.json({ success: true, data: { note } });
  } catch (err) {
    if (respondSessionAccess(res, err)) return;
    console.error('[ai/generate-note]', err.message);
    return res.status(safeStatus(err)).json({ success: false, error: err.message });
  }
});

/**
 * POST /stream-ticket
 * Issue a short-lived, single-use ticket for SSE connections.
 * This keeps the long-lived JWT out of query strings / access logs.
 */
router.use(require('./session-streams').createSessionStreamRouter({ streams }));
function emitSSE(sessionId,event,data) { return streams.emit(sessionId,event,data); }

module.exports = { router, emitSSE };
