'use strict';
const period = { fromDate: '2026-10-01', throughDate: '2026-10-06' };
const header = { StartPeriod: period.fromDate, EndPeriod: period.throughDate, ReportBasis: 'Accrual', Currency: 'CAD' };
const cell = value => ({ value });
const data = (id, debit, credit) => ({ type: 'Data', ColData: [{ id, value: id }, cell(debit), cell(credit)] });
const total = (group, values) => ({ type: 'Section', group, Summary: { ColData: values.map(cell) } });
const report = (columns, rows) => ({ Header: { ...header }, Columns: { Column: columns.map(ColTitle => ({ ColTitle })) }, Rows: { Row: rows } });
function fixture() {
  const reports = {
    TrialBalance: report(['Account', 'Debit', 'Credit'], [data('ar', '100.00', ''), data('ap', '', '50.00'), data('other', '', '50.00'), total('GrandTotal', ['TOTAL', '100.00', '100.00'])]),
    BalanceSheet: report(['Account', 'Total'], [data('bank', '100.00', ''), total('Assets', ['Total Assets', '100.00']), total('LiabilitiesAndEquity', ['Total Liabilities and Equity', '100.00'])]),
    ProfitAndLoss: report(['Account', 'Total'], [data('income', '50.00', '')]),
    AgedReceivables: report(['Name', 'Current', 'Total'], [data('customer', '100.00', '100.00'), total('GrandTotal', ['TOTAL', '100.00', '100.00'])]),
    AgedPayables: report(['Name', 'Current', 'Total'], [data('vendor', '50.00', '50.00'), total('GrandTotal', ['TOTAL', '50.00', '50.00'])]),
  };
  for (const [name, result] of Object.entries(reports)) result.Header.ReportName = name;
  return reports;
}
const accounts = { records: [{ Id: 'ar', AccountType: 'Accounts Receivable' }, { Id: 'ap', AccountType: 'Accounts Payable' }] };

module.exports = { fixture, accounts, period };
