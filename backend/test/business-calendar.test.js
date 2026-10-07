'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planBusinessCalendar: plan, reconcileCalendarPlan: reconcile, validateCalendarDefinition, date } = require('../src/modules/business-calendar');
const scope = { realmId: '123', environment: 'sandbox' };
function definition() {
  return { version: 1, businessKey: 'harbour-pine', openingDate: '2024-01-01', rules: [{ key: 'monthly-care', divisionKey: 'care', startsOn: '2024-01-01', cadence: { kind: 'monthly', day: 31, every: 1 }, steps: [
    { key: 'invoice', entity: 'Invoice', offsetDays: 0, dependsOn: [], intent: { customerKey: 'subscriber', itemKey: 'care', quantity: 1, unitPriceCents: 10000, taxPolicyKey: 'reviewed-ca' } },
    { key: 'payment', entity: 'Payment', offsetDays: 15, dependsOn: ['invoice'], intent: { settlementBasisPoints: 10000, bankKey: 'operating' } },
  ] }] };
}
function make(fromDate = '2024-01-01', throughDate = '2024-03-31', def = definition(), extras = {}) { return plan({ definition: def, scope, fromDate, throughDate, today: '2026-10-06', ...extras }); }
function ledger(result, records = []) { return { scope, complete: true, requestedKeys: [...result.events, ...result.future, ...result.prerequisites].map(event => event.logicalKey), records }; }
function receipt(event, extra = {}) { return { logicalKey: event.logicalKey, entity: event.entity, fingerprint: event.fingerprint, state: 'verified', qboId: '42', ...extra }; }
test('calendar repeats exactly and uses actual month ends without February drift', () => {
  const result = make(); assert.deepEqual(result, make());
  assert.deepEqual(result.events.filter(event => event.entity === 'Invoice').map(event => event.txnDate), ['2024-01-31', '2024-02-29', '2024-03-31']);
  assert.equal(result.future[0].txnDate, '2024-04-15');
  assert.equal(result.executable, false); assert.equal(result.calendarVerified, false);
});
test('partitioning the window preserves event identities, contents and earlier obligations', () => {
  const whole = make();
  const parts = [make('2024-01-01', '2024-02-10'), make('2024-02-11', '2024-03-31')];
  assert.deepEqual(parts.flatMap(part => part.events), whole.events);
  const payment = parts[1].events.find(event => event.entity === 'Payment');
  assert.equal(payment.txnDate, '2024-02-15');
  assert.equal(parts[1].prerequisites[0].logicalKey, payment.dependsOn[0]);
  assert.deepEqual(parts[0].future.find(event => event.logicalKey === payment.logicalKey), payment);
});
test('weekly cadence is anchored to its start and unaffected by daylight saving', () => {
  const def = definition(); def.rules[0].startsOn = '2024-02-28'; def.rules[0].cadence = { kind: 'weekly', every: 2 };
  const result = make('2024-03-01', '2024-03-31', def);
  assert.deepEqual(result.events.filter(event => event.entity === 'Invoice').map(event => event.txnDate), ['2024-03-13', '2024-03-27']);
});
test('stopping a rule retains its outstanding settlement after the end date', () => {
  const def = definition(); def.rules[0].endsOn = '2024-01-31';
  const result = make('2024-02-01', '2024-02-29', def);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].entity, 'Payment');
});
test('company, environment, rule and step distinguish logical identity; revisions change content only', () => {
  const original = make(); const def = definition(); def.rules[0].steps[0].intent.unitPriceCents = 12000;
  const changed = make(undefined, undefined, def);
  assert.equal(original.events[0].logicalKey, changed.events[0].logicalKey);
  assert.notEqual(original.events[0].fingerprint, changed.events[0].fingerprint);
  assert.notEqual(original.definitionHash, changed.definitionHash);
  assert.notEqual(original.events[0].logicalKey, make(undefined, undefined, definition(), { scope: { ...scope, environment: 'production' } }).events[0].logicalKey);
  assert.notEqual(original.events[0].logicalKey, make(undefined, undefined, definition(), { scope: { ...scope, realmId: '456' } }).events[0].logicalKey);
});
test('step array position is not record identity or content', () => {
  const def = definition(); const original = make();
  def.rules[0].steps.unshift({ key: 'time', entity: 'TimeActivity', offsetDays: 0, dependsOn: [], intent: { hours: 1 } });
  const changed = make(undefined, undefined, def);
  const invoice = changed.events.find(event => event.entity === 'Invoice');
  assert.equal(invoice.logicalKey, original.events[0].logicalKey);
  assert.equal(invoice.fingerprint, original.events[0].fingerprint);
});
test('invalid dates, future windows, scope and excessive budgets fail without partial output', () => {
  assert.throws(() => date('2026-02-29'), /Invalid/);
  assert.throws(() => make('2024-02-30'), /Invalid/);
  assert.throws(() => make('2024-01-01', '2026-12-31'), /elapsed period/);
  assert.throws(() => make(undefined, undefined, definition(), { scope: { ...scope, environment: 'other' } }), /company and environment/);
  assert.throws(() => make(undefined, undefined, definition(), { limit: 1 }), /budget exceeded/);
});
test('rejects duplicate keys, cycles, reversed dates and unlinked settlements', () => {
  for (const mutate of [
    def => def.rules.push(structuredClone(def.rules[0])),
    def => def.rules[0].steps[0].dependsOn.push('payment'),
    def => def.rules[0].steps[1].dependsOn.splice(0),
    def => { def.rules[0].steps[1].offsetDays = -1; },
    def => { def.rules[0].startsOn = '2023-12-31'; },
    def => { def.rules[0].cadence.every = 0; },
  ]) { const def = definition(); mutate(def); assert.throws(() => validateCalendarDefinition(def)); }
});
test('only matching verified receipts are reusable; sending and changed records block their dependents', () => {
  const result = make(); const event = result.events[0];
  assert.equal(reconcile(result, ledger(result, [receipt(event)])).actions[0].action, 'reuse');
  for (const extra of [{ state: 'sending' }, { fingerprint: 'different' }, { entity: 'Bill' }, { qboId: '' }]) {
    const checked = reconcile(result, ledger(result, [receipt(event, extra)]));
    assert.equal(checked.actions[0].action, 'blocked');
    assert.equal(checked.actions.find(action => action.logicalKey === result.events[1].logicalKey).action, 'blocked');
    assert.equal(checked.executable, false);
  }
});
test('prior-period obligations require exact verified originating receipts', () => {
  const result = make('2024-02-01', '2024-02-20');
  assert.equal(reconcile(result, ledger(result)).actions[0].action, 'blocked');
  assert.equal(reconcile(result, ledger(result, result.prerequisites.map(event => receipt(event)))).actions[0].action, 'create');
  assert.equal(reconcile(result, ledger(result, result.prerequisites.map(event => receipt(event, { fingerprint: 'wrong' })))).actions[0].action, 'blocked');
});
test('incomplete, wrong-scope, duplicate and incomplete-key lookups cannot prove absence', () => {
  const result = make(); const event = result.events[0];
  for (const change of [{ complete: false }, { scope: { ...scope, realmId: '456' } }, { requestedKeys: [] }, { records: [receipt(event), receipt(event)] }]) assert.throws(() => reconcile(result, { ...ledger(result), ...change }));
});
test('a no-activity window is not evidence that the business is complete', () => {
  const result = make('2024-01-01', '2024-01-10');
  assert.equal(result.events.length, 0); assert.equal(result.calendarVerified, false); assert.equal(result.executable, false);
});

