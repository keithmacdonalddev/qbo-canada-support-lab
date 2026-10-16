'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { gzipSync } = require('node:zlib'), { createHash } = require('node:crypto');
const { canonical, hash } = require('../src/modules/business-calendar');
const { canonicalReport, canonicalReportCollection, MAX_DEPTH, MAX_NODES, MAX_REPORT_BYTES } = require('../src/modules/report-json');
const S = require('../src/modules/business-report-source');
const { rowsOf, evaluateReportSources, explicitZeroReport } = require('../src/modules/book-evidence');
const { reportComplete } = require('../src/modules/business-financial-summary');
const { fixture, accounts, period } = require('./helpers/business-report-fixtures');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const { nestedReport } = require('./helpers/nested-report-fixture');
function source(version = 3) { const reports = fixture({ critical: true }); return { version, period, accounts: accounts.records, reports: Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, S.packReport(name, version === 3 ? nestedReport(report) : report, version)])) }; }
test('source v3 retains supported nested report rows without widening immutable blueprint hashing', () => {
  const report = nestedReport(fixture().BalanceSheet); assert.throws(() => canonical(report), /deeply nested/); assert.ok(rowsOf(report).length > 8);
  const encoded = S.packReport('BalanceSheet', report, 3); assert.equal(encoded.encoding, 'gzip-canonical-json-v2'); assert.deepEqual(S.unpackReport('BalanceSheet', encoded, 3), report);
  const observation = source(); assert.doesNotThrow(() => hash(observation)); const result = evaluateReportSources(observation); assert.equal(result.reportCoverage.available, 7); assert.equal(result.status, 'checks-passed');
  assert.throws(() => canonical(report), /deeply nested/, 'report support must not loosen blueprint depth');
});
test('old canonical bytes and source v1/v2 report contracts retain their original meaning', () => {
  const value = { z: [true, null, 'é'], a: { n: 1.5 } }, expected = '{"a":{"n":1.5},"z":[true,null,"é"]}';
  assert.equal(canonical(value), expected); assert.equal(canonicalReport(value), expected);
  const report = fixture({ critical: true }).GeneralLedger, bytes = Buffer.from(canonical(report), 'utf8'), encoded = S.packReport('GeneralLedger', report);
  assert.deepEqual(encoded, { encoding: 'gzip-canonical-json-v1', byteLength: bytes.length, sha256: digest(bytes), body: gzipSync(bytes).toString('base64') });
  const old = source(2); assert.equal(old.reports.BalanceSheet.encoding, undefined); assert.equal(evaluateReportSources(old).status, 'checks-passed');
  const legacy = { version: 1, period, accounts: accounts.records, reports: Object.fromEntries(Object.entries(fixture())) }; assert.equal(evaluateReportSources(legacy).reports.length, 5);
});
test('new report canonicalization rejects sparse, cyclic, accessor and non-JSON values within fixed bounds', () => {
  const cycle = {}; cycle.next = cycle; const accessor = {}; Object.defineProperty(accessor, 'private', { enumerable: true, get() { throw Error('Getter must not execute'); } });
  for (const value of [cycle, [, 1], accessor, { x: undefined }, { x: Infinity }, { x: 1n }, { x: new Date() }, JSON.parse('{"constructor":1}'), { x: Object.create(Array.prototype) }]) assert.throws(() => canonicalReport(value), error => error.code === 'BUSINESS_REPORT_UNVERIFIED');
  let deep = null; for (let index = 0; index < MAX_DEPTH + 2; index++) deep = { child: deep }; assert.throws(() => canonicalReport(deep), /nesting depth/);
  assert.throws(() => canonicalReport(Array(MAX_NODES).fill(0)), /node budget/);
  assert.throws(() => canonicalReport({ text: 'é'.repeat(MAX_REPORT_BYTES / 2) }), /byte budget/);
});
test('v3 verifies every envelope and aggregate declared budget before any inflation', () => {
  const value = source(); for (const report of Object.values(value.reports)) report.byteLength = 2000000;
  assert.throws(() => S.unpackReports(value), /combined decoded/);
  const mixed = source(); mixed.reports.BalanceSheet = fixture().BalanceSheet; assert.throws(() => S.unpackReports(mixed), /envelope/);
  for (const version of [0, 4, '3']) assert.throws(() => S.unpackReports({ ...source(), version }), /unsupported/);
});
test('v3 rejects wrong digest, byte length, noncanonical JSON and bounded decompression bombs', () => {
  const encoded = S.packReport('BalanceSheet', fixture().BalanceSheet, 3);
  for (const patch of [{ sha256: '0'.repeat(64) }, { byteLength: encoded.byteLength + 1 }, { encoding: 'gzip-canonical-json-v1' }, { extra: true }]) assert.throws(() => S.unpackReport('BalanceSheet', { ...encoded, ...patch }, 3), /invalid|could not be verified/);
  for (const text of ['{ "a":1}', '[1]', '{"constructor":1}', 'x'.repeat(MAX_REPORT_BYTES + 1)]) {
    const bytes = Buffer.from(text); const value = { encoding: 'gzip-canonical-json-v2', byteLength: Math.min(bytes.length, MAX_REPORT_BYTES), sha256: digest(bytes), body: gzipSync(bytes).toString('base64') };
    assert.throws(() => S.unpackReport('BalanceSheet', value, 3), /could not be verified/);
  }
});

