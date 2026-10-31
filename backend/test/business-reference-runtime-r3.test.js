'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, scope, now, clone } = require('./helpers/business-transaction-fixtures');
const { hash } = require('../src/modules/business-calendar');
const { referenceDefinition, matchesReferenceDefinition, verifyBusinessReference, createBusinessReferenceReader } = require('../src/modules/business-reference');
const { compileBusinessTransactionWithDefinitions } = require('../src/modules/business-transaction-compiler');
const { executionDiagnostic } = require('../src/modules/business-execution-diagnostic');
function legacy() {
  const f = fixture('Estimate'), current = f.referenceEvidence.find(row => row.entity === 'Item');
  current.record.IncomeAccountRef.name = 'Approved display';
  const original = clone(current), binding = f.step.references.find(row => row.entity === 'Item' && row.id === current.record.Id);
  binding.definition = referenceDefinition(scope, 'Item', original.record, 1);
  delete current.record.IncomeAccountRef.name; f.refresh(); f.approve();
  original.recordHash = hash(original.record); original.source.recordHash = original.recordHash;
  original.observedAt = new Date(now - 86400000).toISOString();
  original.source = { version: 1, kind: 'qbo-retained-mirror', scope, entity: 'Item', id: original.record.Id, recordHash: original.recordHash, generation: 'retained', retainedAt: original.observedAt };
  return { f, current, binding, original };
}
test('every runtime compile resolves missing retained evidence centrally without changing its inputs or hashes', async () => {
  const { f, current, binding, original } = legacy(), before = JSON.stringify(f); let calls = 0;
  const compiled = await compileBusinessTransactionWithDefinitions(f, { resolveDefinitionObservation: async (selected, entity, id, options) => { calls++; assert.deepEqual(selected, scope); assert.equal(entity, 'Item'); assert.equal(id, binding.id); assert.deepEqual(options.definition, binding.definition); return original; } });
  assert.equal(compiled.entity, 'Estimate'); assert.equal(calls, 1); assert.equal(JSON.stringify(f), before);
  const again = await compileBusinessTransactionWithDefinitions(f, { resolveDefinitionObservation: async () => original });
  assert.equal(again.compilationHash, compiled.compilationHash);
  assert.equal(verifyBusinessReference({ scope, binding, observed: current, now, resolveDefinitionObservation: () => original }), current.record);
  assert.equal(matchesReferenceDefinition(scope, 'Item', current.record, binding.definition, null, now, () => original), true);
});
test('missing, tampered, foreign, wrong-ID or genuinely changed definitions still refuse centrally', async () => {
  for (const change of [o => null, o => { o.scope = { ...scope, realmId: '999' }; return o; }, o => { o.record.Id = '777'; o.recordHash = hash(o.record); o.source.recordHash = o.recordHash; o.source.id = '777'; return o; }, o => { o.recordHash = hash('tampered'); return o; }, o => { o.record.IncomeAccountRef.value = '999'; o.recordHash = hash(o.record); o.source.recordHash = o.recordHash; return o; }]) {
    const { f, original } = legacy(); await assert.rejects(compileBusinessTransactionWithDefinitions(f, { resolveDefinitionObservation: async () => change(clone(original)) }), { code: 'BUSINESS_REFERENCE_UNVERIFIED' });
  }
  const { f, original, current } = legacy(); current.record.IncomeAccountRef.value = '999'; f.refresh();
  await assert.rejects(compileBusinessTransactionWithDefinitions(f, { resolveDefinitionObservation: async () => original }), error => error.referenceDiagnostic.observationSource === 'live' && error.referenceDiagnostic.definitionVersion === 1 && error.referenceDiagnostic.definitionObservationPresent === false && error.referenceDiagnostic.retainedDefinitionResolved === true);
});
test('a nonmatching supplied witness can use the exact retained approval, never the reverse', async () => {
  const { f, original, current } = legacy(); current.definitionObservation = clone(current);
  assert.equal((await compileBusinessTransactionWithDefinitions(f, { resolveDefinitionObservation: async () => original })).entity, 'Estimate');
});
test('central resolver observes cancellation and rechecks freshness after lookup', async () => {
  const { f, original } = legacy(), controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(compileBusinessTransactionWithDefinitions(f, { signal: controller.signal, resolveDefinitionObservation: async () => { calls++; return original; } }), /cancelled/); assert.equal(calls, 0);
  let clock = now; await assert.rejects(compileBusinessTransactionWithDefinitions(f, { clock: () => clock, resolveDefinitionObservation: async () => { clock += 300001; return original; } }), /current|fresh/);
});
test('cached reference reads retain historical definition evidence without a live call', async () => {
  const { current, original, binding } = legacy(), cached = clone(current);
  cached.source = { version: 1, kind: 'qbo-current-mirror', scope, entity: 'Item', id: binding.id, recordHash: cached.recordHash, generation: 'current', completedAt: new Date(now - 1000).toISOString(), freshUntil: new Date(now + 60000).toISOString() };
  const reader = createBusinessReferenceReader({ authorize: async () => ({ actorId: 'reader' }), resolveClient: async () => { throw Error('No live calls'); }, now: () => now, observationStore: { read: async () => cached, definition: async () => original } });
  const observed = await reader(scope, 'Item', binding.id);
  assert.equal(observed.source.kind, 'qbo-current-mirror'); assert.equal(verifyBusinessReference({ scope, binding, observed, now }).Id, binding.id);
});
test('execution diagnostic keeps only bounded file locations and allowlisted reference facts', () => {
  const error = new Error('record contents and token must not be saved');
  error.stack = 'Error: SECRET record contents\n    at fail (C:/Projects/qbo/backend/src/modules/business-reference.js:14:44)\n    at /tmp/fixture.js:22:7\n    at https://secret.invalid/token.js:1:2\nraw SECRET\n' + '    at /tmp/test.js:1:2\n'.repeat(300);
  error.referenceDiagnostic = { observationSource: 'live', definitionVersion: 1, definitionObservationPresent: false, retainedDefinitionResolved: true, record: 'SECRET' };
  const value = executionDiagnostic(error); assert.ok(value.stack.length <= 2000); assert.match(value.stack, /business-reference.js:14:44/); assert.equal(/SECRET|secret.invalid|at fail|Error:/.test(JSON.stringify(value)), false);
  assert.deepEqual(executionDiagnostic({ diagnostic: value }), value);
});

