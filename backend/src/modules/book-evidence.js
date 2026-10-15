'use strict';

// Read-only accounting evidence. A passing assertion proves only the named
// relationship, not bank reconciliation, historical continuity, or business realism.
const { LEGACY_REPORTS: REPORTS, CRITICAL_REPORTS, unpackReports } = require('./business-report-source');
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T12:00:00Z'))
    && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
function money(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
function rowsOf(report) {
  const rows = [];
  function visit(list, depth = 0) {
    if (depth > 30 || (list != null && !Array.isArray(list))) throw new Error('Report structure exceeds the supported read budget or has an invalid row list.');
    for (const row of list || []) {
      if (rows.length >= 100000 || !row || typeof row !== 'object') throw new Error('Report structure exceeds the supported read budget or has an invalid row.');
      rows.push(row);
      if (row.Rows?.Row) visit(row.Rows.Row, depth + 1);
    }
  }
  visit(report?.Rows?.Row);
  return rows;
}
function unique(list) { return list.length === 1 ? list[0] : null; }
function totalFor(report, group, flattened = rowsOf(report)) {
  const labels = { Assets: 'Total Assets', LiabilitiesAndEquity: 'Total Liabilities and Equity', AccountsReceivable: 'Total Accounts Receivable (A/R)', AccountsPayable: 'Total Accounts Payable (A/P)' };
  const aliases = group === 'Assets' ? ['Assets', 'TotalAssets'] : [group];
  const row = unique(flattened.filter(row => row.Summary?.ColData
    && (aliases.includes(row.group) || (labels[group] && row.Summary.ColData[0]?.value === labels[group]))));
  const values = row?.Summary?.ColData;
  return values?.length === 2 ? money(values[1].value) : null;
}
function assertion(key, label, left, right, reason) {
  if (left == null || right == null) return { key, label, status: 'unverified', reason: reason || 'Required totals were not returned in a supported layout.' };
  const difference = left - right;
  return { key, label, status: difference === 0 ? 'passed' : 'failed', left: left / 100, right: right / 100, difference: difference / 100, tolerance: 0 };
}
function inspectReport(name, report, period, rows = rowsOf(report), strict = false) {
  if (!report?.Header || !report.Columns?.Column || !report.Rows) throw new Error('QuickBooks did not return a complete report.');
  const header = report.Header;
  if (strict || ['GeneralLedger', 'CashFlow'].includes(name)) {
    const columns = report.Columns.Column;
    if (['ReportName', 'StartPeriod', 'EndPeriod', 'Currency', 'ReportBasis'].some(key => header[key] !== undefined && header[key] !== null && typeof header[key] !== 'string')) throw new Error('The report header has an unsupported identity or accounting scope.');
    const cellsMatch = (cells, section) => Array.isArray(cells) && cells.length >= 1 && (section ? cells.length <= columns.length : cells.length === columns.length) && cells.every(cell => cell && typeof cell.value === 'string' && (cell.id === undefined || typeof cell.id === 'string'));
    const warning = /^(?:Unable to display more data[.!]?(?:\s+Please reduce the date range[.!]?)?|Please reduce the date range[.!]?)$/i;
    if (rows.some(row => [row.ColData, row.Header?.ColData, row.Summary?.ColData].filter(Array.isArray).some(cells => cells.some(cell => typeof cell?.value === 'string' && warning.test(cell.value.trim()))))) throw new Error('QuickBooks reports that this response is truncated. Shorten the period.');
    if (!Array.isArray(columns) || columns.length < 2 || columns.length > 32 || columns.some(column => !column || typeof column.ColTitle !== 'string') || rows.some(row => (row.ColData !== undefined && !cellsMatch(row.ColData, Boolean(row.Header || row.Summary))) || (row.Header !== undefined && !cellsMatch(row.Header?.ColData, true)) || (row.Summary !== undefined && !cellsMatch(row.Summary?.ColData, true)))) throw new Error('The detail report columns, data and section cells do not match a supported complete layout.');
  }
  const empty = (header.Option || []).some(option => option.Name === 'NoReportData' && String(option.Value) === 'true')
    || !rows.some(row => row.ColData && !row.Summary && !row.Header);
  const periodMatches = header.EndPeriod === period.throughDate
    && (!['ProfitAndLoss', 'GeneralLedger', 'CashFlow'].includes(name) || header.StartPeriod === period.fromDate);
  // Aging reports return open balances at report_date and may omit ReportBasis.
  // Do not invent a basis: record the distinct evidence type explicitly.
  const aging = name === 'AgedReceivables' || name === 'AgedPayables';
  const cashFlow = name === 'CashFlow';
  const basisMatches = aging || cashFlow ? [undefined, null, '', 'Accrual'].includes(header.ReportBasis) : header.ReportBasis === 'Accrual';
  return { name, status: empty ? 'empty' : 'populated', startDate: header.StartPeriod || null,
    throughDate: header.EndPeriod || null, basis: header.ReportBasis || null, evidenceType: aging ? 'open-balances-at-date' : cashFlow ? 'cash-movement-statement' : name === 'GeneralLedger' ? 'ledger-detail' : 'accrual-ledger', currency: header.Currency || null,
    dataRows: rows.filter(row => row.ColData && !row.Summary && !row.Header).length,
    scopeMatches: periodMatches && basisMatches && header.ReportName === name,
    columns: report.Columns.Column.map(column => column.ColTitle || ''),
    summaries: rows.filter(row => row.Summary?.ColData).slice(0, 50).map(row => row.Summary.ColData.map(cell => cell.value || '')),
    summariesTruncated: rows.filter(row => row.Summary?.ColData).length > 50,
    limitation: periodMatches && basisMatches && header.ReportName === name && header.Currency === 'CAD' ? null : 'The report did not confirm its required identity, period, accounting scope and CAD currency.' };
}
function explicitZeroReport(report) {
  if (!report?.Header?.Option?.some(option => option.Name === 'NoReportData' && String(option.Value) === 'true') || !Array.isArray(report.Columns?.Column)) return false;
  const rows = rowsOf(report);
  if (rows.some(row => row.ColData && !row.Header && !row.Summary)) return false;
  return rows.every(row => [row.ColData, row.Summary?.ColData, row.Header?.ColData].filter(Boolean).every(cells => cells.slice(1).every(cell => !cell.value || money(cell.value) === 0)));
}
function evaluateBooks(reports, period, failures = {}, accountSource, { allowExplicitZero = false, includeCritical = false } = {}) {
  const requiredReports = includeCritical ? CRITICAL_REPORTS : REPORTS;
  const observed = [];
  const usable = {};
  const flattened = new Map();
  function reportRows(report) {
    if (!report) return [];
    if (!flattened.has(report)) flattened.set(report, rowsOf(report));
    return flattened.get(report);
  }
  for (const name of requiredReports) {
    try {
      if (failures[name]) throw new Error(failures[name]);
      const evidence = inspectReport(name, reports[name], period, reportRows(reports[name]), includeCritical);
      observed.push(evidence);
      if ((evidence.status === 'populated' || (allowExplicitZero && explicitZeroReport(reports[name]))) && evidence.scopeMatches && evidence.currency === 'CAD') usable[name] = reports[name];
    } catch (error) { observed.push({ name, status: 'unavailable', error: error.message }); }
  }
  const checks = [];
  const tb = usable.TrialBalance;
  const cols = (tb?.Columns?.Column || []).map(column => String(column.ColTitle || '').toLowerCase());
  const debitIndex = cols.indexOf('debit');
  const creditIndex = cols.indexOf('credit');
  const tbRows = reportRows(tb);
  const accountRows = new Map();
  for (const row of tbRows) if (row.ColData?.[0]?.id && !row.Summary && !row.Header) {
    const id = String(row.ColData[0].id);
    accountRows.set(id, accountRows.has(id) ? null : row);
  }
  const total = unique(tbRows.filter(row => row.group === 'GrandTotal' && row.Summary?.ColData));
  const debit = debitIndex >= 0 ? (allowExplicitZero && explicitZeroReport(tb) ? 0 : money(total?.Summary.ColData[debitIndex]?.value)) : null;
  const credit = creditIndex >= 0 ? (allowExplicitZero && explicitZeroReport(tb) ? 0 : money(total?.Summary.ColData[creditIndex]?.value)) : null;
  checks.push(assertion('trial-balance', 'Trial balance debits equal credits', debit, credit));
  const bs = usable.BalanceSheet;
  checks.push(assertion('balance-sheet', 'Assets equal liabilities and equity', allowExplicitZero && explicitZeroReport(bs) ? 0 : totalFor(bs, 'Assets', reportRows(bs)), allowExplicitZero && explicitZeroReport(bs) ? 0 : totalFor(bs, 'LiabilitiesAndEquity', reportRows(bs))));
  function ledgerBalance(type, reverse) {
    if (!tb || !accountSource || accountSource.error || accountSource.truncated || debitIndex < 0 || creditIndex < 0) return null;
    const accounts = accountSource.records.filter(account => account.AccountType === type);
    if (!accounts.length) return null;
    let cents = 0;
    for (const account of accounts) {
      const row = accountRows.get(String(account.Id));
      if (!accountRows.has(String(account.Id)) && allowExplicitZero && explicitZeroReport(tb)) continue;
      if (!row || !row.ColData[debitIndex] || !row.ColData[creditIndex]) return null;
      const d = row.ColData[debitIndex].value === '' ? 0 : money(row.ColData[debitIndex].value);
      const c = row.ColData[creditIndex].value === '' ? 0 : money(row.ColData[creditIndex].value);
      if (d == null || c == null) return null;
      cents += reverse ? c - d : d - c;
    }
    return Number.isSafeInteger(cents) ? cents : null;
  }
  function agingTotal(report) {
    if (allowExplicitZero && report && explicitZeroReport(report)) return 0;
    const index = (report?.Columns?.Column || []).findIndex(column => String(column.ColTitle).toLowerCase() === 'total');
    const row = unique(reportRows(report).filter(row => row.group === 'GrandTotal' && row.Summary?.ColData));
    return index >= 0 ? money(row?.Summary.ColData[index]?.value) : null;
  }
  checks.push(assertion('receivables', 'Receivables agree with the ledger', ledgerBalance('Accounts Receivable', false) ?? totalFor(bs, 'AccountsReceivable', reportRows(bs)), agingTotal(usable.AgedReceivables), 'Neither exact receivable account rows nor an unambiguous balance-sheet receivable total could be matched to aging.'));
  checks.push(assertion('payables', 'Payables agree with the ledger', ledgerBalance('Accounts Payable', true) ?? totalFor(bs, 'AccountsPayable', reportRows(bs)), agingTotal(usable.AgedPayables), 'Neither exact payable account rows nor an unambiguous balance-sheet payable total could be matched to aging.'));

  const missingReports = requiredReports.filter(name => !usable[name]);
  return { period: { ...period, basis: 'Accrual', currency: 'CAD' }, reports: observed, checks,
    ...(includeCritical ? { reportCoverage: { version: 1, required: requiredReports.length, available: requiredReports.length - missingReports.length, complete: missingReports.length === 0, missing: missingReports, meaning: 'Availability and supported accounting scope; ledger movements, cash-flow reconciliation and business realism need separate checks.' } } : {}),
    status: checks.some(check => check.status === 'failed') ? 'differences-found' : checks.every(check => check.status === 'passed') && (!includeCritical || missingReports.length === 0) ? 'checks-passed' : 'verification-incomplete',
    reconciled: false, calendarVerified: false,
    limitation: 'These checks do not confirm bank reconciliation, a closed period, or complete business activity.' };
}
function evaluateReportSources(sources, { allowExplicitZero = false } = {}) {
  const reports = unpackReports(sources);
  return evaluateBooks(reports, sources.period, {}, { records: sources.accounts }, { allowExplicitZero, includeCritical: sources.version === 2 });
}
async function readBookEvidence(access, scope, { fromDate, throughDate }, { signal, now = () => Date.now() } = {}) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
  if (![fromDate, throughDate, today].every(validDate) || fromDate > throughDate || throughDate > today || Date.parse(throughDate) - Date.parse(fromDate) > 366 * 86400000) throw Object.assign(new Error('Choose a valid period of at most one year, ending no later than today.'), { status: 400 });
  const { createBusinessReportReader } = require('./business-report-evidence');
  let readAttempts = 0;
  const source = await createBusinessReportReader({ access, now, purpose: 'book', onAttempt: count => { readAttempts = count } })(scope, { fromDate, throughDate }, { signal });
  await access.authorize(scope, 'reports.observe', { signal });
  return { checkedAt: source.observedAt, readAttempts, ...evaluateReportSources(source, { allowExplicitZero: true }) };
}
module.exports = { readBookEvidence, evaluateBooks, evaluateReportSources, validDate, money, rowsOf, explicitZeroReport };