test('new report evidence resolves every trial-balance money column before accepting an explicit zero', () => {
  const layouts = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  const observe = (reports, version) => { const value = { version, period, accounts: accounts.records, reports: Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, S.packReport(name, report, version)])) }; return { source: value, result: evaluateReportSources(value, { allowExplicitZero: true }) }; };
  for (const order of layouts) {
    const reports = fixture({ critical: true });
    for (const report of Object.values(reports)) { report.Header.Option = [{ Name: 'NoReportData', Value: 'true' }]; report.Rows.Row = []; }
    const tb = reports.TrialBalance;
    tb.Columns.Column = order.map(index => ({ ColTitle: ['Account','Debit','Credit'][index] }));
    tb.Rows.Row = [{ group: 'GrandTotal', Summary: { ColData: order.map(index => ({ value: ['TOTAL','0.00','0.00'][index] })) } }];
    const empty = observe(reports, 3); assert.equal(empty.result.status, 'checks-passed'); assert.equal(reportComplete(empty.result, empty.source), true);
    for (const amountIndex of [1,2]) {
      tb.Rows.Row[0].Summary.ColData[order.indexOf(amountIndex)].value = '100.00';
      const nonzero = observe(reports, 3); assert.notEqual(nonzero.result.checks[0].status, 'passed'); assert.equal(nonzero.result.status, 'verification-incomplete'); assert.equal(nonzero.result.reportCoverage.complete, false); assert.equal(reportComplete(nonzero.result, nonzero.source), false);
      tb.Rows.Row[0].Summary.ColData[order.indexOf(amountIndex)].value = '0.00';
    }
    const populated = fixture({ critical: true }); populated.TrialBalance.Columns.Column = tb.Columns.Column;
    for (const row of populated.TrialBalance.Rows.Row) { const cells = row.ColData || row.Summary.ColData; if (row.ColData) row.ColData = order.map(index => cells[index]); else row.Summary.ColData = order.map(index => cells[index]); }
    assert.equal(observe(populated, 3).result.status, 'checks-passed');
  }
  // Preserve the original v2 evaluation rather than rewriting historical proof.
  const reports = fixture({ critical: true }); for (const report of Object.values(reports)) { report.Header.Option = [{ Name: 'NoReportData', Value: 'true' }]; report.Rows.Row = []; }
  reports.TrialBalance.Columns.Column = ['Debit','Account','Credit'].map(ColTitle => ({ ColTitle }));
  reports.TrialBalance.Rows.Row = [{ group: 'GrandTotal', Summary: { ColData: ['100.00','','0.00'].map(value => ({ value })) } }];
  assert.equal(explicitZeroReport(reports.TrialBalance, 2), true); assert.equal(observe(reports, 2).result.status, 'checks-passed');
  const current = observe(reports, 3); assert.equal(explicitZeroReport(reports.TrialBalance, 3), false); assert.equal(reportComplete(observe(reports, 2).result, current.source), false);
  for (const columns of [['Account','Debit','Debit'],['Account','Debit','Total'],['Unknown','Debit','Credit'],['Account','Debit','Credit','Total']]) { reports.TrialBalance.Columns.Column = columns.map(ColTitle => ({ ColTitle })); reports.TrialBalance.Rows.Row = []; assert.notEqual(observe(reports, 3).result.checks[0].status, 'passed'); }
});

