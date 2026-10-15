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
  const query = fn => ({ session() { return this; }, sort() { return this; }, async lean() { return copy(fn()); } });
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
    createdTransactions: [], generationErrors: [], steps: [step('invoice', { TxnDate: '2026-09-01', CustomerRef: { value: '20' } }),
      step('payment', { TxnDate: '2026-09-02', CustomerRef: { value: '20' }, DepositToAccountRef: { value: '5' }, TotalAmt: 100, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: '$step:0', TxnType: 'Invoice' }] }] })], ...overrides };
}
function engineHarness(run, create, audit = async () => ({ _id: 'audit' })) {
  const Runs = collection([run]);
  const profiles = [];
  let paid = false, paymentRecord;
  const dependencies = { Runs, now: () => NOW, audit, clientFactory: async () => ({ create: async (...args) => { const result = await create(...args); for (const row of Object.values(result || {})) if (row?.Id) { row.TotalAmt ??= 100; row.SyncToken ??= '0'; } if (args[0] === 'payment') { paid = true; paymentRecord = { ...copy(args[1]), ...result.Payment }; } return result; }, read: async (_entity, id) => _entity === 'payment' ? { Payment: paymentRecord } : ({ Invoice: { Id: id, SyncToken: '0', TxnDate: '2026-09-01', CustomerRef: { value: '20' }, TotalAmt: 100, Balance: paid ? 0 : 100 } }) }),
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
  assert.deepEqual(generationView(h.saved(), NOW).counts, { created: 1, failed: 1, pending: 0, uncertain: 0, auditPending: 0, verificationPending: 0, planned: 2 });
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
  assert.ok(plan.length >= 10 && plan.length <= 30);
  for (const entry of plan) { assert.equal(entry.state, 'pending'); assert.ok(entry.transaction.entity); assert.match(entry.payload.TxnDate, /^2026-10-/); assert.ok(entry.payload.TxnDate <= '2026-10-02'); assert.notEqual(entry.entity, 'journalentry'); }
  for (const entry of plan.filter(s => ['payment', 'billpayment'].includes(s.entity))) assert.match(entry.payload.Line[0].LinkedTxn[0].TxnId, /^\$step:/);
});

