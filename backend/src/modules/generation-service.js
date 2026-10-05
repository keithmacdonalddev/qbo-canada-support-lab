const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const GenerationRun = require('../models/GenerationRun');
const GenerationScope = require('../models/GenerationScope');
const config = require('../config');
const { runGenerationJob } = require('./generation-engine');
const { LEASE_MS, generationView } = require('./generation-state');

function problem(message, status = 409) { return Object.assign(new Error(message), { status }); }
function validateConfig(body = {}, now = new Date()) {
  const { monthsBack = 6, txnsPerMonth = 30 } = body;
  if (!Number.isInteger(monthsBack) || monthsBack < 1 || monthsBack > 12 ||
      !Number.isInteger(txnsPerMonth) || txnsPerMonth < 1 || txnsPerMonth > 60) {
    throw problem('Choose 1–12 months and 1–60 transaction chains per month.', 400);
  }
  return { monthsBack, txnsPerMonth, arWeight: 0.6, apWeight: 0.4, anchorDate: now.toISOString().slice(0, 10) };
}

function createGenerationService(dependencies = {}) {
  const Runs = dependencies.Runs || GenerationRun;
  const Scopes = dependencies.Scopes || GenerationScope;
  const execute = dependencies.execute || runGenerationJob;
  const now = dependencies.now || (() => Date.now());
  const environment = dependencies.environment || config.qbo.environment;
  const newId = dependencies.newId || (() => new mongoose.Types.ObjectId());
  const scopeId = connection => environment + ':' + connection.realmId;
  const runFilter = connection => ({ realmId: connection.realmId, $or: [{ environment }, { environment: { $exists: false } }] });

  async function current(connection, userId) {
    const scope = await Scopes.findById(scopeId(connection)).lean();
    if (scope && String(scope.userId) !== String(userId)) throw problem('This company has a generation run owned by another account.');
    return scope ? await Runs.findById(scope.runId).lean()
      : await Runs.findOne({ ...runFilter(connection), userId }).sort({ createdAt: -1 }).lean();
  }

  async function start(connection, userId, body = {}) {
    const plannedConfig = validateConfig(body, new Date(now()));
    for (const key of ['previousRunId', 'resumeRunId']) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || !/^[a-f0-9]{24}$/i.test(body[key]))) throw problem('Invalid generation run reference.', 400);
    }
    if (body.previousRunId && body.resumeRunId) throw problem('Choose either resume or an additional batch.', 400);
    let scope = await Scopes.findById(scopeId(connection)).lean();
    if (!scope) {
      // Preserve legacy evidence; never start fresh over an unfinished old run.
      const history = await Runs.find(runFilter(connection)).sort({ createdAt: -1 }).lean();
      const prior = history.find(r => !generationView(r, now()).success) || history[0];
      const reservation = { _id: scopeId(connection), userId: prior?.userId || userId,
        realmId: connection.realmId, environment, connectionId: connection._id,
        runId: prior?._id || newId(), config: prior?.config || plannedConfig };
      try {
        scope = await Scopes.findOneAndUpdate({ _id: reservation._id }, { $setOnInsert: reservation }, { upsert: true, new: true }).lean();
      } catch (error) {
        if (error.code !== 11000) throw error;
        scope = await Scopes.findById(reservation._id).lean();
      }
    }
    if (String(scope.userId) !== String(userId)) throw problem('This company has a generation run owned by another account.');
    if (body.resumeRunId && String(scope.runId) !== body.resumeRunId) throw problem('The current generation run changed. Refresh before continuing.');
    if (body.previousRunId && String(scope.runId) === body.previousRunId) {
      const previous = await Runs.findById(scope.runId).lean();
      if (!previous || !generationView(previous, now()).success) throw problem('Finish or inspect the current run before adding another batch.');
      const history = await Runs.find(runFilter(connection)).lean();
      if (history.some(r => !generationView(r, now()).success)) throw problem('An earlier run still needs inspection before more history can be created.');
      const next = await Scopes.findOneAndUpdate({ _id: scope._id, runId: scope.runId }, { $set: {
        runId: newId(), previousRunId: scope.runId, config: plannedConfig, connectionId: connection._id,
      } }, { new: true }).lean();
      scope = next || await Scopes.findById(scope._id).lean();
    }
    if (body.previousRunId && String(scope.previousRunId) !== body.previousRunId) throw problem('The current generation run changed. Refresh before adding more history.');
    if (String(scope.connectionId) !== String(connection._id)) throw problem('The saved plan belongs to an earlier connection. Inspect it before continuing.');
    let run = await Runs.findOneAndUpdate({ _id: scope.runId }, { $setOnInsert: {
      _id: scope.runId, userId, realmId: connection.realmId, environment,
      connectionId: connection._id, previousRunId: scope.previousRunId,
      executionVersion: 1, status: 'pending', config: scope.config,
      progress: { phase: 'starting', detail: 'Preparing saved generation plan' },
    } }, { upsert: true, new: true }).lean();
    if (run.executionVersion !== 1) return generationView(run, now());
    if (run.environment !== environment || String(run.connectionId) !== String(connection._id) || String(run.userId) !== String(userId)) throw problem('Generation scope does not match the active connection.');
    const view = generationView(run, now());
    if (view.success || !view.canResume) return view;
    if (run.startedAt && !body.resumeRunId && !body.previousRunId) return view;
    const token = randomUUID();
    // Both barriers are atomic: an expired owner cannot dispatch after takeover,
    // and an unresolved in-flight write prevents takeover regardless of its age.
    const claimed = await Runs.findOneAndUpdate({
      _id: run._id, executionVersion: 1, status: { $ne: 'completed' },
      $or: [{ leaseToken: null }, { leaseExpiresAt: { $lte: new Date(now()) } }],
      steps: { $not: { $elemMatch: { state: { $in: ['sending', 'uncertain'] } } } },
    }, { $set: { leaseToken: token, leaseExpiresAt: new Date(now() + LEASE_MS), status: 'in_progress',
      startedAt: run.startedAt || new Date(now()), completedAt: null, lastError: null } }, { new: true }).lean();
    if (!claimed) return generationView(await Runs.findById(run._id).lean(), now());
    // Invocation is detached only after the reservation and execution claim persist.
    Promise.resolve().then(() => execute(claimed, connection)).catch(() => {
      console.error('[generate/background] Run interrupted; saved progress retained.');
    });
    return generationView(claimed, now());
  }

  return { start, current, runFilter };
}

module.exports = { createGenerationService, validateConfig };
