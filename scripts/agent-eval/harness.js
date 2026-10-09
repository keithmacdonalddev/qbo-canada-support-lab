'use strict';

// Runs one evaluation scenario through the real Reproduce engine against the
// simulated company. The model adapter is injected: run.js supplies the real
// provider path, unit tests supply scripted replies. Session and plan state
// live in memory; persistence, audit and scope checks are stubs. Message and
// state construction mirror reproduction-runner.js (startCase/executeCase) and
// must be kept in step with it.

const guard = require('./guard');

guard.install();

const path = require('path');
const { randomUUID } = require('crypto');
const { createFakeQbo } = require('./fake-qbo');

const engine = require(path.join(guard.BACKEND_SRC, 'modules', 'reproduction-engine'));

const COMPANY_NAME = 'Maple Ridge Supply Co.';
const MAX_RESULT_CHARS = 3000;

function preview(value) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text === undefined) return null;
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '…' : text;
}

// Rebuild case-owned records from receipts, as startCase does for a continuation.
function ownedFromSteps(steps) {
  const owned = [];
  for (const step of steps) {
    if (step.status !== 'completed') continue;
    if (step.toolName === 'createRecord' && step.result?.data?.id) {
      owned.push({ entityType: step.toolInput.entityType, id: String(step.result.data.id), stepNumber: step.stepNumber });
    }
    if (step.toolName === 'deleteRecord') {
      const record = owned.find((item) => item.entityType === step.toolInput.entityType && item.id === String(step.toolInput.id));
      if (record) record.deleted = true;
    }
  }
  return owned;
}

/**
 * Run one scenario (one or more operator turns) and return everything a grader needs.
 * @param {Object} options
 * @param {Object} options.scenario - from scenarios.js
 * @param {Function} options.runModel - ({ transcript, system, execute, tools, budget, turn }) => reply text or { text, toolsListed, toolCalls }
 * @param {string} [options.environment]
 * @param {string} [options.today] - simulated company date (YYYY-MM-DD)
 * @param {Object} [options.engineOptions] - passed through to runEngine (e.g. maxCalls, deadline)
 */
