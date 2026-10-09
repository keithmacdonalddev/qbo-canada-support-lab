'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReconciler, _internal } = require('../src/modules/reproduction-reconcile');

const OWNER = 'a'.repeat(24);
const MEMBER = 'b'.repeat(24);
const SESSION = 'c'.repeat(24);
const PLAN = 'd'.repeat(24);
const CONNECTION = 'e'.repeat(24);
const NOW = Date.parse('2026-10-08T15:00:00Z');
// A subdocument id saved a minute before NOW, as MongoDB would assign it.
const STEP_ID = Math.floor((NOW - 60000) / 1000).toString(16).padStart(8, '0') + '0'.repeat(16);
const iso = (ms) => new Date(ms).toISOString();

const setPath = (target, path, value) => {
  const keys = path.split('.');
  let node = target;
  for (const k of keys.slice(0, -1)) node = node[k] ||= {};
  node[keys.at(-1)] = value;
};

// In-memory stand-ins for the models and QuickBooks, enough for reconcile().
function fixture({ steps, records = {}, queryRows = [], running = false, active = false, auditOk = true, outcomeUnknown = true } = {}) {
  const plan = { _id: PLAN, sessionId: SESSION, userId: OWNER, steps };
  const session = { _id: SESSION, userId: OWNER, realmId: 'r1', plans: [PLAN],
    reproduction: { status: running ? 'running' : 'stopped', environment: 'production', connectionId: CONNECTION,
      planId: PLAN, outcomeUnknown, startedAt: new Date(NOW - 120000), ownedRecords: [] } };
  const writes = [];
  const queries = [];
  const audits = [];
  const qbo = {
    async read(entity, id) {
      const record = records[entity + ':' + id];
      if (!record) throw Object.assign(new Error('QBO API error (HTTP 400): Object Not Found'), { status: 400 });
      return { [record.__type]: record };
    },
    async query(sql) { queries.push(sql); return { QueryResponse: { [sql.split(' ')[3]]: queryRows } }; },
    async create() { writes.push('create'); throw new Error('no writes'); },
    async update() { writes.push('update'); throw new Error('no writes'); },
    async apiCall(method) { writes.push(method); throw new Error('no writes'); },
  };
  const deps = {
    AISession: {
      findOneAndUpdate: async () => {
        const lock = session.reproduction.decisionLockUntil;
        if (session.reproduction.status === 'running' || (lock && lock > new Date(NOW))) return null;
        session.reproduction.decisionLockUntil = new Date(NOW + 60000);
        return session;
      },
      findOne: async () => session,
      updateOne: async (_q, update) => {
        if (update.$unset) session.reproduction.decisionLockUntil = undefined;
        for (const [path, value] of Object.entries(update.$set || {})) setPath(session, path, value);
        return { matchedCount: 1 };
      },
    },
    AIPlan: {
      find: async () => [plan],
      updateOne: async (q, update) => {
        const match = q.steps.$elemMatch;
        const step = plan.steps.find((s) => s.stepNumber === match.stepNumber && s.status === match.status);
        if (q._id !== PLAN || !step) return { matchedCount: 0 };
        for (const [path, value] of Object.entries(update.$set)) setPath(step, path.replace('steps.$.', ''), value);
        return { matchedCount: 1 };
      },
    },
    Connection: { findOne: async (q) => (q._id === CONNECTION ? { _id: CONNECTION, realmId: 'r1' } : null) },
    config: { qbo: { environment: 'production' } },
    createQBOClient: async () => qbo,
    createAuditEntry: async (...args) => { audits.push(args); return auditOk ? { _id: 'audit' } : null; },
    isActive: () => active,
    now: () => NOW,
  };
  return { plan, session, writes, queries, audits, reconciler: createReconciler(deps) };
}

const invoiceStep = (overrides = {}) => ({
  _id: STEP_ID, stepNumber: 2, toolName: 'createRecord', status: 'executing',
  toolInput: { entityType: 'Invoice', summary: 's', record: {
    CustomerRef: { value: '20' }, DocNumber: 'REPRO-cccccccc', TxnDate: '2026-10-08',
    Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '5' }, TaxCodeRef: { value: '3' } } }],
  } },
  ...overrides,
});
const customerStep = { stepNumber: 1, toolName: 'createRecord', status: 'completed', toolInput: { entityType: 'Customer', record: { DisplayName: 'REPRO c' } },
  result: { success: true, data: { entityType: 'Customer', id: '20' } } };
