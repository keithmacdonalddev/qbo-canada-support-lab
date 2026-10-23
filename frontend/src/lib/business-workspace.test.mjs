import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceScope, syncPresentation, recordLink, countValue, ageLabel } from './business-workspace.mjs'
const scope = { realmId: '123456789', environment: 'production', connectionId: '123456789012345678901234' }
const now = Date.parse('2026-10-23T15:00:00.000Z')
const settings = { monitoring: true, syncIntervalSeconds: 30 }
const current = { status: 'current', lastSuccessAt: '2026-10-23T14:59:45.000Z', sources: [{ entity: 'Invoice', complete: true, status: 'current' }] }
test('only the exact selected company and valid saved revision can drive controls', () => {
  const value = { scope, revision: 2 }; assert.equal(workspaceScope(value, scope), value)
  for (const changed of [{ ...scope, realmId: '987654321' }, { ...scope, connectionId: 'abcdefabcdefabcdefabcdef' }, { ...scope, environment: 'sandbox' }]) assert.throws(() => workspaceScope({ scope: changed, revision: 2 }, scope), /company changed/)
  assert.throws(() => workspaceScope({ scope, revision: -1 }, scope), /company changed/)
  assert.throws(() => workspaceScope({ scope: {}, revision: 0 }, {}), /connected company/)
})
test('fresh complete source evidence earns a current label', () => {
  assert.equal(syncPresentation(current, settings, now).tone, 'good')
  assert.equal(syncPresentation(current, settings, now).label, 'Monitoring current')
})
test('partial, absent or unknown source state cannot borrow another source success', () => {
  for (const sources of [[], [{ entity: 'Invoice', status: 'unknown' }], [{ entity: 'Invoice', complete: true }, { entity: 'Payment', complete: false }]]) assert.notEqual(syncPresentation({ ...current, sources }, settings, now).tone, 'good')
  assert.notEqual(syncPresentation({ ...current, sources: [{ entity: 'Invoice', complete: true, status: 'saturated' }] }, settings, now).tone, 'good')
})
test('a source failure, expired observation or stopped monitoring stays visible', () => {
  assert.equal(syncPresentation({ ...current, status: 'error' }, settings, now).tone, 'attention')
  assert.equal(syncPresentation({ ...current, lastSuccessAt: '2026-10-23T14:50:00.000Z' }, settings, now).label, 'Data needs refreshing')
  assert.equal(syncPresentation(current, { ...settings, monitoring: false }, now).label, 'Monitoring off')
  assert.notEqual(syncPresentation({ ...current, lastSuccessAt: '2026-10-23T16:00:00.000Z' }, settings, now).tone, 'good')
})
test('record journeys only use local explorer destinations', () => {
  assert.equal(recordLink({ entity: 'Invoice', qboId: '123' }), '/explorer?type=Invoice&id=123')
  assert.equal(recordLink({ entity: 'https://outside.example', qboId: '123' }), '/explorer')
  assert.equal(recordLink({ entity: 'Invoice', qboId: '1&outside=true' }), '/explorer')
})
test('unknown counts and timestamps are represented honestly', () => {
  assert.equal(countValue({}, 'customers', 'Customer'), '—')
  assert.equal(countValue({ Customer: { count: 0 } }, 'customers', 'Customer'), '0')
  assert.equal(ageLabel(undefined, now), 'Not yet observed')
  assert.equal(ageLabel('2026-10-23T14:59:00.000Z', now), '1m ago')
})
