import test from 'node:test'
import assert from 'node:assert/strict'
import { captureBaseline, baselineRequestKey, pendingBaselineRequest, assertBaselineScope } from '../src/lib/business-baseline-request.mjs'
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, actor = 'b'.repeat(24)
const request = { connectionId: scope.connectionId, blueprintId: 'c'.repeat(24), blueprintHash: 'd'.repeat(64), purpose: 'company-survey', fromDate: '2026-10-01', throughDate: '2026-10-06' }
function fixture() {
  const values = new Map(), h = { calls: [], values }
  h.storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  h.key = baselineRequestKey(actor, scope)
  h.api = { post: async (path, input) => { h.calls.push({ path, input: structuredClone(input) }); if (h.failure) throw h.failure; return { data: { data: { scope: h.scope || scope, id: 'e'.repeat(24), status: 'captured', persisted: true, accepted: false, activated: false, blueprint: { id: input.blueprintId, contentHash: input.blueprintHash }, purpose: input.purpose, period: { fromDate: input.fromDate, throughDate: input.throughDate }, evidenceHash: 'f'.repeat(64) } } } } }
  h.capture = input => captureBaseline({ api: h.api, storage: h.storage, key: h.key, scope, request: input || request, newKey: () => 'baseline-test-request-001' })
  return h
}
test('lost acknowledgement survives refresh with identical scoped request and clears only after confirmation', async () => {
  const h = fixture(); h.failure = new Error('network lost'); await assert.rejects(h.capture());
  const old = pendingBaselineRequest(h.storage, h.key, scope); assert.equal(old.requestKey, 'baseline-test-request-001')
  h.failure = null; const result = await h.capture({ ...request, throughDate: '2026-10-05' }); assert.equal(result.period.throughDate, request.throughDate); assert.deepEqual(h.calls[0].input, h.calls[1].input); assert.equal(h.values.size, 0)
})
test('invalid dates can be corrected before persistence or provider access', async () => {
  const h = fixture(); for (const changes of [{ fromDate: '2024-01-01' }, { fromDate: '2026-02-30' }, { throughDate: '2026-09-01' }]) await assert.rejects(h.capture({ ...request, ...changes }));
  assert.equal(h.calls.length, 0); assert.equal(h.values.size, 0); await h.capture(); assert.equal(h.calls.length, 1)
})
test('only explicit pre-save validation rejection releases a pending request for correction', async () => {
  const h = fixture(); h.failure = { response: { status: 400, data: { code: 'BUSINESS_BASELINE_REQUEST_INVALID', notSaved: true } } }; await assert.rejects(h.capture()); assert.equal(h.values.size, 0)
  h.failure = null; await h.capture(); assert.equal(h.values.size, 0)
  for (const response of [{ status: 400, data: { code: 'BUSINESS_BASELINE_UNVERIFIED' } }, { status: 409, data: { code: 'BUSINESS_BASELINE_REQUEST_INVALID', notSaved: true } }, { status: 500, data: {} }]) { const g = fixture(); g.failure = { response }; await assert.rejects(g.capture()); assert.equal(g.values.size, 1) }
})
test('scope and stored-request corruption never clear uncertain evidence or submit another request', async () => {
  const h = fixture(); h.scope = { ...scope, realmId: '456' }; await assert.rejects(h.capture(), /company changed/); assert.equal(h.values.size, 1)
  h.values.set(h.key, '{}'); await assert.rejects(h.capture(), /needs review/); assert.equal(h.calls.length, 1)
  assert.notEqual(baselineRequestKey('c'.repeat(24), scope), h.key)
  assert.throws(() => assertBaselineScope({ scope }, '456', scope.environment), /company changed/)
})
test('unavailable browser storage prevents dispatch instead of losing retry identity', async () => {
  const h = fixture(); h.storage.setItem = () => { throw new Error('storage unavailable') }; await assert.rejects(h.capture(), /storage/); assert.equal(h.calls.length, 0)
})
