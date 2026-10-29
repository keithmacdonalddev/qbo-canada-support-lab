import test from 'node:test'
import assert from 'node:assert/strict'
import { businessPromises, correctPromise, featuresPromise, runningPromise } from '../src/lib/business-promises.mjs'

const now = Date.parse('2026-10-28T18:00:00Z')
const ago = minutes => new Date(now - minutes * 60000).toISOString()
const healthy = {
  settings: { monitoring: true, autonomous: true, decisionIntervalMinutes: 60, syncIntervalSeconds: 30 },
  agent: { status: 'ready', lastDecisionAt: ago(12), nextDecisionAt: new Date(now + 48 * 60000).toISOString() },
  sync: { status: 'current', lastSuccessAt: ago(0.2), sources: [{ entity: 'Invoice', status: 'current', complete: true, lastSuccessAt: ago(0.2) }, { entity: 'Bill', status: 'current', complete: true, lastSuccessAt: ago(0.2) }] },
  business: { blockers: [], verifiedThrough: '2026-10-27' },
}
const coverage = status => ({ areas: [{ signals: [{ key: 'invoices', label: 'Invoices', status: 'ok' }, { key: 'refunds', label: 'Refund receipts', status }] }] })

test('a healthy operator keeps the running and correctness promises', () => {
  assert.equal(runningPromise(healthy, now).state, 'kept')
  const correct = correctPromise(healthy, now)
  assert.equal(correct.state, 'kept')
  assert.match(correct.detail, /All 2 record types/)
})

test('running breaks when monitoring is off, paused, failing or overdue', () => {
  assert.equal(runningPromise({ ...healthy, settings: { ...healthy.settings, monitoring: false } }, now).verdict, 'Not running')
  assert.equal(runningPromise({ ...healthy, settings: { ...healthy.settings, autonomous: false } }, now).verdict, 'Paused')
  assert.equal(runningPromise({ ...healthy, agent: { ...healthy.agent, lastError: 'AI key rejected' } }, now).detail, 'AI key rejected')
  assert.equal(runningPromise({ ...healthy, agent: { ...healthy.agent, lastDecisionAt: ago(200) } }, now).verdict, 'Overdue')
})

test('correctness breaks on blockers or unreadable sources', () => {
  assert.equal(correctPromise({ ...healthy, business: { blockers: [{ title: 'A write is unresolved' }] } }, now).detail, 'A write is unresolved')
  const failing = { ...healthy, sync: { ...healthy.sync, sources: [{ entity: 'Bill', status: 'error', error: 'Timed out' }] } }
  assert.equal(correctPromise(failing, now).state, 'broken')
})

test('features report unused ones and stay honest when never checked', () => {
  assert.equal(featuresPromise(null).state, 'unknown')
  assert.equal(featuresPromise(coverage('ok')).state, 'kept')
  const stale = featuresPromise(coverage('stale'))
  assert.equal(stale.state, 'attention')
  assert.equal(stale.verdict, '1 of 2 in use')
  assert.match(stale.detail, /Refund receipts/)
})

test('the headline names the broken promise first', () => {
  assert.equal(businessPromises(healthy, coverage('ok'), now).headline, '3 of 4 promises are holding.')
  const paused = businessPromises({ ...healthy, settings: { ...healthy.settings, autonomous: false } }, coverage('ok'), now)
  assert.equal(paused.tone, 'broken')
  assert.equal(paused.headline, 'The business is paused.')
})
