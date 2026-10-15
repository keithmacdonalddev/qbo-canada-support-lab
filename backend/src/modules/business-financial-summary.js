'use strict';
const { rowsOf, money, explicitZeroReport } = require('./book-evidence');
const { namesFor, unpackReport } = require('./business-report-source');
const MAX_OPENING_BALANCE = 100000000; // The flagship is a modest three-division business.
function reportComplete(evaluation, sources) {
  return namesFor(sources?.version || 1).every(name => evaluation.reports.some(row => row.name === name && (row.status === 'populated' || (row.status === 'empty' && explicitZeroReport(unpackReport(name, sources?.reports?.[name], sources?.version)))) && row.scopeMatches === true && row.currency === 'CAD'));
}
function groupTotal(report, group) {
  const rows = rowsOf(report).filter(row => row.group === group && row.Summary?.ColData);
  if (rows.length !== 1) return null;
  const amount = money(rows[0].Summary.ColData.at(-1)?.value);
  return amount == null ? null : amount / 100;
}
function financialSummary(sources, evaluation) {
  const checks = Object.fromEntries(evaluation.checks.map(row => [row.key, row]));
  const values = { assets: checks['balance-sheet']?.left ?? null, receivables: checks.receivables?.left ?? null, payables: checks.payables?.left ?? null,
    cash: groupTotal(sources.reports.BalanceSheet, 'BankAccounts'), income: groupTotal(sources.reports.ProfitAndLoss, 'Income'), netIncome: groupTotal(sources.reports.ProfitAndLoss, 'NetIncome') };
  const blockers = [];
  if (!reportComplete(evaluation, sources)) blockers.push({ key: 'report-completeness', reason: 'All ' + (sources.version === 2 ? 'seven' : 'five') + ' reports must confirm their identity, accounting scope, period and CAD currency.' });
  for (const [key, value] of Object.entries(values)) if (typeof value === 'number' && Math.abs(value) > MAX_OPENING_BALANCE) blockers.push({ key: key + '-outlier', reason: key + ' exceeds the flagship starting-balance review limit of CAD ' + MAX_OPENING_BALANCE.toLocaleString('en-CA') + '. Prepare a specific existing-record repair or approved starting-data policy before activation.' });
  for (const key of ['receivables', 'payables']) if (typeof values[key] === 'number' && values[key] < -10000) blockers.push({ key: key + '-negative', reason: 'Large negative ' + key + ' need a record-specific review before business activation.' });
  return { version: 1, values, maximumAbsoluteOpeningBalance: MAX_OPENING_BALANCE, blockers, bankReconciled: false, realismVerified: false };
}
module.exports = { reportComplete, financialSummary };
