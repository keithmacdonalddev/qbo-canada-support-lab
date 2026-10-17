'use strict';
const { sample, scope, now, clone } = require('./business-readback-fixtures');
const { fixture } = require('./business-transaction-fixtures');
const { invoiceReceivablesEvidence } = require('../../src/modules/business-receivables-route');
function routingFixture() {
  const value = sample('Invoice'), refs = fixture('Invoice');
  delete value.observed.record.ARAccountRef; value.refresh();
  const accountBinding = clone(value.intent.step.references.find(binding => binding.key === 'accountsReceivable'));
  const accountObserved = clone(refs.referenceEvidence.find(item => item.entity === 'Account' && item.record.Id === accountBinding.id));
  const report = { Header: { ReportName: 'GeneralLedger', ReportBasis: 'Accrual', Currency: 'CAD', StartPeriod: value.observed.record.TxnDate, EndPeriod: value.observed.record.TxnDate, Option: [{ Name: 'NoReportData', Value: 'false' }] }, Columns: { Column: ['tx_date', 'txn_type', 'subt_nat_amount_home_nt'].map(ColType => ({ ColType, ColTitle: ColType })) }, Rows: { Row: [{ type: 'Section', Header: { ColData: [{ id: accountBinding.id, value: 'Receivables' }] }, Rows: { Row: [{ type: 'Data', ColData: [{ value: value.observed.record.TxnDate }, { value: 'Invoice', id: value.observed.record.Id }, { value: value.observed.record.TotalAmt.toFixed(2) }] }] } }] } };
  const beforeFence = { scope, operationId: 'b'.repeat(24), revision: 4, unresolved: null };
  const input = { compiled: value.compiled, receipt: value.receipt, observed: value.observed, accountBinding, accountObserved, report, reportObservedAt: new Date(now).toISOString(), beforeFence, afterFence: clone(beforeFence), now };
  value.observed.accountRouting = invoiceReceivablesEvidence(input);
  return { value, input };
}
module.exports = { routingFixture };