test('report comparison preserves accepted per-report depth and nodes with the original sorted-map bytes', () => {
  const shallow = { TrialBalance: fixture().TrialBalance, BalanceSheet: fixture().BalanceSheet };
  assert.equal(canonicalReportCollection(shallow), canonical(shallow)); assert.equal(digest(canonicalReportCollection(shallow)), hash(shallow));
  let deep = null; for (let index = 0; index < MAX_DEPTH; index++) deep = { child: deep };
  assert.doesNotThrow(() => canonicalReport(deep)); assert.throws(() => canonicalReport({ report: deep }), /nesting depth/);
  assert.doesNotThrow(() => canonicalReportCollection({ report: deep }));
  const report = { values: Array(Math.ceil(MAX_NODES / 2)).fill(0) }, collection = { one: report, two: report };
  assert.throws(() => canonicalReport(collection), /node budget/); const text = canonicalReportCollection(collection);
  assert.equal(text, '{"one":' + canonicalReport(report) + ',"two":' + canonicalReport(report) + '}');
  assert.throws(() => canonicalReportCollection(Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index), {}]))), /seven/);
  assert.throws(() => canonicalReportCollection({ one: { text: 'x'.repeat(5999980) }, two: { text: 'x'.repeat(5999980) }, three: { text: 'x'.repeat(5000) } }), /collection exceeds.*byte budget/);
});

test('all v3 empty reports require positive monetary columns and never hide an amount in column zero', () => {
  for (const name of S.CRITICAL_REPORTS.filter(name => name !== 'TrialBalance')) {
    const reports = fixture({ critical: true }); for (const report of Object.values(reports)) { report.Header.Option = [{ Name: 'NoReportData', Value: 'true' }]; report.Rows.Row = []; }
    const report = reports[name], titles = name === 'GeneralLedger' ? ['Debit','Account','Credit'] : name.startsWith('Aged') ? ['Total','Name','Current'] : ['Total', name === 'CashFlow' ? 'Activity' : 'Account'];
    report.Columns.Column = titles.map(ColTitle => ({ ColTitle })); report.Rows.Row = [{ group: name === 'ProfitAndLoss' ? 'Income' : 'GrandTotal', Summary: { ColData: titles.map((title, index) => ({ value: index === 0 ? '100.00' : ['Account','Name','Activity'].includes(title) ? '' : '0.00' })) } }];
    assert.equal(explicitZeroReport(report, 2), true, name + ' preserves historical interpretation'); assert.equal(explicitZeroReport(report, 3), false, name);
    const source = { version: 3, period, accounts: accounts.records, reports: Object.fromEntries(Object.entries(reports).map(([key, value]) => [key, S.packReport(key, value, 3)])) }, result = evaluateReportSources(source, { allowExplicitZero: true });
    assert.equal(result.status, 'verification-incomplete', name); assert.equal(result.reportCoverage.complete, false, name); assert.equal(reportComplete(result, source), false, name);
    for (const invalid of [['Account','Account'],['',''],['Name','Unknown']]) { report.Columns.Column = invalid.map(ColTitle => ({ ColTitle })); report.Rows.Row = []; assert.equal(explicitZeroReport(report, 3), false, name + ': ' + invalid); }
  }
});
test('income validation keeps legacy source meaning but uses the actual v3 report contract independently', () => {
  const { createIncomeExpectation, validateIncomeExpectation, checkIncomeExpectation } = require('../src/modules/business-income-evidence');
  const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) }, report = fixture({ critical: true }).ProfitAndLoss;
  report.Header.Option = [{ Name: 'NoReportData', Value: 'true' }]; report.Columns.Column = ['Total','Account'].map(ColTitle => ({ ColTitle })); report.Rows.Row = [{ group: 'Income', Summary: { ColData: [{ value: '100.00' }, { value: '' }] } }];
  const legacy = createIncomeExpectation(scope, period, [], report, '2026-10-06T12:00:00Z', 2), original = hash(legacy); assert.equal(legacy.version, 1); assert.equal(legacy.openingIncomeCents, 0);
  assert.equal(checkIncomeExpectation(legacy, scope, period, report, 2).passed, true); assert.throws(() => checkIncomeExpectation(legacy, scope, period, report, 3), /supported zero layout/); assert.equal(hash(legacy), original);
  assert.throws(() => createIncomeExpectation(scope, period, [], report, '2026-10-06T12:00:00Z', 3), /supported zero layout/);
  const currentReport = structuredClone(report); currentReport.Columns.Column = ['Account','Total'].map(ColTitle => ({ ColTitle })); currentReport.Rows.Row = [];
  const current = createIncomeExpectation(scope, period, [], currentReport, '2026-10-06T12:00:00Z', 3); assert.equal(current.version, 2); assert.equal(checkIncomeExpectation(legacy, scope, period, currentReport, 3).passed, true); assert.equal(hash(legacy), original);
  const changed = structuredClone(currentReport); changed.Columns.Column = ['Account','Account'].map(ColTitle => ({ ColTitle })); current.source.report = S.packReport('ProfitAndLoss', changed, 3); current.sourceHash = hash(current.source);
  assert.throws(() => validateIncomeExpectation(current, scope, period), /supported zero layout/);
});