test('resolver rejection preserves reference diagnostic context', async () => {
  const { f } = legacy(); await assert.rejects(compileBusinessTransactionWithDefinitions(f, { resolveDefinitionObservation: async () => { throw Error('Private database failure'); } }), error => error.referenceDiagnostic.observationSource === 'live' && error.referenceDiagnostic.definitionVersion === 1 && error.referenceDiagnostic.definitionObservationPresent === false);
});
test('optional historical lookup failure leaves a valid cached v2 reference usable', async () => {
  const { f, current } = legacy(), binding = f.step.references.find(row => row.entity === 'Item' && row.id === current.record.Id); binding.definition = referenceDefinition(scope, 'Item', current.record);
  const cached = clone(current); cached.source = { version: 1, kind: 'qbo-current-mirror', scope, entity: 'Item', id: binding.id, recordHash: cached.recordHash, generation: 'current', completedAt: new Date(now - 1000).toISOString(), freshUntil: new Date(now + 60000).toISOString() };
  const reader = createBusinessReferenceReader({ authorize: async () => ({ actorId: 'reader' }), resolveClient: async () => { throw Error('No live calls'); }, now: () => now, observationStore: { read: async () => cached, definition: async () => { throw Error('optional unavailable'); } } });
  const observed = await reader(scope, 'Item', binding.id); assert.equal(verifyBusinessReference({ scope, binding, observed, now }).Id, binding.id);
});

test('cached reference reauthorizes after its retained-definition lookup', async () => {
  const { current, original, binding } = legacy(), cached = clone(current);
  cached.source = { version: 1, kind: 'qbo-current-mirror', scope, entity: 'Item', id: binding.id, recordHash: cached.recordHash, generation: 'current', completedAt: new Date(now - 1000).toISOString(), freshUntil: new Date(now + 60000).toISOString() };
  let actorId = 'reader';
  const reader = createBusinessReferenceReader({ authorize: async () => ({ actorId }), resolveClient: async () => { throw Error('No live calls'); }, now: () => now, observationStore: { read: async () => cached, definition: async () => { actorId = 'replacement'; return original; } } });
  await assert.rejects(reader(scope, 'Item', binding.id), /reader changed/);
});