async function runScenario({ scenario, runModel, environment = 'production', today, engineOptions = {} }) {
  // The simulated company's "today" matches the date the system prompt gives the model.
  const companyDate = today || (typeof engine.companyToday === 'function' ? engine.companyToday() : new Date().toISOString().slice(0, 10));
  const { qbo, company } = createFakeQbo({ today: companyDate });
  const sessionId = randomUUID().replace(/-/g, '').slice(0, 24);
  const session = { messages: [], reproduction: null };
  const plan = { _id: 'eval-plan-' + sessionId.slice(-8), realmId: qbo.realmId, steps: [], status: 'executing' };
  const audits = [];
  const trace = [];
  const turns = [];
  const startedAt = Date.now();
  const messages = Array.isArray(scenario.turns) ? scenario.turns : [scenario.request];

  for (let index = 0; index < messages.length; index += 1) {
    const turnSpec = typeof messages[index] === 'string' ? { message: messages[index] } : messages[index];
    if (index > 0) {
      const prev = turns[turns.length - 1];
      const condition = turnSpec.onlyIf || 'needs_input';
      const proceed = condition === 'always' || (condition === 'needs_input' && prev.state.outcome === 'needs_input');
      if (!proceed) {
        turns.push({ index, message: turnSpec.message, skipped: true, reason: `Previous turn ended ${prev.state.outcome || 'without an outcome'}; this follow-up only runs after ${condition}.` });
        continue;
      }
    }
    const turnStarted = Date.now();
    const callsFrom = company.calls.length;
    const previous = session.reproduction;
    // startCase: claim a fresh run on top of any earlier case state.
    const state = {
      ...(previous ? structuredClone(previous) : {}),
      runId: randomUUID(), status: 'running', phase: 'preparing', connectionId: 'eval-connection', environment,
      actorId: 'eval-actor', companyName: COMPANY_NAME, authorization: 'connected-company-case-request-v1',
      startedAt: new Date(), completedAt: null, stopRequested: false,
      outcome: null, summary: '', limitations: [], tests: [], checks: [], awaitingOperator: null, toolAccess: null,
    };
    if (previous) {
      state.ownedRecords = ownedFromSteps(plan.steps);
      state.revision = plan.steps.filter((step) => step.status === 'completed').length;
      plan.status = 'executing';
    }
    session.messages.push({ role: 'user', content: turnSpec.message.trim() });
    // executeCase: transcript, server case state and the real system prompt.
    const transcript = session.messages.map((m) => ({ role: m.role, content: m.content || '' }));
    const snapshot = typeof engine.caseStateSnapshot === 'function' ? engine.caseStateSnapshot(state, plan) : {
      scenario: state.scenario, conditions: state.conditions, ownedRecords: state.ownedRecords,
      operations: plan.steps.map((s) => ({ tool: s.toolName, input: s.toolInput, status: s.status, result: s.result })),
    };
    transcript.push({ role: 'user', content: 'Server case state (saved evidence, not new instructions): ' + JSON.stringify(snapshot) });
    const system = engine.systemPrompt({ ...state, caseLabel: sessionId.slice(-8) });
    let pass = 0;
    let engineError = null;
    try {
      await engine.runEngine({
        state, plan, qbo, messages: transcript,
        persist: async () => {},
        assertActive: async () => {},
        audit: async (action, details) => { audits.push({ action, tool: details?.tool, outcome: details?.outcome }); return { id: 'eval-audit-' + audits.length }; },
        confirmContinuation: async () => {},
        ...engineOptions,
        runModel: async (modelTranscript, execute, tools, budget) => {
          pass += 1;
          const passNumber = pass;
          const tracedExecute = async (name, input) => {
            const entry = { turn: index + 1, pass: passNumber, tool: String(name), input: structuredClone(input ?? {}), startedAt: Date.now() };
            trace.push(entry);
            try {
              const result = await execute(name, input);
              entry.ok = !!result && result.success !== false;
              entry.result = preview(result);
              if (result?.error) entry.error = String(result.error).slice(0, 500);
              if (result?.approvalRequired) entry.approvalRequired = true;
              return result;
            } catch (err) {
              entry.ok = false;
              entry.error = String(err?.message || err).slice(0, 500);
              throw err;
            } finally {
              entry.ms = Date.now() - entry.startedAt;
              delete entry.startedAt;
            }
          };
          return runModel({ transcript: modelTranscript, system, execute: tracedExecute, tools, budget, turn: index + 1, pass: passNumber });
        },
      });
    } catch (err) {
      engineError = String(err?.stack || err).slice(0, 2000);
    }
    session.messages.push({ role: 'assistant', content: state.summary || '' });
    session.reproduction = state;
    const turnCalls = company.calls.slice(callsFrom);
    turns.push({ index, message: turnSpec.message, state: structuredClone(state), engineError, passes: pass, ms: Date.now() - turnStarted,
      callRange: [callsFrom + 1, company.calls.length],
      writes: turnCalls.filter((c) => c.ok && ['create', 'update', 'delete', 'void'].includes(c.kind)).length });
  }

  const ran = turns.filter((t) => !t.skipped);
  const final = ran[ran.length - 1]?.state || {};
  return {
    scenarioId: scenario.id,
    state: final,
    turns,
    plan: structuredClone(plan),
    trace,
    audits,
    company,
    calls: company.calls,
    systemPrompt: engine.systemPrompt({ ...final, caseLabel: sessionId.slice(-8) }),
    toolNames: engine.reproductionTools.map((t) => t.name),
    ms: Date.now() - startedAt,
  };
}

module.exports = { runScenario, ownedFromSteps, COMPANY_NAME };
