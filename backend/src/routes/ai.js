const crypto = require('crypto');
const jwt = require('jsonwebtoken');
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
const { isQboError } = require('../modules/qbo-error');

const router = express.Router();

// Short-lived SSE tickets: ticketId → { userId, sessionId, expiresAt }
const sseTickets = new Map();
const SSE_TICKET_TTL_MS = 30_000; // 30 seconds

// All routes (except SSE stream) require authentication
router.use((req, res, next) => {
  // The SSE stream endpoint handles its own auth via ticket
  if (req.path.startsWith('/stream/')) return next();
  return authenticate(req, res, next);
});

// SSE connections map: sessionId -> Set of res objects
const sseConnections = new Map();

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
 * Helper -- find the user's active QBO Connection.
 */
async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

// --- Routes ---

/**
 * GET /config
 * Returns AI feature-flag state so the frontend knows what's available.
 */
router.get('/config', authenticate, async (req, res) => {
  const aiProvider = require('../modules/ai-provider');
  const User = require('../models/User');
  const user = await User.findById(req.user.id).select('+anthropicApiKey');

  const keyConfig = aiProvider.getKeyConfig();
  const hasUserKey = !!(user && user.anthropicApiKey);
  const maskedKey = hasUserKey
    ? '••••' + user.anthropicApiKey.slice(-4)
    : null;

  // Can this user actually use AI right now?
  const available =
    (keyConfig.userKeysEnabled && hasUserKey) ||
    keyConfig.globalKeySet;

  return res.json({
    success: true,
    data: {
      ...keyConfig,
      featureFlags: publicFeatureFlags().experimental,
      hasUserKey,
      maskedKey,
      available,
    },
  });
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
    console.error('[ai/chat]', err.message);
    if (sendQboErrorJson(res, err)) return;
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

/**
 * POST /plan/:id/approve
 * Approve a plan (or specific steps).
 * Body: { stepApprovals?: [{ stepNumber, approved }] }
 */
router.post('/plan/:id/approve', async (req, res) => {
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
    if (sendQboErrorJson(res, err)) return;
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

/**
 * POST /plan/:id/reject
 * Reject a plan.
 */
router.post('/plan/:id/reject', async (req, res) => {
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
    if (sendQboErrorJson(res, err)) return;
    return res.status(err.status || 500).json({ success: false, error: err.message });
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
    if (sendQboErrorJson(res, err)) return;
    return res.status(err.status || 500).json({ success: false, error: err.message });
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

    const filter = { userId: req.user.id };
    if (status) filter.status = status;

    const sessions = await AISession.find(filter)
      .sort({ updatedAt: -1 })
      .skip(Number(offset))
      .limit(Math.min(Number(limit), 100));

    const total = await AISession.countDocuments(filter);

    return res.json({ success: true, data: { sessions, total, limit: Number(limit), offset: Number(offset) } });
  } catch (err) {
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

    return res.json({ success: true, data: { session } });
  } catch (err) {
    console.error('[ai/sessions/get]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch session' });
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
    console.error('[ai/investigate]', err.message);
    if (sendQboErrorJson(res, err)) return;
    return res.status(err.status || 500).json({ success: false, error: err.message });
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

    const note = await aiNotes.generateNote(
      { messages: session.messages },
      format
    );

    const connection = await getActiveConnection(req.user.id);
    if (connection) {
      await createAuditEntry(req.user.id, connection.realmId, 'AI note generated', {
        actionType: 'ai_generate_note',
        outcome: 'success',
        afterState: { sessionId, format, tokenUsage: note.tokenUsage },
      });
    }

    return res.json({ success: true, data: { note } });
  } catch (err) {
    console.error('[ai/generate-note]', err.message);
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

/**
 * POST /stream-ticket
 * Issue a short-lived, single-use ticket for SSE connections.
 * This keeps the long-lived JWT out of query strings / access logs.
 */
router.post('/stream-ticket', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    // Verify session ownership
    const session = await AISession.findOne({ _id: sessionId, userId: req.user.id });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const ticketId = crypto.randomBytes(32).toString('hex');
    sseTickets.set(ticketId, {
      userId: req.user.id,
      sessionId,
      expiresAt: Date.now() + SSE_TICKET_TTL_MS,
    });

    // Garbage-collect expired tickets while we're here
    for (const [id, t] of sseTickets) {
      if (t.expiresAt < Date.now()) sseTickets.delete(id);
    }

    return res.json({ success: true, data: { ticket: ticketId } });
  } catch (err) {
    console.error('[ai/stream-ticket]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create SSE ticket' });
  }
});

/**
 * GET /stream/:sessionId
 * SSE streaming endpoint for real-time AI session updates.
 * Authenticates via a short-lived ticket (not the raw JWT).
 */
router.get('/stream/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { ticket } = req.query;

  // Validate ticket
  if (!ticket) {
    return res.status(401).json({ success: false, error: 'Missing SSE ticket' });
  }
  const ticketData = sseTickets.get(ticket);
  if (!ticketData) {
    return res.status(401).json({ success: false, error: 'Invalid or expired SSE ticket' });
  }
  // Consume ticket (single-use)
  sseTickets.delete(ticket);

  if (ticketData.expiresAt < Date.now()) {
    return res.status(401).json({ success: false, error: 'SSE ticket expired' });
  }
  if (ticketData.sessionId !== sessionId) {
    return res.status(403).json({ success: false, error: 'Ticket does not match session' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ sessionId })}\n\n`);

  // Store connection
  if (!sseConnections.has(sessionId)) {
    sseConnections.set(sessionId, new Set());
  }
  sseConnections.get(sessionId).add(res);

  // Clean up on disconnect
  req.on('close', () => {
    const conns = sseConnections.get(sessionId);
    if (conns) {
      conns.delete(res);
      if (conns.size === 0) sseConnections.delete(sessionId);
    }
  });
});

/**
 * Helper to emit SSE events to all connected clients for a session.
 * @param {string} sessionId
 * @param {string} event - Event name
 * @param {*} data - JSON-serializable data
 */
function emitSSE(sessionId, event, data) {
  const conns = sseConnections.get(sessionId);
  if (!conns) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of conns) {
    res.write(msg);
  }
}

module.exports = { router, emitSSE };
