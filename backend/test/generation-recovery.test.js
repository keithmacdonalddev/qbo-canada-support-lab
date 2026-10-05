const test = require('node:test');
const assert = require('node:assert/strict');
const { runGenerationJob } = require('../src/modules/generation-engine');
const { createGenerationService, validateConfig } = require('../src/modules/generation-service');
const { generationView, LEASE_MS } = require('../src/modules/generation-state');
const { buildGenerationPlan } = require('../src/modules/generation-plan');

const copy = value => value == null ? value : structuredClone(value);
const ID = '000000000000000000000001';
const USER = '000000000000000000000002';
const CONNECTION = '000000000000000000000003';
const NOW = Date.parse('2026-10-02T12:00:00Z');
const connection = { _id: CONNECTION, realmId: 'fixture-realm' };
function matches(doc, filter) {
  if (!doc) return false;
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(doc, part));
    const actual = doc[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$exists' in value) return (actual !== undefined) === value.$exists;
      if ('$ne' in value) return actual !== value.$ne;
      if ('$in' in value) return value.$in.includes(actual);
      if ('$gt' in value) return new Date(actual) > new Date(value.$gt);
      if ('$lte' in value) return new Date(actual) <= new Date(value.$lte);
      if ('$not' in value) return !(actual || []).some(s => matches(s, value.$not.$elemMatch));
    }
    return value === null ? actual == null : String(actual) === String(value);
  });
}
function applyFields(doc, fields) {
  for (const [key, value] of Object.entries(fields)) {
    const path = key.split('.');
    let target = doc;
    for (const part of path.slice(0, -1)) target = target[part];
    target[path.at(-1)] = copy(value);
  }
}
function collection(initial = []) {
  const docs = new Map(initial.map(doc => [String(doc._id), copy(doc)]));
  const query = fn => ({ sort() { return this; }, async lean() { return copy(fn()); } });
  const store = {
    docs, updates: [], beforeUpdate: null,
    findById(id) { return query(() => docs.get(String(id)) || null); },
    findOne(filter) { return query(() => [...docs.values()].find(doc => matches(doc, filter)) || null); },
    find(filter) { return query(() => [...docs.values()].filter(doc => matches(doc, filter))); },
    findOneAndUpdate(filter, update, options = {}) {
      return query(() => {
        store.beforeUpdate?.(filter, update);
        store.updates.push(copy({ filter, update }));
        let doc = [...docs.values()].find(row => matches(row, filter));
        if (!doc && options.upsert) {
          if (docs.has(String(filter._id))) throw Object.assign(new Error('Duplicate'), { code: 11000 });
          doc = { ...filter, ...copy(update.$setOnInsert) };
          docs.set(String(doc._id), doc);
        }
        if (!doc) return null;
        applyFields(doc, update.$set || {});
        return doc;
      });
    },
    async updateOne(filter, update) {
      store.beforeUpdate?.(filter, update);
      store.updates.push(copy({ filter, update }));
      const doc = [...docs.values()].find(row => matches(row, filter));
      if (!doc) return { matchedCount: 0 };
      applyFields(doc, update.$set);
      return { matchedCount: 1 };
    },
  };
  return store;
}
function step(entity, payload, extra = {}) {
  const names = { invoice: 'Invoice', payment: 'Payment' };
  return { entity, payload, state: 'pending', transaction: { entity: names[entity], amount: 100,
    txnDate: '2026-09-01', customerOrVendor: 'Fixture Customer', linkedTo: entity === 'payment' ? 'Invoice #$step:0' : '', chainIndex: 1 }, ...extra };
}
function fixtureRun(overrides = {}) {
  return { _id: ID, userId: USER, realmId: connection.realmId, environment: 'sandbox', connectionId: CONNECTION,
    executionVersion: 1, status: 'in_progress', leaseToken: 'owner', leaseExpiresAt: new Date(NOW + LEASE_MS),
    config: validateConfig({ monthsBack: 1, txnsPerMonth: 1 }, new Date(NOW)), startedAt: new Date(NOW),
    createdTransactions: [], generationErrors: [], steps: [step('invoice', { TxnDate: '2026-09-01' }),
      step('payment', { TxnDate: '2026-09-02', Line: [{ LinkedTxn: [{ TxnId: '$step:0' }] }] })], ...overrides };
}
function engineHarness(run, create, audit = async () => ({ _id: 'audit' })) {
  const Runs = collection([run]);
  const profiles = [];
  const dependencies = { Runs, now: () => NOW, audit, clientFactory: async () => ({ create }),
    Profiles: { async findOneAndUpdate(filter, update) { profiles.push({ filter, update }); } } };
  return { Runs, dependencies, profiles, saved: () => copy(Runs.docs.get(ID)) };
}
function claimAgain(h) {
  const run = h.saved();
  run.leaseToken = 'next-owner'; run.leaseExpiresAt = new Date(NOW + LEASE_MS); run.status = 'in_progress';
  h.Runs.docs.set(ID, copy(run));
  return run;
}