test('transitive prior-period dependencies cannot bypass an uncertain originating record', () => {
  const def = definition(); def.rules[0].steps.push({ key: 'deposit', entity: 'Deposit', offsetDays: 30, dependsOn: ['payment'], intent: { bankKey: 'operating' } });
  const result = make('2024-03-01', '2024-03-01', def);
  const invoice = result.prerequisites.find(event => event.entity === 'Invoice');
  const payment = result.prerequisites.find(event => event.entity === 'Payment');
  assert.equal(result.events[0].entity, 'Deposit');
  for (const records of [[receipt(payment)], [receipt(payment), receipt(invoice, { state: 'sending' })], [receipt(payment), receipt(invoice, { fingerprint: 'different' })]]) {
    assert.equal(reconcile(result, ledger(result, records)).actions[0].action, 'blocked');
  }
  assert.equal(reconcile(result, ledger(result, [receipt(payment), receipt(invoice)])).actions[0].action, 'create');
});
test('revision comparison catches removed, renamed, moved and changed activities', () => {
  const { compareCalendarPlans } = require('../src/modules/business-calendar');
  const original = make();
  assert.equal(compareCalendarPlans(original, make()).requiresReview, false);
  const changed = definition(); changed.rules[0].steps[0].intent.unitPriceCents = 11000;
  assert.ok(compareCalendarPlans(original, make(undefined, undefined, changed)).changed.length);
  for (const mutate of [def => { def.rules[0].key = 'renamed-rule'; }, def => { def.rules[0].cadence.day = 30; }, def => { def.rules[0].endsOn = '2024-01-31'; }]) {
    const def = definition(); mutate(def);
    assert.ok(compareCalendarPlans(original, make(undefined, undefined, def)).removed.length);
  }
  assert.throws(() => compareCalendarPlans(original, make('2024-02-01')), /exact period/);
});
test('a saved plan must retain its original content before reconciliation', () => {
  const result = make(); result.events[0].txnDate = '2024-01-30';
  assert.throws(() => reconcile(result, ledger(result)), /saved calendar plan changed/);
});

test('an existing payment cannot be reused while recreating its missing invoice', () => {
  const result = make(); const payment = result.events.find(event => event.entity === 'Payment');
  const checked = reconcile(result, ledger(result, [receipt(payment)]));
  assert.equal(checked.actions.find(action => action.logicalKey === payment.logicalKey).action, 'blocked');
  assert.equal(checked.blocked, true);
});

test('distinct activity keys cannot claim the same physical record', () => {
  const result = make(); const invoices = result.events.filter(event => event.entity === 'Invoice');
  assert.throws(() => reconcile(result, ledger(result, invoices.slice(0, 2).map(event => receipt(event)))), /physical managed record/);
  const payment = result.events.find(event => event.entity === 'Payment');
  // IDs are scoped by entity type in QBO; this does not collide.
  assert.doesNotThrow(() => reconcile(result, ledger(result, [receipt(invoices[0]), receipt(payment)])));
});

test('large repeated intents stop at an explicit output-size budget', () => {
  const def = definition(); def.rules[0].cadence = { kind: 'weekly', every: 1 };
  def.rules[0].steps[0].intent.description = 'x'.repeat(200000);
  assert.throws(() => make('2024-01-01', '2024-12-31', def), /output size budget/);
});