function serviceHarness(initial = []) {
  const Runs = collection(initial); const Scopes = collection(); const launched = [];
  let sequence = 10;
  const service = createGenerationService({ Runs, Scopes, admitJob: async (_connection, _action, work) => work(null), environment: 'sandbox', now: () => NOW,
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

for (const entity of ['invoice', 'bill']) for (const fraction of [1, 0.5]) test(entity+' settlement uses accepted tax total and verifies the remaining balance: '+fraction, async () => {
  const sales = entity === 'invoice', sourceType = sales ? 'Invoice' : 'Bill', paymentType = sales ? 'Payment' : 'BillPayment', partyKey = sales ? 'CustomerRef' : 'VendorRef';
  const parent = step(entity, { TxnDate: '2026-09-01', [partyKey]: { value: '20' } }); parent.transaction.entity = sourceType;
  const child = step(sales ? 'payment' : 'billpayment', { TxnDate: '2026-09-10', [partyKey]: { value: '20' }, ...(sales ? { DepositToAccountRef: { value: '5' } } : { CheckPayment: { BankAccountRef: { value: '5' } } }), TotalAmt: 100*fraction, Line: [{ Amount: 100*fraction, LinkedTxn: [{ TxnId: '$step:0', TxnType: sourceType }] }] }, { settlement: { version: 1, sourceIndex: 0, fraction } });
  child.transaction.entity = paymentType; child.transaction.amount = 100*fraction;
  const run = fixtureRun({ steps: [parent, child] }), sent = []; let balance = 113;
  const h = engineHarness(run, async () => {});
  h.dependencies.clientFactory = async () => ({
    create: async (type, payload) => { sent.push(copy(payload)); if (type !== entity) balance -= payload.TotalAmt; return { [type === entity ? sourceType : paymentType]: { Id: type === entity ? '100' : '200', SyncToken: '0', TotalAmt: type === entity ? 113 : payload.TotalAmt } }; },
    read: async (type) => type === paymentType.toLowerCase() ? { [paymentType]: { ...sent[1], Id: '200', SyncToken: '0' } } : ({ [sourceType]: { Id: '100', SyncToken: '0', TxnDate: '2026-09-01', [partyKey]: { value: '20' }, TotalAmt: 113, Balance: balance } }),
  });
  await runGenerationJob(copy(run), connection, h.dependencies);
  assert.equal(h.saved().status, 'completed'); assert.equal(sent[1].TotalAmt, 113*fraction); assert.equal(sent[1].Line[0].Amount, 113*fraction);
  assert.equal(h.saved().createdTransactions[0].amount, 113); assert.equal(h.saved().createdTransactions[1].amount, 113*fraction);
  assert.equal(h.saved().steps[1].verifiedSettlement.remainingBalance, 113*(1-fraction));
  assert.deepEqual(generationView(h.saved(), NOW).createdTransactions.map(row => row.amount), [113, 113*fraction]);
});
for (const change of [r => { r.TotalAmt = undefined; }, r => { r.CustomerRef.value = 'other'; }, r => { r.Balance = 0; }, r => { r.TotalAmt = 500; }, r => { r.SyncToken = '2'; }]) test('unverified or changed source cannot be paid: '+change.toString(), async () => {
  const run = fixtureRun(), sent = [];
  const h = engineHarness(run, async () => {});
  const record = { Id: '100', SyncToken: '0', TotalAmt: 113, Balance: 113, TxnDate: '2026-09-01', CustomerRef: { value: '20' } }; change(record);
  h.dependencies.clientFactory = async () => ({ create: async type => { sent.push(type); return { Invoice: { Id: '100', SyncToken: '0', TotalAmt: 113 } }; }, read: async () => ({ Invoice: record }) });
  await runGenerationJob(copy(run), connection, h.dependencies);
  assert.deepEqual(sent, ['invoice']); assert.equal(h.saved().status, 'partial'); assert.equal(h.saved().steps[1].state, 'pending');
});
test('a saved payment with unverified balance is retained and is never recreated on resume', async () => {
  const run = fixtureRun(), sent = []; let balance = 113;
  const h = engineHarness(run, async () => {});
  h.dependencies.clientFactory = async () => ({ create: async (type, payload) => { sent.push({ type, payload }); return { [type === 'invoice' ? 'Invoice' : 'Payment']: { Id: type === 'invoice' ? '100' : '200', SyncToken: '0', TotalAmt: 113 } }; }, read: async type => type === 'payment' ? { Payment: { ...sent[1].payload, Id: '200', SyncToken: '0' } } : ({ Invoice: { Id: '100', SyncToken: '0', TotalAmt: 113, Balance: balance, TxnDate: '2026-09-01', CustomerRef: { value: '20' } } }) });
  await runGenerationJob(copy(run), connection, h.dependencies);
  assert.equal(h.saved().status, 'partial'); assert.equal(h.saved().steps[1].receipt.Id, '200');
  balance = 0; await runGenerationJob(claimAgain(h), connection, h.dependencies);
  assert.deepEqual(sent.map(row => row.type), ['invoice', 'payment']); assert.equal(h.saved().status, 'completed');
});
test('calendar-month plans cover each requested month without future transactions or invented adjustments', async () => {
  const data = { customers: [{ Id: '1', DisplayName: 'Fixture Customer' }], vendors: [{ Id: '2', DisplayName: 'Fixture Vendor' }], items: [{ Id: '3' }], expenseAccounts: [{ Id: '4' }], bankAccounts: [{ Id: '5' }] };
  for (const anchorDate of ['2024-03-01', '2026-01-31']) {
    const plan = await buildGenerationPlan({ anchorDate, monthsBack: 3, txnsPerMonth: 10, arWeight: 0.6 }, data);
    const parents = plan.filter(row => ['invoice', 'bill'].includes(row.entity));
    assert.equal(parents.length, 30); assert.equal(new Set(parents.map(row => row.payload.TxnDate.slice(0, 7))).size, 3);
    assert.ok(plan.every(row => row.payload.TxnDate <= anchorDate)); assert.ok(plan.every(row => row.entity !== 'journalentry'));
    assert.ok(plan.filter(row => ['creditmemo', 'vendorcredit'].includes(row.entity)).every(row => row.transaction.linkedTo === ''));
    assert.ok(plan.filter(row => row.entity === 'payment').every(row => row.payload.DepositToAccountRef.value === '5'));
  }
});
test('an explicit uncertain transport outcome cannot be classified as a definite rejection', () => {
  const { isDefiniteRejection } = require('../src/modules/generation-engine');
  assert.equal(isDefiniteRejection({ status: 429, qboStage: 'api', outcomeUnknown: true }), false);
});

test('definite write admission denial stays resumable after setup or access is restored', async () => {
  const run = fixtureRun({ steps: [step('invoice', { TxnDate: '2026-09-01' })] }); let deny = true, accepted = 0;
  const h = engineHarness(run, async () => { if (deny) throw Object.assign(new Error('Storage setup required'), { qboStage: 'write_admission', status: 409 }); accepted++; return { Invoice: { Id: '100' } }; });
  await runGenerationJob(copy(run), connection, h.dependencies);
  assert.equal(h.saved().steps[0].state, 'rejected'); assert.equal(generationView(h.saved(), NOW).canResume, true); assert.equal(accepted, 0);
  deny = false; await runGenerationJob(claimAgain(h), connection, h.dependencies); assert.equal(accepted, 1); assert.equal(h.saved().status, 'completed');
});
test('an older incomplete parent receipt cannot authorize a newly changed payment amount', async () => {
  const run = fixtureRun(); Object.assign(run.steps[0], { state: 'succeeded', audited: true, receipt: { Id: '100' } }); let calls = 0;
  const h = engineHarness(run, async () => { calls++; });
  await runGenerationJob(copy(run), connection, h.dependencies); assert.equal(calls, 0); assert.equal(h.saved().status, 'partial');
});
for (const mutate of [r => { r.TotalAmt += 10; r.UnappliedAmt = 10; }, r => { r.Line[0].LinkedTxn[0].TxnId = '999'; }, r => { r.DepositToAccountRef.value = '999'; }, r => { r.CustomerRef.value = '999'; }, r => { r.TxnDate = '2026-09-30'; }]) test('source balance alone cannot approve a changed payment: '+mutate.toString(), async () => {
  const { verifySettlement } = require('../src/modules/generation-settlement');
  const payload = { TxnDate: '2026-09-02', CustomerRef: { value: '20' }, DepositToAccountRef: { value: '5' }, TotalAmt: 113, Line: [{ Amount: 113, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] };
  const record = { ...copy(payload), Id: '200', SyncToken: '0', UnappliedAmt: 0 }; mutate(record);
  const qbo = { read: async type => type === 'payment' ? { Payment: record } : { Invoice: { Id: '100', TotalAmt: 113, Balance: 0 } } };
  await assert.rejects(verifySettlement({ sourceType: 'Invoice', sourceId: '100', total: 113, balance: 113, amount: 113 }, qbo, { entity: 'Payment', id: '200', payload }), /saved payment/);
});

test('generation uses the local business day across UTC midnight', () => {
  assert.equal(validateConfig({}, new Date('2026-10-15T00:30:00Z')).anchorDate, '2026-10-14');
  assert.equal(validateConfig({}, new Date('2026-10-15T03:30:00Z')).anchorDate, '2026-10-15');
});
