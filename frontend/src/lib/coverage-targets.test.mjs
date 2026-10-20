import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { filterTargets, matchesScope, recordEvidence, savedComparison, targetGroups } from './coverage-targets.mjs'
const catalog = JSON.parse(await readFile(new URL('../../../docs/discovery/catalog.v1.json', import.meta.url), 'utf8'))

test('every canonical capability is reachable once, with app operations separated', () => {
  const groups = targetGroups(catalog)
  const keys = groups.flatMap(g => g.capabilities.map(c => c.key))
  assert.deepEqual([...keys].sort(), catalog.capabilities.map(c => c.key).sort())
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual(groups.filter(g => g.internal).flatMap(g => g.keys), ['reporting.reports-api', 'administration.api-budgets', 'administration.full-pagination'])
})
test('report navigation retains the entire source catalog and its linked requirements', () => {
  assert.deepEqual(filterTargets(catalog.reports, '', 'all', 'all', 'report'), catalog.reports)
  for (const c of catalog.capabilities) for (const key of c.linkedReports) assert.ok(catalog.reports.some(r => r.key === key), key)
  assert.ok(filterTargets(catalog.reports, 'cash', 'all', 'all', 'report').some(r => r.key === 'report.cash-flow'))
})
test('variant search and group/priority filters compose without losing required variations', () => {
  assert.ok(filterTargets(catalog.capabilities, 'reversal').some(c => c.key === 'accounting.journals-and-close'))
  assert.deepEqual(filterTargets(catalog.capabilities, '', 'operations').map(c => c.key).sort(), ['administration.api-budgets', 'administration.full-pagination', 'reporting.reports-api'])
  assert.ok(filterTargets(catalog.capabilities, '', 'books', 'manual-only-critical').every(c => c.tier === 'manual-only-critical'))
})
test('positive, old, missing and manual record observations never certify intended coverage', () => {
  const result = { areas: [{ key: 'x', signals: [
    { key: 'invoice', label: 'Invoices', status: 'ok' },
    { key: 'old', label: 'Credits', status: 'stale', count: 1 },
    { key: 'missing', label: 'Refunds', status: 'missing' },
    { key: 'manual', label: 'Reconciliation', status: 'manual' },
  ] }] }
  const evidence = recordEvidence(result, ['x'])
  assert.equal(evidence.available.length, 2)
  assert.equal(evidence.missing.length, 1)
  assert.equal(evidence.unresolved.length, 1)
  assert.equal(evidence.coverageVerdict, 'unassessed')
  assert.equal(recordEvidence(null, ['x']).observed, false)
  assert.equal(recordEvidence(result, ['another-company-area']).observed, false)
})
test('saved evidence requires the same realm, environment and connection', () => {
  const scope = { realmId: 'test-realm', environment: 'production', connectionId: 'connection-a' }
  assert.equal(matchesScope({ ...scope }, scope), true)
  for (const key of Object.keys(scope)) assert.equal(matchesScope({ ...scope, [key]: 'changed' }, scope), false)
  assert.equal(matchesScope(null, scope), false)
  assert.equal(matchesScope({}, {}), false)
})
test('saved draft, publication and managed period are distinct evidence', () => {
  const draft = { connectionMatches: true, contentHash: 'new-draft', business: { historicalMonths: 24 } }
  const governance = { published: { blueprintHash: 'old-draft' }, calendar: { verifiedThrough: '2026-09-30' } }
  assert.equal(savedComparison({ draft }, governance).draftIsPublished, false)
  assert.equal(savedComparison({ draft }, { ...governance, published: { blueprintHash: 'new-draft' } }).draftIsPublished, true)
  assert.equal(savedComparison({ draft: { ...draft, connectionMatches: false } }, governance).draft, null)
  assert.equal(savedComparison({ proposal: { business: { historicalMonths: 36 } } }, null).draft, null)
})
