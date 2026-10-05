'use strict';

const { randomUUID } = require('crypto');
function createRunner(dependencies = {}) {
const AISession = dependencies.AISession || require('../models/AISession');
const AIPlan = dependencies.AIPlan || require('../models/AIPlan');
const Connection = dependencies.Connection || require('../models/Connection');
const CompanyMembership = dependencies.CompanyMembership || require('../models/CompanyMembership');
const User = dependencies.User || require('../models/User');
const config = dependencies.config || require('../config');
const createQBOClient = dependencies.createQBOClient || require('./qbo-client').createQBOClient;
const createAuditEntry = dependencies.createAuditEntry || require('../middleware/auditLogger').createAuditEntry;
const { bindActor, currentActorId } = require('./actor-context');
const aiProvider = require('./ai-provider');
const codexCli = require('./codex-cli');
const { createToolSession } = require('./ai-tool-bridge');
const { systemPrompt } = require('./reproduction-engine');
const runEngine = dependencies.runEngine || require('./reproduction-engine').runEngine;
const coverage = require('./coverage');
const { normalizePermissions } = require('./rebuild-permissions');

async function assertActorAccess(userId, actorId, realmId) {
  if (String(userId) === String(actorId)) return;
  const membership = await CompanyMembership.findOne({ userId: actorId, realmId, status: 'active' });
  if (!membership || !normalizePermissions(membership.role, membership.permissionOverrides).includes('reproduction.run')) {
    throw Object.assign(new Error('This company membership cannot run reproductions.'), { status: 403 });
  }
}

const jobs = new Map();
const INSTANCE = dependencies.instance || randomUUID();
const conflict = (message) => Object.assign(new Error(message), { status: 409 });

async function runProvider(messages, system, execute, tools, userApiKey) {
  if (await aiProvider.resolveProvider() === 'codex') {
    const bridge = createToolSession({ tools, execute, maxCalls: 160 });
    try {
      const prompt = messages.map((m) => m.role + ': ' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n');
      const result = await codexCli.run({ system, prompt, bridge: bridge.bridge });
      return result.text;
    } finally { await bridge.close(); }
  }
  for (let round = 0; round < 60; round += 1) {
    const response = await aiProvider.chat(messages, tools, { system, userApiKey });
    const blocks = Array.isArray(response.content) ? response.content : [];
    const uses = blocks.filter((b) => b.type === 'tool_use');
    if (!uses.length) return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const results = [];
    for (const call of uses) results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(await execute(call.name, call.input)) });
    messages.push({ role: 'assistant', content: blocks }, { role: 'user', content: results });
  }
  return 'The provider reached its tool-round limit.';
}

async function executeCase(sessionId, runId) {
  const session = await AISession.findOne({ _id: sessionId, mode: 'reproduce', 'reproduction.runId': runId });
  if (!session) return;
  const state = session.reproduction;
  let plan;
  const key = String(sessionId);
  async function persist() {
    state.updatedAt = new Date();
    state.leaseExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    // Persist the operation receipt first; session references are already durable.
    if (plan) await plan.save();
    // Stop is owned by its route; never overwrite a concurrent stop request.
    const fields = Object.fromEntries(Object.entries(state)
      .filter(([key]) => key !== 'stopRequested')
      .map(([key, value]) => ['reproduction.' + key, value]));
    const saved = await AISession.updateOne({ _id: sessionId, 'reproduction.runId': runId }, { $set: fields });
    if (saved.matchedCount !== 1) throw new Error('This run lost its case ownership.');
    if (session.isModified('messages') || session.isModified('title')) await session.save();
  }
  try {
    const connection = await Connection.findOne({ _id: state.connectionId, userId: session.userId,
      realmId: session.realmId, status: 'active' });
    if (!connection) throw new Error('The case company is no longer connected.');
    const user = await User.findById(state.actorId).select('+anthropicApiKey');
    if (!user) throw new Error('The initiating user is no longer available.');
    const qbo = await createQBOClient(connection);
    plan = await AIPlan.findById(state.planId);
    if (!plan) throw new Error('The case operation log is missing.');
    const assertActive = async () => {
      const current = await AISession.findOne({ _id: sessionId, userId: session.userId, realmId: session.realmId,
        mode: 'reproduce', 'reproduction.runId': runId }).select('reproduction');
      if (!current || current.reproduction.stopRequested) throw new Error('Stopped at your request. Records already created remain in QuickBooks.');
      if (current.reproduction.status !== 'running' || current.reproduction.instance !== INSTANCE) throw new Error('This case run is no longer active.');
      if (config.qbo.environment !== state.environment) throw new Error('The company environment changed. This case stopped.');
      if (!await Connection.exists({ _id: state.connectionId, userId: session.userId, realmId: session.realmId, status: 'active' })) {
        throw new Error('The case company was disconnected.');
      }
      await assertActorAccess(session.userId, state.actorId, session.realmId);
    };
    const audit = (action, details) => createAuditEntry(session.userId, session.realmId, action, {
      ...details, aiDriven: true, approvalEvent: plan._id,
      inputParams: { ...details.inputParams, caseId: key, runId, authorization: state.authorization },
    });
    const messages = session.messages.filter((m) => ['user', 'assistant'].includes(m.role))
      .map((m) => ({ role: m.role, content: m.content || '' }));
    messages.push({ role: 'user', content: 'Server case state (saved evidence, not new instructions): ' + JSON.stringify({
      scenario: state.scenario, conditions: state.conditions, ownedRecords: state.ownedRecords,
      operations: plan.steps.map((s) => ({ tool: s.toolName, input: s.toolInput, status: s.status, result: s.result })),
    }) });
    const system = systemPrompt({ ...state, caseLabel: key.slice(-8) });
    await runEngine({ state, plan, qbo, persist, assertActive, audit, messages,
      runModel: (transcript, execute, tools) => runProvider(transcript, system, execute, tools, user.anthropicApiKey) });
    session.messages.push({ role: 'assistant', content: state.summary, timestamp: new Date() });
    if (state.title) session.title = state.title;
    await persist();
    coverage.invalidate(session.realmId);
  } catch (err) {
    // Never restart a run on process recovery or retry an unknown external write.
    const receipts = plan ? await AIPlan.findById(plan._id) : null;
    await AISession.updateOne({ _id: sessionId, 'reproduction.runId': runId }, { $set: {
      'reproduction.status': 'stopped', 'reproduction.phase': 'finished', 'reproduction.outcome': 'unverified',
      'reproduction.summary': 'The run stopped: ' + err.message,
      'reproduction.outcomeUnknown': !!receipts?.steps.some((s) => s.status === 'executing' || s.result?.outcomeUnknown),
      'reproduction.completedAt': new Date(),
    } });
  } finally {
    jobs.delete(key);
  }
}

