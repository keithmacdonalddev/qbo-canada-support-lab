'use strict';

// Who is actually acting during a request, when that differs from the account
// whose company data the request works on (see middleware/companyScope.js).
// Audit entries read it so a shared company's history names the real actor.

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runAsActor(actorId, fn) {
  return storage.run({ actorId: String(actorId) }, fn);
}

function currentActorId() {
  return storage.getStore()?.actorId || null;
}

// Wrap fn so it later runs as the actor current now, for work that resumes
// from another request (e.g. Codex tool calls arriving on the MCP endpoint).
function bindActor(fn) {
  const actorId = currentActorId();
  return actorId ? (...args) => runAsActor(actorId, () => fn(...args)) : fn;
}

module.exports = { runAsActor, currentActorId, bindActor };
