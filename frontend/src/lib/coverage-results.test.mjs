import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { featureCoverage, featureTotals, historyCoverage, readReportPages, reportCoverage, VARIANT_EVIDENCE } from './coverage-results.mjs'
const catalog = JSON.parse(await readFile(new URL('../../../docs/discovery/catalog.v1.json', import.meta.url), 'utf8'))
const definition = catalog.reports.find(r => r.key === 'report.balance-sheet')
const scope = { realmId: 'company-a', environment: 'production', connectionId: 'connection-a' }
const snapshot = signals => ({ areas: [{ key: 'sales.receivables-lifecycle', signals }] })
test('each canonical business variation has exactly one result; app infrastructure is excluded', () => {
  const rows = featureCoverage(catalog, null), totals = featureTotals(rows)
  assert.equal(rows.length, 21)
  assert.equal(totals.required, catalog.capabilities.filter(c => rows.some(r => r.key === c.key)).reduce((n,c) => n + c.variants.length, 0))
  assert.equal(totals.unverified, totals.required)
  assert.equal(totals.represented, 0)
  for (const [key, variants] of Object.entries(VARIANT_EVIDENCE)) for (const name of Object.keys(variants)) assert.ok(catalog.capabilities.find(c => c.key === key)?.variants.includes(name), key + ':' + name)
})
test('record observations do not imply settlement, late payment, deposits or voids', () => {
  const rows = featureCoverage(catalog, snapshot([{ key: 'payments', label: 'Customer payments', status: 'ok' }, { key: 'overdue-invoices', label: 'Overdue invoices', status: 'ok' }, { key: 'partly-paid-invoices', label: 'Partly paid invoices', status: 'stale', count: 1 }]))
  const sales = rows.find(r => r.key === 'sales.receivables-lifecycle')
  assert.equal(sales.represented.length, 1)
  assert.equal(sales.represented[0].name, 'Partial payment')
  assert.equal(sales.represented[0].older, true)
  for (const name of ['Full payment', 'Late payment', 'Deposit', 'Void']) assert.equal(sales.variants.find(v => v.name === name).status, 'unverified')
})
test('missing and unverified remain distinct at variation and area levels', () => {
  const sales = featureCoverage(catalog, snapshot([{ key: 'credit-memos', label: 'Credit memos', status: 'missing', count: 0 }])).find(r => r.key === 'sales.receivables-lifecycle')
  assert.equal(sales.status, 'gaps')
  assert.equal(sales.missing.length, 1)
  assert.ok(sales.unverified.length)
  const truncated = featureCoverage(catalog, snapshot([{ key: 'credit-memos', label: 'Credit memos', status: 'missing', count: 0, truncated: true }])).find(r => r.key === sales.key)
  assert.equal(truncated.missing.length, 0)
})
const manualRow = (id, at, status, period = { fromDate: '2026-09-01', throughDate: '2026-09-30' }) => ({ id, recorded: true, withdrawn: false, definition, definitionCurrent: true, recordedAt: at, request: { reportKey: definition.key, period, basis: 'Accrual', filters: 'All divisions', observedOn: '2026-10-01', checks: Object.fromEntries(['availability','population','plausibility','reconciliation'].map(key => [key, { status }])), assertions: definition.assertions.map(() => ({ status })) } })
test('only a complete current scoped manual result establishes verification; latest same-scope failure wins', () => {
  const good = manualRow('good', '2026-10-01', 'passed'), bad = manualRow('bad', '2026-10-02', 'failed')
  assert.equal(reportCoverage(definition, { state: 'ready', data: { items: [good] } }).status, 'verified')
  assert.equal(reportCoverage(definition, { state: 'ready', data: { items: [good, bad] } }).status, 'failed')
  assert.equal(reportCoverage(definition, { state: 'ready', data: { items: [{ ...good, definitionCurrent: false }] } }).status, 'partial')
  assert.equal(reportCoverage(definition, { state: 'ready', data: { items: [{ ...good, withdrawn: true }] } }).status, 'unverified')
})
test('different periods and basis are preserved; a baseline never certifies the whole report', () => {
  const good = manualRow('good', '2026-10-01', 'passed'), bad = manualRow('bad', '2026-09-01', 'failed', { fromDate: '2026-08-01', throughDate: '2026-08-31' })
  const mixed = reportCoverage(definition, { state: 'ready', data: { items: [good,bad], historyComplete: false } })
  assert.equal(mixed.records.length, 2)
  assert.equal(mixed.status, 'failed')
  assert.equal(mixed.historyComplete, false)
  const baseline = { id: 'opening', purpose: 'opening-balances', period: { fromDate: '2023-01-01', throughDate: '2023-08-31' }, evaluation: { period: { basis: 'Accrual' }, reports: [{ name: 'BalanceSheet', status: 'populated', scopeMatches: true, currency: 'CAD' }] } }
  assert.equal(reportCoverage(definition, { state: 'error' }, [baseline]).status, 'partial')
  assert.equal(reportCoverage(definition, { state: 'error' }, [baseline]).manualState, 'error')
})
test('published opening is zero completed months, and a changed draft cannot supply the published history length', () => {
  const plan = { state: 'ready', data: { draft: { connectionMatches: true, contentHash: 'published-blueprint', business: { historicalMonths: 36 } } } }
  const governance = { state: 'ready', data: { published: { blueprintHash: 'published-blueprint', openingDate: '2023-09-01' }, calendar: { openingDate: '2023-09-01', verifiedThrough: null, stopRequested: true } } }
  assert.deepEqual([historyCoverage(plan,governance).completed,historyCoverage(plan,governance).required], [0,36])
  assert.equal(historyCoverage(plan,governance).targetThrough, '2026-08-31')
  assert.equal(historyCoverage(plan,{ ...governance, data: { ...governance.data, calendar: { ...governance.data.calendar, verifiedThrough: '2023-09-29' } } }).completed,0)
  assert.equal(historyCoverage(plan,{ ...governance, data: { ...governance.data, calendar: { ...governance.data.calendar, verifiedThrough: '2023-09-30' } } }).completed,1)
  assert.equal(historyCoverage({ ...plan, data: { draft: { ...plan.data.draft, contentHash: 'new-draft' } } },governance).required,null)
  assert.equal(historyCoverage(plan,{ state: 'error' }).completed,null)
})
test('report loader bounds concurrency, rejects changed scope, and stops delivery on cancellation', async () => {
  let active=0, peak=0
  const definitions = catalog.reports.slice(0,7), results = new Map(), controller = new AbortController()
  const api={ get: async (path,options) => { active++; peak=Math.max(peak,active); await new Promise(r => setTimeout(r,1)); active--; return { data: { data: { ...scope, connectionId: options.params.reportKey === definitions[1].key ? 'wrong' : scope.connectionId, definition: { key: options.params.reportKey }, items: [] } } } } }
  await readReportPages(api,definitions,scope,controller.signal,(key,value)=>results.set(key,value),3)
  assert.equal(results.size,7); assert.ok(peak<=3); assert.equal(results.get(definitions[1].key).state,'error')
  const aborted = new AbortController(); aborted.abort(); let calls=0
  await readReportPages(api,definitions,scope,aborted.signal,()=>calls++)
  assert.equal(calls,0)
})