test('a rejected child produces partial outcome; resume skips the saved parent and preserves its link', async () => {
  const calls = [];
  let reject = true;
  const h = engineHarness(fixtureRun(), async (entity, payload) => {
    calls.push({ entity, payload: copy(payload) });
    if (entity === 'payment' && reject) throw Object.assign(new Error('Invalid payment'), { status: 400, qboStage: 'api' });
    return entity === 'invoice' ? { Invoice: { Id: 'qbo-invoice' } } : { Payment: { Id: 'qbo-payment' } };
  });
  await runGenerationJob(fixtureRun(), connection, h.dependencies);
  assert.equal(h.saved().status, 'partial');
  assert.equal(h.saved().createdTransactions.length, 1);
  assert.equal(h.saved().txnsSummary.invoices, 1);
  assert.deepEqual(generationView(h.saved(), NOW).counts, { created: 1, failed: 1, pending: 0, uncertain: 0, auditPending: 0, planned: 2 });
  reject = false;
  await runGenerationJob(claimAgain(h), connection, h.dependencies);
  assert.equal(h.saved().status, 'completed');
  assert.deepEqual(calls.map(c => c.entity), ['invoice', 'payment', 'payment']);
  assert.equal(calls[2].payload.Line[0].LinkedTxn[0].TxnId, 'qbo-invoice');
  assert.equal(h.saved().createdTransactions.length, 2);
  assert.equal(h.profiles.at(-1).update.$set.generationStatus, 'completed');
});

test('timeout after acceptance stays uncertain and cannot be replayed', async () => {
  let calls = 0;
  const h = engineHarness(fixtureRun(), async () => { calls++; throw Object.assign(new Error('reply lost'), { code: 'ETIMEDOUT' }); });
  await runGenerationJob(fixtureRun(), connection, h.dependencies);
  const view = generationView(h.saved(), NOW);
  assert.equal(view.status, 'interrupted'); assert.equal(view.canResume, false);
  assert.equal(view.counts.uncertain, 1); assert.equal(view.counts.pending, 1);
  assert.equal(view.inspection[0].amount, 100);
  assert.equal('steps' in view, false); assert.equal('leaseToken' in view, false);
  await runGenerationJob(claimAgain(h), connection, h.dependencies);
  assert.equal(calls, 1);
});

for (const failure of [
  Object.assign(new Error('timeout status'), { status: 408, qboStage: 'api' }),
  Object.assign(new Error('server error'), { status: 500, qboStage: 'api' }),
  Object.assign(new Error('storage error'), { status: 400, qboStage: 'storage_save' }),
]) test('unconfirmed write is not retryable: ' + failure.message, async () => {
  const h = engineHarness(fixtureRun(), async () => { throw failure; });
  await runGenerationJob(fixtureRun(), connection, h.dependencies);
  assert.equal(h.saved().steps[0].state, 'uncertain');
  assert.equal(generationView(h.saved(), NOW).canResume, false);
});

test('malformed success without ID blocks retry', async () => {
  const h = engineHarness(fixtureRun(), async () => ({ Invoice: {} }));
  await runGenerationJob(fixtureRun(), connection, h.dependencies);
  assert.equal(h.saved().steps[0].state, 'uncertain');
});

test('audit failure saves success first; resume repairs audit without another create', async () => {
  const run = fixtureRun({ steps: [step('invoice', {})] });
  let calls = 0; let auditsWork = false;
  const h = engineHarness(run, async () => { calls++; return { Invoice: { Id: 'saved-id' } }; }, async () => auditsWork ? {} : null);
  await runGenerationJob(copy(run), connection, h.dependencies);
  assert.equal(h.saved().status, 'partial'); assert.equal(h.saved().steps[0].receipt.Id, 'saved-id');
  assert.equal(generationView(h.saved(), NOW).counts.auditPending, 1);
  auditsWork = true;
  await runGenerationJob(claimAgain(h), connection, h.dependencies);
  assert.equal(calls, 1); assert.equal(h.saved().status, 'completed');
});

test('database failure after acceptance leaves sending durable and prevents a second dispatch', async () => {
  const h = engineHarness(fixtureRun(), async () => ({ Invoice: { Id: 'accepted' } }));
  h.Runs.beforeUpdate = (_f, update) => { if (update.$set['steps.0']?.state === 'succeeded') throw new Error('storage unavailable'); };
  await assert.rejects(runGenerationJob(fixtureRun(), connection, h.dependencies), /storage unavailable/);
  assert.equal(h.saved().steps[0].state, 'sending');
  assert.equal(generationView(h.saved(), NOW + LEASE_MS * 2).canResume, false);
});