const savedInvoice = (id, extra = {}) => ({ Id: id, DocNumber: 'REPRO-cccccccc', TxnDate: '2026-10-08', CustomerRef: { value: '20', name: 'REPRO c' },
  TotalAmt: 113, Line: [{ Id: '1', Amount: 100, DetailType: 'SalesItemLineDetail' }, { Amount: 100, DetailType: 'SubTotalLineDetail' }],
  MetaData: { CreateTime: iso(NOW - 50000) }, ...extra });
const call = (f, extra = {}) => f.reconciler.reconcile({ userId: OWNER, actorId: OWNER, sessionId: SESSION, ...extra });

test('an unconfirmed create is matched to the one record it made, without sending anything', async () => {
  const f = fixture({ steps: [customerStep, invoiceStep()], queryRows: [savedInvoice('501'), savedInvoice('502', { DocNumber: 'OTHER' })] });
  const result = await call(f);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.outcomeUnknown, false);
  assert.deepEqual(result.resolved.map((r) => [r.stepNumber, r.decision, r.id]), [[2, 'found', '501']]);
  const step = f.plan.steps[1];
  assert.equal(step.status, 'completed');
  assert.equal(step.result.data.id, '501');
  assert.equal(step.result.outcomeUnknown, undefined);
  assert.equal(f.session.reproduction.outcomeUnknown, false);
  assert.deepEqual(f.session.reproduction.ownedRecords.map((r) => r.id), ['20', '501']);
  assert.equal(f.session.reproduction.decisionLockUntil, undefined, 'lock released');
  assert.deepEqual(f.writes, []);
  assert.match(f.queries[0], /^SELECT \* FROM Invoice WHERE MetaData\.CreateTime >= '2026-10-07T\d\d:\d\d:\d\d\+00:00' ORDERBY MetaData\.CreateTime DESC STARTPOSITION 1 MAXRESULTS 100$/);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0][2], 'Case write reconciled: createRecord found');
  assert.equal(f.audits[0][3].actionType, 'ai_plan');
});

test('a create with no record in QuickBooks is marked failed, so the case can continue', async () => {
  const f = fixture({ steps: [customerStep, invoiceStep()], queryRows: [savedInvoice('502', { DocNumber: 'OTHER', CustomerRef: { value: '99' } })] });
  const result = await call(f);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(f.plan.steps[1].status, 'failed');
  assert.equal(f.plan.steps[1].result.reconciled, 'not_found');
  assert.match(f.plan.steps[1].error, /not created/);
  assert.equal(f.session.reproduction.outcomeUnknown, false);
});

test('records created before the change window never count as its result', async () => {
  const old = savedInvoice('400', { MetaData: { CreateTime: iso(NOW - 3 * 60 * 60 * 1000) } });
  const f = fixture({ steps: [customerStep, invoiceStep()], queryRows: [old] });
  const result = await call(f);
  assert.equal(result.resolved[0].decision, 'not_found');
});

test('several possible records stay unresolved until the owner chooses one', async () => {
  const rows = [savedInvoice('501'), savedInvoice('503')];
  const f = fixture({ steps: [customerStep, invoiceStep()], queryRows: rows });
  const first = await call(f);
  assert.equal(first.outcomeUnknown, true);
  assert.deepEqual(first.unresolved[0].candidates.map((c) => c.id), ['501', '503']);
  assert.equal(f.plan.steps[1].status, 'executing', 'nothing recorded');
  assert.equal(f.session.reproduction.outcomeUnknown, true);
  assert.equal(f.audits.length, 0);

  const refused = await call(f, { selections: [{ planId: PLAN, stepNumber: 2, recordId: '777' }] });
  assert.equal(refused.outcomeUnknown, true);

  const chosen = await call(f, { selections: [{ planId: PLAN, stepNumber: 2, recordId: '503' }] });
  assert.equal(chosen.outcomeUnknown, false);
  assert.equal(f.plan.steps[1].result.data.id, '503');
  assert.equal(f.plan.steps[1].result.reconciled, 'owner_selected');
  assert.equal(f.audits.at(-1)[3].inputParams.ownerSelection, '503');
  assert.deepEqual(f.writes, []);
});