test('canonical account existence is not confused with the older volume threshold', () => {
  const rows=featureCoverage(catalog,{ areas: [{ key: 'accounting.chart-of-accounts', signals: [{ key: 'asset-accounts', kind: 'setup', label: 'Current and fixed asset accounts', status: 'missing', count: 1, min: 2 }, { key: 'liability-accounts', kind: 'setup', label: 'Liability accounts', status: 'missing', count: 1, min: 2 }] }] })
  const accounts=rows.find(r=>r.key==='accounting.chart-of-accounts')
  assert.ok(accounts.represented.some(v=>v.name==='Assets'))
  assert.ok(accounts.represented.some(v=>v.name==='Liabilities'))
})
test('retained accounting differences apply to related reports only; returned basis is not invented', () => {
  const baseline={id:'native', observedAt:'2026-10-01', period:{fromDate:'2026-09-01',throughDate:'2026-09-30'},evaluation:{period:{basis:'Accrual'},reports:[{name:'BalanceSheet',status:'populated',scopeMatches:true,currency:'CAD',basis:'Accrual'},{name:'AgedReceivables',status:'populated',scopeMatches:true,currency:'CAD',evidenceType:'open-balances-at-date'},{name:'ProfitAndLoss',status:'populated',scopeMatches:true,currency:'CAD',basis:'Accrual'}],checks:[{key:'receivables',label:'Receivables agree with ledger',status:'failed',reason:'A difference exists'}]}}
  assert.equal(reportCoverage(definition,null,[baseline]).status,'failed')
  const aging=reportCoverage(catalog.reports.find(r=>r.key==='report.ar-aging'),null,[baseline])
  assert.equal(aging.status,'failed')
  assert.equal(aging.records[0].basis,'Basis not returned')
  assert.equal(aging.records[0].evidenceType,'open-balances-at-date')
  assert.equal(reportCoverage(catalog.reports.find(r=>r.key==='report.profit-and-loss'),null,[baseline]).status,'partial')
})

test('a current backend label cannot certify a different bundled report requirement', () => {
  const row=manualRow('changed','2026-10-01','passed')
  row.definition={...definition,assertions:definition.assertions.map(a=>a+' Changed')}
  assert.equal(reportCoverage(definition,{state:'ready',data:{items:[row]}}).status,'partial')
  assert.equal(reportCoverage(definition,{state:'ready',data:{items:[row]}}).records[0].historical,true)
})

test('narrow invoice text-field and asset predicates do not establish broad absence', () => {
  const rows=featureCoverage(catalog,{areas:[{key:'company.custom-fields',signals:[{key:'custom-field-values',status:'missing',count:0}]},{key:'accounting.chart-of-accounts',signals:[{key:'asset-accounts',kind:'setup',status:'missing',count:0}]}]})
  assert.equal(rows.find(r=>r.key==='company.custom-fields').variants.find(v=>v.name==='Sales form').status,'unverified')
  assert.equal(rows.find(r=>r.key==='accounting.chart-of-accounts').variants.find(v=>v.name==='Assets').status,'unverified')
})

test('prerequisite changes also invalidate the target match; object key order does not', () => {
  const row=manualRow('definition','2026-10-01','passed')
  row.definition=Object.fromEntries(Object.entries(definition).reverse())
  assert.equal(reportCoverage(definition,{state:'ready',data:{items:[row]}}).status,'verified')
  row.definition={...row.definition,prerequisites:{...definition.prerequisites,accounts:[...definition.prerequisites.accounts,'New required account']}}
  assert.equal(reportCoverage(definition,{state:'ready',data:{items:[row]}}).status,'partial')
})
