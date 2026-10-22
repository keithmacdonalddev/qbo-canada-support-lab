import test from 'node:test'
import assert from 'node:assert/strict'
import { companyProgress, readCompanyProgress } from '../src/lib/company-progress.mjs'
const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) }
const governance = { ...scope, published: {}, calendar: { verifiedThrough: null }, pendingOperations: [] }
const job = { scope, status: 'populated', fromDate: '2026-09-01', throughDate: '2026-09-30', counts: { required: 100, saved: 100, rejected: 0, unknown: 0, coverageGaps: 0, verificationErrors: 0 } }
const observation = { scope, id: 'b'.repeat(24), evidenceHash: 'c'.repeat(64), accepted: false, activated: false, purpose: 'company-survey', period: { fromDate: '2026-09-01', throughDate: '2026-09-30' }, observedAt: '2026-10-01T12:00:00Z', evaluation: { checks: [{ key: 'balance', status: 'passed' }], reportCoverage: { complete: true } } }
const view = overrides => companyProgress({ governance, population: { scope, job }, observation, today: '2026-10-22', ...overrides })
test('complete records and passing reports do not certify the calendar', () => {
  const result = view(); assert.equal(result.records.date, '2026-09-30'); assert.equal(result.books.date, '2026-09-30'); assert.equal(result.verified, null); assert.equal(result.action.label, 'Review business calendar')
})
test('partial schedules never promote their target date to prepared through', () => {
  const result = view({ population: { job: { ...job, status: 'stopped', counts: { ...job.counts, saved: 5 } } } }); assert.equal(result.records.date, null); assert.match(result.records.detail, /incomplete/); assert.equal(result.action.target, 'business-population')
})
test('unknown outcomes and active work precede report and generation actions', () => {
  for (const change of [{ status: 'running' }, { batch: { state: 'unknown' } }, { counts: { ...job.counts, unknown: 1 } }, { counts: { ...job.counts, coverageGaps: 2 } }]) assert.equal(view({ population: { job: { ...job, ...change } } }).action.target, 'business-population')
})
test('current operation precedes missing report evidence', () => { assert.equal(view({ governance: { ...governance, currentOperation: { status: 'blocked' } }, observation: null }).action.label, 'Review current operation') })
test('empty, incomplete, failed, old and opening observations request report evidence', () => {
  for (const saved of [null, { ...observation, evaluation: { checks: [] } }, { ...observation, evaluation: { ...observation.evaluation, checks: [{ status: 'failed' }] } }, { ...observation, period: { ...observation.period, throughDate: '2026-09-15' } }, { ...observation, purpose: 'opening-balances' }]) assert.equal(view({ observation: saved }).action.target, 'business-observations')
})
test('existing preview is preferred to preparing another period', () => { assert.equal(view({ governance: { ...governance, calendar: { verifiedThrough: '2026-09-30' }, pendingOperations: [{}] } }).action.label, 'Review the prepared operation') })
test('only a verified calendar permits next-period guidance', () => { assert.equal(view({ governance: { ...governance, calendar: { verifiedThrough: '2026-09-30' } } }).action.label, 'Prepare the next business period') })
test('unpublished business directs to preparation', () => { assert.equal(view({ governance: { ...governance, published: null } }).action.label, 'Review company preparation') })
function apiFor(change = {}) {
  const calls = []
  return { calls, get: async (path, options) => {
    calls.push({ path, options })
    const values = { '/company/business-governance': governance, '/business-population': { scope, job }, '/company/business-baseline': { scope, records: [observation] }, ['/company/business-baseline/' + observation.id]: observation, ...change }
    if (values[path] instanceof Error) throw values[path]
    return { data: { data: values[path] } }
  } }
}
test('reads only saved scoped evidence and inspects the latest exact observation', async () => {
  const api = apiFor(), signal = new AbortController().signal, result = await readCompanyProgress(api, scope, signal)
  assert.equal(result.observation, observation); assert.equal(api.calls.length, 4); assert.ok(api.calls.every(call => call.options.signal === signal && call.options.timeout === 15000)); assert.deepEqual(api.calls.find(call => call.path === '/company/business-baseline').options.params, { limit: 1 })
})
test('empty observations need no detail read', async () => { const api = apiFor({ '/company/business-baseline': { scope, records: [] } }); assert.equal((await readCompanyProgress(api, scope)).observation, null); assert.equal(api.calls.length, 3) })
test('cross-company, changed connection, changed evidence and failed sources fail closed', async () => {
  for (const change of [
    { '/company/business-governance': { ...governance, realmId: '456' } },
    { '/business-population': { scope: { ...scope, connectionId: 'd'.repeat(24) }, job } },
    { '/business-population': { scope, job: { ...job, scope: { ...scope, environment: 'production' } } } },
    { ['/company/business-baseline/' + observation.id]: { ...observation, evidenceHash: 'e'.repeat(64) } },
    { '/company/business-baseline': new Error('Unavailable') },
  ]) await assert.rejects(readCompanyProgress(apiFor(change), scope))
})

test('newly published business prepares its first period instead of checking nonexistent activity', () => {
  for (const saved of [null, { ...observation, purpose: 'opening-balances' }, observation]) assert.equal(view({ population: { scope, job: null }, observation: saved }).action.label, 'Prepare the first business period')
  assert.equal(view({ population: { scope, job: null }, observation: null, governance: { ...governance, pendingOperations: [{}] } }).action.label, 'Review the prepared operation')
})