test('a soft mismatch (amount changed by tax handling) is never called not created', async () => {
  const f = fixture({ steps: [customerStep, invoiceStep()], queryRows: [savedInvoice('501', { Line: [{ Id: '1', Amount: 88.5, DetailType: 'SalesItemLineDetail' }] })] });
  const result = await call(f);
  assert.equal(result.outcomeUnknown, true);
  assert.deepEqual(result.unresolved[0].candidates.map((c) => c.id), ['501']);
  const none = await call(f, { selections: [{ planId: PLAN, stepNumber: 2, recordId: 'none' }] });
  assert.equal(none.resolved[0].decision, 'owner_confirmed_none');
  assert.equal(f.plan.steps[1].status, 'failed');
});

test('updates, voids and deletes are judged from the record as it is now', async () => {
  const steps = [
    customerStep,
    { stepNumber: 2, toolName: 'createRecord', status: 'completed', toolInput: { entityType: 'Invoice', record: {} }, result: { success: true, data: { id: '501' } } },
    { stepNumber: 3, toolName: 'updateRecord', status: 'failed', result: { success: false, outcomeUnknown: true },
      toolInput: { entityType: 'Invoice', id: '501', changes: { PrivateNote: 'after', CustomerMemo: { value: 'hi' } } } },
    { stepNumber: 4, toolName: 'updateRecord', status: 'executing', toolInput: { entityType: 'Customer', id: '20', changes: { Active: false } } },
    { stepNumber: 5, toolName: 'voidTransaction', status: 'executing', toolInput: { entityType: 'Payment', id: '601' } },
    { stepNumber: 6, toolName: 'deleteRecord', status: 'executing', toolInput: { entityType: 'Bill', id: '701' } },
    { stepNumber: 7, toolName: 'voidTransaction', status: 'failed', result: { success: false, outcomeUnknown: true },
      toolInput: { entityType: 'Invoice', id: '900' }, approval: { state: 'unknown', syncToken: '4' } },
  ];
  const records = {
    'invoice:501': { __type: 'Invoice', Id: '501', SyncToken: '2', PrivateNote: 'after', CustomerMemo: { value: 'hi' } },
    'customer:20': { __type: 'Customer', Id: '20', SyncToken: '1', Active: true },
    'payment:601': { __type: 'Payment', Id: '601', SyncToken: '1', TotalAmt: 0, PrivateNote: 'Voided' },
    'invoice:900': { __type: 'Invoice', Id: '900', SyncToken: '4', TotalAmt: 50 },
  };
  const f = fixture({ steps, records });
  const result = await call(f);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.resolved.map((r) => [r.stepNumber, r.decision, r.status]), [
    [3, 'applied', 'completed'], [4, 'not_applied', 'failed'], [5, 'applied', 'completed'],
    [6, 'deleted', 'completed'], [7, 'not_applied', 'failed'],
  ]);
  assert.equal(f.plan.steps[6].approval.state, 'failed');
  assert.equal(f.plan.steps[5].result.data.deleted, true);
  assert.equal(f.session.reproduction.outcomeUnknown, false);
  assert.deepEqual(f.writes, []);
  assert.equal(f.audits.length, 5);
});

test('only the company owner can reconcile, and never during a run', async () => {
  const f = fixture({ steps: [invoiceStep()] });
  await assert.rejects(call(f, { actorId: MEMBER }), (err) => err.status === 403 && err.caseReconcile);
  await assert.rejects(fixture({ steps: [invoiceStep()], active: true }).reconciler.reconcile({ userId: OWNER, actorId: OWNER, sessionId: SESSION }),
    (err) => err.status === 409);
  await assert.rejects(fixture({ steps: [invoiceStep()], running: true }).reconciler.reconcile({ userId: OWNER, actorId: OWNER, sessionId: SESSION }),
    (err) => err.status === 409);
  await assert.rejects(call(f, { sessionId: 'x' }), (err) => err.status === 400);
  assert.equal(f.plan.steps[0].status, 'executing');
});

