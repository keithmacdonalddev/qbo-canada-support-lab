'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOperationRequest, operationHistoryRoots, attachPreparedOperationHistory } = require('../src/modules/business-operation-preview');
const { hash } = require('../src/modules/business-calendar');
const { fixture } = require('./helpers/business-preparation-fixture');
test('preparation resolves observed IDs and versions but never approves execution or assumes missing transactions', () => {
  const f = fixture(), result = f.prepare();
  assert.equal(result.summary.steps, 55); assert.equal(result.readyToExecute, false); assert.equal(result.persisted, false);
  assert.ok(result.steps.flatMap(step => step.references).some(reference => reference.status === 'resolved' && reference.syncToken === '0'));
  assert.ok(result.steps.flatMap(step => step.references).filter(reference => reference.entity === 'TaxCode').every(reference => reference.status === 'review_required'));
  assert.ok(result.remaining.some(item => item.key === 'baseline'));
  assert.ok(result.steps.every(step => !Object.hasOwn(step, 'action')));
});
test('earlier dependencies remain evidence requirements and all current dependencies precede their children', () => {
  const result = fixture().prepare(), positions = new Map(result.steps.map((step, index) => [step.logicalKey, index]));
  const previous = new Set(result.earlierRequirements.map(row => row.logicalKey));
  for (const [index, step] of result.steps.entries()) for (const parent of step.dependencies) {
    if (parent.source === 'this_operation') assert.ok(positions.get(parent.logicalKey) < index);
    else assert.ok(previous.has(parent.logicalKey));
  }
  assert.ok(result.earlierRequirements.length > 0);
  assert.ok(result.steps.some(step => step.blockers.some(blocker => blocker.kind === 'blocked_dependency')));
});
test('receivables, payables and undeposited funds bind the exact saved account on relevant steps', () => {
  const f = fixture(), result = f.prepare();
  const seen = new Set();
  for (const step of result.steps) {
    const required = [];
    if (['Invoice', 'Payment'].includes(step.entity)) required.push('accountsReceivable');
    if (['PurchaseOrder', 'Bill', 'BillPayment'].includes(step.entity)) required.push('accountsPayable');
    if (step.details.destination === 'undeposited_funds' || step.entity === 'Deposit') required.push('undepositedFunds');
    for (const key of required) {
      seen.add(step.entity + ':' + key);
      assert.ok(step.references.some(ref => ref.key === key && ref.id === f.view.draft.mappings[key] && ref.status === 'resolved' && ref.syncToken === '0'), step.entity + ':' + key);
    }
    if (['SalesReceipt', 'Estimate', 'TimeActivity'].includes(step.entity)) assert.ok(!step.references.some(ref => ref.key === 'accountsReceivable'));
  }
  for (const pair of ['Invoice:accountsReceivable', 'Payment:accountsReceivable', 'PurchaseOrder:accountsPayable', 'Bill:accountsPayable', 'BillPayment:accountsPayable', 'Payment:undepositedFunds', 'Deposit:undepositedFunds']) assert.ok(seen.has(pair), pair);
});
test('unassigned, incompatible and unversioned control accounts remain operation blockers', () => {
  for (const key of ['accountsReceivable', 'accountsPayable', 'undepositedFunds']) {
    for (const [status, mutate] of [
      ['unassigned', f => { delete f.view.draft.mappings[key]; }],
      ['incompatible', f => { f.setup.options.accounts.find(row => row.id === f.view.draft.mappings[key]).subtype = 'OtherCurrentAssets'; }],
      ['unverified', f => { f.setup.options.accounts.find(row => row.id === f.view.draft.mappings[key]).syncToken = null; }],
    ]) {
      const f = fixture(); mutate(f);
      const steps = f.prepare().steps.filter(step => step.references.some(ref => ref.key === key));
      assert.ok(steps.length);
      for (const step of steps) {
        assert.equal(step.references.find(ref => ref.key === key).status, status);
        assert.ok(step.blockers.some(blocker => blocker.kind === 'record_choice' && blocker.key === key));
        assert.equal(step.status, 'blocked');
      }
    }
  }
});
test('missing record versions remain unverified even when observed structural fields match', () => {
  for (const token of [null, '', ' ', 'false', '[object Object]', '-1', '0.1', '1e3', '01', true, {}, '9'.repeat(65)]) {
    const f = fixture(); for (const record of f.masters.options.Customer) record.syncToken = token;
    const references = f.prepare().steps.flatMap(step => step.references).filter(reference => reference.entity === 'Customer');
    assert.ok(references.length > 0); assert.ok(references.every(reference => reference.status === 'unverified'));
  }
});
test('stale observations, changed company and unsupported periods fail before a review can be produced', () => {
  for (const mutate of [
    f => { f.setup.observedAt = '2026-10-06T11:54:59Z'; }, f => { f.masters.observedAt = '2026-10-06T12:00:01Z'; },
    f => { f.setup.realmId = '456'; }, f => { f.masters.sourceHash = ''; }, f => { f.input.baseHash = 'c'.repeat(64); },
  ]) { const f = fixture(); mutate(f); assert.throws(() => f.prepare(), error => error.status === 409); }
  for (const input of [{ ...fixture().input, fromDate: '2026-08-01' }, { ...fixture().input, baselineApproved: true }]) assert.throws(() => validateOperationRequest(input), error => error.status === 400);
});
test('operation fingerprint binds exact choices, versions, economics and company observations', () => {
  const f = fixture(), first = f.prepare(); assert.deepEqual(first, f.prepare());
  f.masters.sourceHash = hash('changed-source'); assert.notEqual(first.operationHash, f.prepare().operationHash);
  f.masters.sourceHash = hash('masters'); f.masters.options.Customer[0].syncToken = '1';
  assert.notEqual(first.operationHash, f.prepare().operationHash);
});