test('expired or replaced owner cannot cross the dispatch barrier', async () => {
  for (const lease of [{ leaseToken: 'different-owner' }, { leaseExpiresAt: new Date(NOW - 1) }]) {
    let calls = 0;
    const h = engineHarness(fixtureRun(lease), async () => { calls++; });
    await runGenerationJob(fixtureRun(), connection, h.dependencies);
    assert.equal(calls, 0);
    assert.equal(h.saved().steps[0].state, 'pending');
  }
});

test('setup errors finalize as failed with zero created and allow explicit resume', async () => {
  const h = engineHarness(fixtureRun({ steps: undefined }), async () => {});
  h.dependencies.clientFactory = async () => { throw new Error('Connection unavailable'); };
  await runGenerationJob(fixtureRun({ steps: undefined }), connection, h.dependencies);
  assert.equal(h.saved().status, 'failed'); assert.equal(h.saved().leaseToken, null);
  assert.equal(generationView(h.saved(), NOW).canResume, true);
});

test('legacy completed with errors is partial, and incomplete legacy jobs cannot resume', () => {
  const view = generationView({ status: 'completed', createdTransactions: [{ qboId: 'old' }], generationErrors: [{ detail: 'failed' }] });
  assert.equal(view.status, 'partial'); assert.equal(view.canCreateAdditional, false); assert.equal(view.canResume, false);
  assert.equal(generationView({ status: 'completed', generationErrors: [{ detail: 'all failed' }] }).status, 'failed');
  assert.equal(generationView({ status: 'in_progress' }).status, 'interrupted');
});

test('pure planner creates linked bounded plan with no database or QBO dependency', async () => {
  const data = { customers: [{ Id: 'cust', DisplayName: 'Fixture Customer' }], vendors: [{ Id: 'vendor', DisplayName: 'Fixture Vendor' }],
    items: [{ Id: 'item', Name: 'Fixture Item' }], expenseAccounts: [{ Id: 'expense' }], bankAccounts: [{ Id: 'bank' }], incomeAccounts: [{ Id: 'income' }] };
  const plan = await buildGenerationPlan(validateConfig({ monthsBack: 1, txnsPerMonth: 10 }, new Date(NOW)), data);
  assert.ok(plan.length >= 11 && plan.length <= 32);
  for (const entry of plan) { assert.equal(entry.state, 'pending'); assert.ok(entry.transaction.entity); assert.match(entry.payload.TxnDate, /^2026-0?[9]|^2026-1[01]/); }
  for (const entry of plan.filter(s => ['payment', 'billpayment'].includes(s.entity))) assert.match(entry.payload.Line[0].LinkedTxn[0].TxnId, /^\$step:/);
});

function serviceHarness(initial = []) {
  const Runs = collection(initial); const Scopes = collection(); const launched = [];
  let sequence = 10;
  const service = createGenerationService({ Runs, Scopes, environment: 'sandbox', now: () => NOW,
    newId: () => (++sequence).toString(16).padStart(24, '0'), execute: async run => { launched.push(copy(run)); } });
  return { Runs, Scopes, launched, service };
}

test('simultaneous starts reserve one run and launch one worker', async () => {
  const h = serviceHarness();
  const results = await Promise.all([h.service.start(connection, USER), h.service.start(connection, USER)]);
  assert.equal(results[0]._id, results[1]._id); assert.equal(h.Runs.docs.size, 1); assert.equal(h.launched.length, 1);
  const claim = h.Runs.updates.find(u => u.update.$set?.leaseToken);
  assert.ok(claim.filter.steps.$not.$elemMatch.state.$in.includes('sending'));
});

test('lost reservation-to-run response reuses reserved ID and original configuration', async () => {
  const h = serviceHarness(); let fail = true;
  h.Runs.beforeUpdate = (_f, update) => { if (update.$setOnInsert && fail) { fail = false; throw new Error('write failed'); } };
  await assert.rejects(h.service.start(connection, USER, { monthsBack: 3 }), /write failed/);
  const reserved = copy([...h.Scopes.docs.values()][0]);
  const result = await h.service.start(connection, USER, { monthsBack: 6 });
  assert.equal(result._id, reserved.runId); assert.equal(result.config.monthsBack, 3); assert.equal(h.launched.length, 1);
});

test('explicit additional batch is a one-time transition, including repeated HTTP requests', async () => {
  const old = fixtureRun({ status: 'completed', leaseToken: null, steps: [step('invoice', {}, { state: 'succeeded', receipt: { Id: 'old' }, audited: true })] });
  const h = serviceHarness([old]);
  assert.equal((await h.service.start(connection, USER))._id, ID);
  assert.equal(h.launched.length, 0);
  const results = await Promise.all([h.service.start(connection, USER, { previousRunId: ID }), h.service.start(connection, USER, { previousRunId: ID })]);
  assert.equal(results[0]._id, results[1]._id); assert.notEqual(results[0]._id, ID); assert.equal(h.launched.length, 1);
});

