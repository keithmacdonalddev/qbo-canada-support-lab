'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApprovals } = require('../src/modules/reproduction-approvals');

const OWNER = 'a'.repeat(24);
const MEMBER = 'b'.repeat(24);
const SESSION = 'c'.repeat(24);
const PLAN = 'd'.repeat(24);

// In-memory stand-ins for the models, enough for the queries decide() makes.
function fixture({ syncToken = '3', running = false, lockedUntil = null, steps, active = false, readError = null } = {}) {
  const plan = { _id: PLAN, sessionId: SESSION, userId: OWNER, steps: steps || [
    { stepNumber: 1, toolName: 'createRecord', status: 'completed', toolInput: { entityType: 'Vendor' } },
    { stepNumber: 2, toolName: 'deleteRecord', status: 'pending', toolInput: { entityType: 'Bill', id: '501', summary: 'Delete the duplicate' },
      approval: { state: 'needed', syncToken: '3' } },
  ] };
  const session = { _id: SESSION, userId: OWNER, realmId: 'r1', plans: [PLAN],
    reproduction: { status: running ? 'running' : 'completed', environment: 'production', decisionLockUntil: lockedUntil } };
  const setPaths = (target, fields) => {
    for (const [path, value] of Object.entries(fields)) {
      const keys = path.split('.');
      let node = target;
      for (const k of keys.slice(0, -1)) node = node[k] ||= {};
      node[keys.at(-1)] = value;
    }
  };
  const stepOf = (n) => plan.steps.find((s) => s.stepNumber === n);
  const calls = [];
  const audits = [];
  let failClient = false;
  const deps = {
    AISession: {
      findOneAndUpdate: async () => {
        const lock = session.reproduction.decisionLockUntil;
        if (session.reproduction.status === 'running' || (lock && lock > new Date())) return null;
        session.reproduction.decisionLockUntil = new Date(Date.now() + 60000);
        return session;
      },
      findOne: async () => session,
      updateOne: async (_q, update) => {
        if (update.$unset) session.reproduction.decisionLockUntil = undefined;
        if (update.$set) setPaths(session, update.$set);
        return { matchedCount: 1 };
      },
    },
    AIPlan: {
      findOneAndUpdate: async (q, update) => {
        const match = q.steps.$elemMatch;
        const step = stepOf(match.stepNumber);
        if (q._id !== PLAN || !step || step.approval?.state !== 'needed') return null;
        setPaths(step, Object.fromEntries(Object.entries(update.$set).map(([k, v]) => [k.replace('steps.$.', ''), v])));
        return plan;
      },
      findOne: async (q) => {
        const match = q.steps.$elemMatch;
        const step = stepOf(match.stepNumber);
        const old = step?.approval?.claimedAt;
        return step && step.approval?.state === match['approval.state'] && old && old < match['approval.claimedAt'].$lt ? plan : null;
      },
      updateOne: async (q, update) => {
        const match = q.steps.$elemMatch;
        const step = stepOf(match.stepNumber);
        const claimed = match['approval.claimedAt'];
        if (!step || (claimed && +step.approval?.claimedAt !== +claimed)) return { matchedCount: 0 };
        setPaths(step, Object.fromEntries(Object.entries(update.$set).map(([k, v]) => [k.replace('steps.$.', ''), v])));
        return { matchedCount: 1 };
      },
    },
    Connection: { findOne: async () => ({ _id: 'conn', realmId: 'r1' }) },
    config: { qbo: { environment: 'production' } },
    createQBOClient: async () => {
      if (failClient) throw Object.assign(new Error('invalid_grant'), { status: 400 });
      return {
        read: async () => { calls.push('read'); if (readError) throw readError; return { Bill: { Id: '501', SyncToken: syncToken }, Invoice: { Id: '501', SyncToken: syncToken } }; },
        apiCall: async (method, path, body) => { calls.push([method, path, body]); return { Bill: { Id: '501', status: 'Deleted' } }; },
      };
    },
    isActive: () => active,
    createAuditEntry: async (_u, _r, action) => { audits.push(action); return { id: 'audit' }; },
    handlers: {
      voidTransaction: async (input, { qbo }) => {
        const current = (await qbo.read('invoice', input.id)).Invoice;
        calls.push(['void', current.SyncToken]);
        return { success: true, data: { id: input.id } };
      },
    },
  };
  return { plan, session, stepOf, calls, audits, failClient: () => { failClient = true; }, decide: createApprovals(deps).decide };
}
const ask = (f, extra = {}) => f.decide({ userId: OWNER, actorId: OWNER, sessionId: SESSION, planId: PLAN, stepNumber: 2, decision: 'approve', ...extra });