test('a decision that cannot be audited is not recorded', async () => {
  const f = fixture({ steps: [customerStep, invoiceStep()], queryRows: [savedInvoice('501')], auditOk: false });
  const result = await call(f);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(f.plan.steps[1].status, 'executing');
  assert.equal(f.session.reproduction.outcomeUnknown, true);
});

test('a stale unknown flag with no unresolved steps is cleared', async () => {
  const f = fixture({ steps: [customerStep] });
  const result = await call(f);
  assert.deepEqual(result, { resolved: [], unresolved: [], outcomeUnknown: false });
  assert.equal(f.session.reproduction.outcomeUnknown, false);
});

test('update comparison checks references by Id and Line as the whole list', () => {
  const { holds } = _internal;
  assert.equal(holds({ value: '3', name: 'GST' }, { value: '3', name: 'GST/HST' }), true);
  assert.equal(holds([{ Id: '1', Amount: 5 }], [{ Id: '1', Amount: 5 }, { Id: '2', Amount: 7 }], 'Line'), false);
  assert.equal(holds([{ Id: '2', Amount: 7 }, { Amount: 3 }], [{ Id: '2', Amount: 7 }, { Id: '3', Amount: 3 }, { DetailType: 'SubTotalLineDetail', Amount: 10 }], 'Line'), true);
  assert.equal(_internal.qboTime(Date.parse('2026-10-08T15:00:00.123Z')), '2026-10-08T15:00:00+00:00');
  assert.equal(_internal.stepStartedAt({ _id: STEP_ID }), Math.floor((NOW - 60000) / 1000) * 1000);
});

test('records created after the request could have landed are outside the window', async () => {
  const late = savedInvoice('510', { MetaData: { CreateTime: iso(NOW + 60 * 60 * 1000) } });
  const f = fixture({ steps: [customerStep, invoiceStep()], queryRows: [late] });
  assert.equal((await call(f)).resolved[0].decision, 'not_found');
});

test('a matched record with relationships outside the case is never made case-owned', async () => {
  const linked = savedInvoice('501', { LinkedTxn: [{ TxnId: '999', TxnType: 'Estimate' }] });
  const f = fixture({ steps: [customerStep, invoiceStep()], queryRows: [linked] });
  const auto = await call(f);
  assert.equal(auto.outcomeUnknown, true);
  assert.match(auto.unresolved[0].reason, /cannot belong to this case/);
  const chosen = await call(f, { selections: [{ planId: PLAN, stepNumber: 2, recordId: '501' }] });
  assert.equal(chosen.outcomeUnknown, true);
  assert.equal(f.plan.steps[1].status, 'executing');
  assert.deepEqual(f.session.reproduction.ownedRecords, []);
});

test('transfer accounts alone never identify a record; only none can be chosen', async () => {
  const step = { _id: STEP_ID, stepNumber: 1, toolName: 'createRecord', status: 'executing',
    toolInput: { entityType: 'Transfer', record: { FromAccountRef: { value: '1' }, ToAccountRef: { value: '2' }, Amount: 50, TxnDate: '2026-10-08' } } };
  const transfer = { Id: '801', FromAccountRef: { value: '1' }, ToAccountRef: { value: '2' }, Amount: 50, TxnDate: '2026-10-08', MetaData: { CreateTime: iso(NOW - 50000) } };
  const f = fixture({ steps: [step], queryRows: [transfer] });
  const auto = await call(f);
  assert.equal(auto.outcomeUnknown, true);
  assert.match(auto.unresolved[0].reason, /no identifying field/);
  const chosen = await call(f, { selections: [{ planId: PLAN, stepNumber: 1, recordId: '801' }] });
  assert.match(chosen.unresolved[0].reason, /only "none"/);
  assert.equal(f.plan.steps[0].status, 'executing');
  const none = await call(f, { selections: [{ planId: PLAN, stepNumber: 1, recordId: 'none' }] });
  assert.equal(none.resolved[0].decision, 'owner_confirmed_none');
});