test('history projection uses original dependency fingerprints and keeps current readback unresolved', () => {
  const prepared = fixture().prepare(), roots = operationHistoryRoots(prepared), current = new Set(prepared.steps.map(step => step.logicalKey));
  const key = roots.find(value => !current.has(value)), earlier = prepared.earlierRequirements.find(row => row.logicalKey === key);
  const oldAncestor = { logicalKey: hash('original ancestor'), entity: 'Estimate', txnDate: '2026-09-01', dependencies: [] };
  const originalStep = { ...earlier, dependencies: [{ logicalKey: oldAncestor.logicalKey, entity: oldAncestor.entity, fingerprint: hash(oldAncestor) }], privateOriginalField: 'never public' };
  const wrap = step => ({ logicalKey: step.logicalKey, entity: step.entity, fingerprint: hash(step), operationId: 'e'.repeat(24), planHash: hash('old operation'), state: 'verified', qboId: '2000', step, policy: { privateOriginalPolicy: 'never public' } });
  const source = { version: 1, scope: prepared.scope, roots, entries: [wrap(oldAncestor), wrap(originalStep)], missing: roots.filter(value => value !== key), observedAt: '2026-10-06T12:00:00.000Z', requiresCurrentReadback: true };
  const result = attachPreparedOperationHistory(prepared, { ...source, sourceHash: hash(source) });
  const links = result.steps.flatMap(step => step.dependencies).filter(link => link.logicalKey === key); assert.ok(links.length); assert.ok(links.every(link => link.fingerprint === hash(originalStep)));
  assert.ok(result.earlierRequirements.some(row => row.logicalKey === oldAncestor.logicalKey));
  assert.ok(result.steps.some(step => step.blockers.some(blocker => blocker.kind === 'prior_record' && blocker.key === key)));
  assert.equal(result.savedHistory.currentReadback, false); assert.equal(result.savedHistory.provesAbsence, false); assert.equal(result.readyToExecute, false);
  assert.equal(JSON.stringify(result).includes('never public'), false);
  const { operationHash, preparedAt, readyToExecute, persisted, summary, limitations, ...payload } = result; assert.equal(operationHash, hash(payload));
});