test('the owner approving runs exactly the saved deletion, once, then unlocks the case', async () => {
  const f = fixture();
  const result = await ask(f);
  assert.equal(result.state, 'approved');
  assert.deepEqual(f.calls, ['read', ['POST', 'bill?operation=delete', { Id: '501', SyncToken: '3' }]]);
  assert.equal(f.stepOf(2).status, 'completed');
  assert.equal(f.stepOf(2).approval.state, 'approved');
  assert.equal(f.stepOf(1).status, 'completed', 'other steps are untouched');
  assert.ok(f.audits.some((a) => /Owner approved/.test(a)) && f.audits.some((a) => /saved/.test(a)));
  assert.equal(f.session.reproduction.decisionLockUntil, undefined);
  await assert.rejects(ask(f), /already been decided/);
  assert.equal(f.calls.length, 2);
});

test('a void runs against the version the owner saw', async () => {
  const f = fixture({ steps: [{ stepNumber: 2, toolName: 'voidTransaction', status: 'pending',
    toolInput: { entityType: 'Invoice', id: '501', summary: 'Void the duplicate' }, approval: { state: 'needed', syncToken: '3' } }] });
  assert.equal((await ask(f)).state, 'approved');
  assert.deepEqual(f.calls, ['read', ['void', '3']]);
});

test('a record changed since it was proposed is left alone', async () => {
  const f = fixture({ syncToken: '4' });
  const result = await ask(f);
  assert.equal(result.state, 'stale');
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.stepOf(2).status, 'failed');
});

test('a failed connection leaves the request waiting', async () => {
  const f = fixture();
  f.failClient();
  await assert.rejects(ask(f), /invalid_grant/);
  assert.equal(f.stepOf(2).approval.state, 'needed');
  assert.equal(f.stepOf(2).status, 'pending');
});

test('members, running or locked cases and edits cannot be approved; declining changes nothing', async () => {
  await assert.rejects(ask(fixture(), { actorId: MEMBER }), (err) => err.status === 403);
  await assert.rejects(ask(fixture(), { actorId: undefined }), (err) => err.status === 403);
  await assert.rejects(ask(fixture({ running: true })), (err) => err.status === 409);
  await assert.rejects(ask(fixture({ lockedUntil: new Date(Date.now() + 60000) })), /in progress/);
  await assert.rejects(ask(fixture(), { decision: 'maybe' }), (err) => err.status === 400);
  const edit = fixture({ steps: [{ stepNumber: 2, toolName: 'updateRecord', status: 'pending',
    toolInput: { entityType: 'Bill', id: '501', changes: { VendorRef: { value: '9' } } }, approval: { state: 'needed', syncToken: '3' } }] });
  await assert.rejects(ask(edit), (err) => err.status === 400);
  assert.deepEqual(edit.calls, []);
  const f = fixture();
  assert.equal((await ask(f, { decision: 'decline' })).state, 'declined');
  assert.deepEqual(f.calls, []);
  assert.equal(f.stepOf(2).status, 'rejected');
});

test('a running case, or a record already gone from QuickBooks, changes nothing', async () => {
  await assert.rejects(ask(fixture({ active: true })), (err) => err.status === 409);
  const gone = fixture({ readError: Object.assign(new Error('QBO API error (HTTP 400): Object Not Found'), { status: 400 }) });
  assert.equal((await ask(gone)).state, 'stale');
  assert.deepEqual(gone.calls, ['read']);
});

test('an abandoned decision is re-offered only if nothing was sent', async () => {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const step = (status) => [{ stepNumber: 2, toolName: 'deleteRecord', status, toolInput: { entityType: 'Bill', id: '501', summary: 'Delete' },
    approval: { state: 'deciding', syncToken: '3', claimedAt: old } }];
  const unsent = fixture({ steps: step('pending') });
  assert.equal((await ask(unsent)).state, 'approved');
  const sent = fixture({ steps: step('executing') });
  await assert.rejects(ask(sent), /may have reached QuickBooks/);
  assert.deepEqual(sent.calls, []);
  assert.equal(sent.stepOf(2).approval.state, 'unknown');
  assert.equal(sent.session.reproduction.outcomeUnknown, true);
});