test('legacy partial jobs block new batches even with different config', async () => {
  const old = { _id: ID, userId: USER, realmId: connection.realmId, status: 'completed', generationErrors: [{ detail: 'failed' }], createdTransactions: [{ qboId: 'old' }] };
  const h = serviceHarness([old]);
  const result = await h.service.start(connection, USER, { monthsBack: 12 });
  assert.equal(result.status, 'partial'); assert.equal(h.launched.length, 0);
  await assert.rejects(h.service.start(connection, USER, { previousRunId: ID }), /Finish or inspect/);
});

test('uncertain expired runs cannot be claimed and plain start does not silently resume', async () => {
  for (const state of ['sending', 'uncertain']) {
    const h = serviceHarness([fixtureRun({ leaseExpiresAt: new Date(NOW - 1), steps: [step('invoice', {}, { state })] })]);
    assert.equal((await h.service.start(connection, USER, { resumeRunId: ID })).canResume, false);
    assert.equal(h.launched.length, 0);
  }
  const h = serviceHarness([fixtureRun({ status: 'partial', leaseToken: null })]);
  assert.equal((await h.service.start(connection, USER)).canResume, true);
  assert.equal(h.launched.length, 0);
  await h.service.start(connection, USER, { resumeRunId: ID });
  assert.equal(h.launched.length, 1);
});

test('company reservation rejects a different user and invalid numeric inputs', async () => {
  const h = serviceHarness(); await h.service.start(connection, USER);
  await assert.rejects(h.service.start(connection, 'different-user'), /another account/);
  for (const value of [0, -1, 1.2, '3', NaN, Infinity, 13]) assert.throws(() => validateConfig({ monthsBack: value }), /Choose/);
  assert.throws(() => validateConfig({ txnsPerMonth: 61 }), /Choose/);
});


test('failed pre-dispatch persistence is resumable and sends nothing', async () => {
  let calls = 0;
  const h = engineHarness(fixtureRun(), async () => { calls++; });
  let failOnce = true;
  h.Runs.beforeUpdate = (_f, update) => {
    if (update.$set['steps.0']?.state === 'sending' && failOnce) { failOnce = false; throw new Error('temporary storage failure'); }
  };
  await runGenerationJob(fixtureRun(), connection, h.dependencies);
  assert.equal(calls, 0); assert.equal(h.saved().steps[0].state, 'pending');
  assert.equal(generationView(h.saved(), NOW).canResume, true);
});

test('step persistence does not rewrite the complete immutable plan', async () => {
  const h = engineHarness(fixtureRun(), async entity => entity === 'invoice' ? { Invoice: { Id: 'invoice' } } : { Payment: { Id: 'payment' } });
  await runGenerationJob(fixtureRun(), connection, h.dependencies);
  assert.ok(h.Runs.updates.some(u => u.update.$set['steps.0']));
  assert.ok(h.Runs.updates.every(u => !('steps' in u.update.$set)));
  assert.equal(h.saved().status, 'completed');
});


test('a live sending step is ordinary progress; expired sending exposes inspection details', () => {
  const run = fixtureRun({ steps: [step('invoice', { TxnDate: '2026-09-01' }, { state: 'sending' })] });
  const active = generationView(run, NOW);
  assert.equal(active.status, 'in_progress'); assert.equal(active.inspection.length, 0);
  assert.equal(active.counts.uncertain, 0); assert.equal(active.recoveryMessage, null);
  assert.equal(active.generationErrors.length, 0);
  const interrupted = generationView(run, NOW + LEASE_MS + 1);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.counts.uncertain, 1);
  assert.equal(interrupted.canResume, false); assert.equal(interrupted.inspection.length, 1);
  assert.match(interrupted.generationErrors[0].detail, /not confirmed/);
});

test('persisted step rejection reason survives missing aggregate finalization', () => {
  const run = fixtureRun({ leaseToken: null, steps: [step('invoice', { TxnDate: '2026-09-01' }, { state: 'rejected', error: 'Fixture tax code rejected' })] });
  const view = generationView(run, NOW);
  assert.equal(view.generationErrors[0].detail, 'Fixture tax code rejected');
});


test('ordinary in-flight audit persistence does not show a recovery warning', () => {
  const run = fixtureRun({ steps: [step('invoice', {}, { state: 'succeeded', receipt: { Id: 'confirmed' }, audited: false })] });
  assert.equal(generationView(run, NOW).recoveryMessage, null);
  assert.match(generationView(run, NOW + LEASE_MS + 1).recoveryMessage, /audit entries/);
});