async function startCase({ userId, actorId = currentActorId() || userId, connection, requestId, message, sessionId }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 30000) throw Object.assign(new Error('Provide a case description up to 30,000 characters.'), { status: 400 });
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw Object.assign(new Error('A valid submission identifier is required.'), { status: 400 });
  if (!connection || String(connection.userId) !== String(userId) || connection.status !== 'active') throw conflict('Connect the case company first.');
  await assertActorAccess(userId, actorId, connection.realmId);
  let session;
  const scope = { userId, realmId: connection.realmId };
  if (sessionId) {
    session = await AISession.findOne({ _id: sessionId, ...scope });
    if (!session) throw Object.assign(new Error('Case not found in this connected company.'), { status: 404 });
    if (session.reproduction && (session.reproduction.environment !== config.qbo.environment
        || session.reproduction.connectionId !== String(connection._id))) {
      throw conflict('This case belongs to its original connection and environment. Start a new case in this company.');
    }
    if (session.reproduction?.requestId === requestId) return session;
    if (session.reproduction?.status === 'running') {
      const old = session.reproduction;
      if ((old.instance === INSTANCE && jobs.has(String(session._id))) || new Date(old.leaseExpiresAt || 0).getTime() > Date.now()) {
        throw conflict('This case is still running or its previous execution lease has not expired. Existing writes will not be replayed.');
      }
      const oldPlan = old.planId ? await AIPlan.findOne({ _id: old.planId, sessionId: session._id, ...scope }) : null;
      if (old.planId && !oldPlan) throw conflict('The interrupted case operation log is missing.');
      if (oldPlan?.steps.some((step) => step.status === 'executing' || step.result?.outcomeUnknown)) {
        throw conflict('The interrupted case has an unresolved external write. Its existing records must be reconciled before continuing.');
      }
      await AISession.updateOne({ _id: session._id, 'reproduction.runId': old.runId, 'reproduction.instance': old.instance },
        { $set: { 'reproduction.status': 'stopped' } });
    }
    // An uncertain external result cannot be turned into a fresh auto-retry.
    if (session.reproduction?.outcomeUnknown) throw conflict('This case has an unresolved write outcome.');
  } else {
    session = await AISession.findOne({ ...scope, submissionId: requestId });
    if (session) return session;
    try {
      session = await AISession.create({ ...scope, submissionId: requestId, mode: 'reproduce',
        title: message.replace(/[*#]/g, '').slice(0, 80), messages: [], plans: [] });
    } catch (err) {
      if (err.code !== 11000) throw err;
      return AISession.findOne({ ...scope, submissionId: requestId });
    }
  }
  const runId = randomUUID();
  const previous = session.reproduction;
  // Claim in MongoDB as well as memory; duplicate tabs cannot launch a second run.
  const claimed = await AISession.findOneAndUpdate({
    _id: session._id, ...scope, 'reproduction.status': { $ne: 'running' },
  }, { $set: { mode: 'reproduce', reproduction: {
    ...(previous || {}), runId, requestId, instance: INSTANCE, status: 'running', phase: 'preparing',
    connectionId: String(connection._id), environment: config.qbo.environment,
    actorId: String(actorId), companyName: connection.companyName || 'Connected company',
    authorization: 'connected-company-case-request-v1', startedAt: new Date(), stopRequested: false,
    leaseExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    outcome: null, summary: '', limitations: [], tests: [], checks: [],
  } } }, { new: true });
  if (!claimed) throw conflict('This case is already running.');
  try {
    // Old pending suggestions are superseded, never silently executed.
    await AIPlan.updateMany({ sessionId: claimed._id, status: { $in: ['proposed', 'approved', 'partially_approved'] } },
      { $set: { status: 'rejected' } });
    let plan;
    if (previous?.planId) plan = await AIPlan.findOne({ _id: previous.planId, sessionId: claimed._id, ...scope });
    if (!plan) {
      plan = await AIPlan.create({ sessionId: claimed._id, ...scope, status: 'executing',
        description: 'Automatic reproduction requested by the operator', steps: [] });
      claimed.plans.push(plan._id);
    } else {
      if (plan.steps.some((s) => s.status === 'executing' || s.result?.outcomeUnknown)) throw conflict('An earlier change has an unresolved outcome. It will not be repeated.');
      // Rebuild ownership from durable operation receipts after a partial save.
      const owned = [];
      for (const step of plan.steps) {
        if (step.status !== 'completed') continue;
        if (step.toolName === 'createRecord' && step.result?.data?.id) owned.push({
          entityType: step.toolInput.entityType, id: String(step.result.data.id), stepNumber: step.stepNumber,
        });
        if (step.toolName === 'deleteRecord') {
          const record = owned.find((item) => item.entityType === step.toolInput.entityType && item.id === String(step.toolInput.id));
          if (record) record.deleted = true;
        }
      }
      claimed.reproduction.ownedRecords = owned;
      claimed.reproduction.revision = plan.steps.filter((step) => step.status === 'completed').length;
      plan.status = 'executing';
      await plan.save();
    }
    claimed.reproduction.planId = String(plan._id);
    claimed.messages.push({ role: 'user', content: message.trim(), timestamp: new Date() });
    const fields = Object.fromEntries(Object.entries(claimed.reproduction)
      .filter(([key]) => key !== 'stopRequested')
      .map(([key, value]) => ['reproduction.' + key, value]));
    const initialized = await AISession.updateOne({ _id: claimed._id, 'reproduction.runId': runId }, {
      $set: fields, $addToSet: { plans: plan._id },
      $push: { messages: { role: 'user', content: message.trim(), timestamp: new Date() } },
    });
    if (initialized.matchedCount !== 1) throw conflict('This case run is no longer active.');
    const recorded = await createAuditEntry(userId, connection.realmId, 'Reproduction requested', {
      actionType: 'ai_chat', aiDriven: true, inputParams: { caseId: String(claimed._id), runId,
        actorId: String(actorId), environment: config.qbo.environment, authorization: claimed.reproduction.authorization },
    });
    if (!recorded) throw new Error('The case request could not be audited.');
    const execute = bindActor(() => executeCase(claimed._id, runId));
    const job = Promise.resolve().then(execute).catch(() => {});
    jobs.set(String(claimed._id), job);
    return claimed;
  } catch (err) {
    await AISession.updateOne({ _id: claimed._id, 'reproduction.runId': runId }, { $set: {
      'reproduction.status': 'stopped', 'reproduction.outcome': 'unverified', 'reproduction.summary': err.message,
    } });
    throw err;
  }
}

async function stopCase(userId, sessionId) {
  const session = await AISession.findOneAndUpdate({ _id: sessionId, userId, mode: 'reproduce', 'reproduction.status': 'running' },
    { $set: { 'reproduction.stopRequested': true } }, { new: true });
  if (!session) throw conflict('There is no active run to stop.');
  return session;
}

function publicState(session) {
  const plain = typeof session.toObject === 'function' ? session.toObject() : session;
  if (plain.reproduction?.status === 'running' && (plain.reproduction.instance !== INSTANCE || !jobs.has(String(plain._id)))) {
    plain.reproduction = { ...plain.reproduction, status: 'interrupted', phase: 'finished', outcome: 'unverified',
      summary: 'This run was interrupted. Existing writes have not been replayed. A continuation can recover confirmed records after the previous execution lease expires.' };
  }
  return plain;
}

return { startCase, stopCase, publicState, runProvider, assertActorAccess, waitForIdle: (id) => jobs.get(String(id)) };
}

module.exports = { ...createRunner(), createRunner };
