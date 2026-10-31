'use strict';
// Intuit Invoice API reference checked 2026-10-31:
// https://developer.intuit.com/docs/api/accounting/invoice
// Native ReimburseCharge invoice links are UI-only and API read-only. A charge id
// is not the Bill/Purchase id. Zero invoice amounts do not prove a billing remainder.
const { canonical } = require('./business-calendar');
const UI_ONLY = 'Billable expense invoice links (ReimburseCharge) are read-only in the QuickBooks API. Add the expense to its customer invoice in the QuickBooks UI; do not create a replacement service invoice or mark the source HasBeenBilled.';
const SUPPORT = Object.freeze({
  apiWritable: false, readOnlyLinkTypes: ['ReimburseCharge'],
  manualAction: 'Add the billable expense to its customer invoice in QuickBooks.',
  reason: UI_ONLY,
  sourceChecks: 'Before billing, confirm the customer, originating expense line, remaining billable amount and that no other invoice already billed it. A ReimburseCharge id is not a Bill/Purchase id; invoice Balance and zero invoice lines do not prove the remaining amount.',
  documentation: 'https://developer.intuit.com/docs/api/accounting/invoice',
  checkedOn: '2026-10-31',
});
const linesOf = record => (Array.isArray(record?.Line) ? record.Line : []).flatMap(line => [line, ...linesOf(line?.GroupLineDetail)]);
const linksOf = record => [...(Array.isArray(record?.LinkedTxn) ? record.LinkedTxn : []), ...linesOf(record).flatMap(line => Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : [])].filter(link => link?.TxnType === 'ReimburseCharge');
const hasBillableLinks = record => linksOf(record).length > 0;
function billableWriteProblems(entity, op, payload, before) {
  const problems = [];
  if (hasBillableLinks(payload)) problems.push(UI_ONLY);
  // These native invoices can contain markup, groups and tax-inclusive lines
  // without a normal ItemRef. Keep their accounting outside the generic writer.
  if (entity === 'Invoice' && hasBillableLinks(before)) problems.push('This invoice retains native billable expense links. Its changes require the QuickBooks UI; preserve its customer, source lines, amounts, currency, tax and billing history.');
  if (!['Bill', 'Purchase', 'VendorCredit'].includes(entity)) return problems;
  const billed = linesOf(before).some(line => line?.[line.DetailType]?.BillableStatus === 'HasBeenBilled') || hasBillableLinks(before);
  if (billed && (['delete', 'void'].includes(op) || Object.keys(payload).some(key => !['PrivateNote', 'DocNumber', 'DueDate', 'SalesTermRef'].includes(key)))) problems.push('This expense has native billable charge history. Do not replace, reopen or remove its source lines: that can bill the same expense twice. Review its existing invoice link in QuickBooks.');
  for (const line of linesOf(payload)) {
    const detail = line?.[line.DetailType];
    if (!['AccountBasedExpenseLineDetail', 'ItemBasedExpenseLineDetail'].includes(line?.DetailType)) continue;
    if (detail?.BillableStatus === 'HasBeenBilled') problems.push('HasBeenBilled cannot establish an invoice link. Leave billing completion to the native QuickBooks billable-expense workflow.');
    else if (detail?.BillableStatus !== undefined && !['Billable', 'NotBillable'].includes(detail.BillableStatus)) problems.push('Expense BillableStatus must be Billable or NotBillable.');
    if (detail?.BillableStatus === 'Billable' && !detail.CustomerRef) problems.push('A billable expense source line needs CustomerRef for the customer to be invoiced.');
  }
  return problems;
}
// Compare native history independently of reference display names, link ordering
// and unrelated payment backlinks. No source remainder is inferred by this check.
function nativeState(record) {
  const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'name').map(([key, entry]) => [key, clean(entry)])) : value;
  const sortLinks = links => links.filter(link => link?.TxnType === 'ReimburseCharge').map(clean).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return clean({
    customer: record?.CustomerRef || null, currency: record?.CurrencyRef || null,
    accounting: Object.fromEntries(['VendorRef', 'EntityRef', 'APAccountRef', 'ARAccountRef', 'AccountRef', 'PaymentType', 'Credit'].map(key => [key, record?.[key] ?? null])),
    date: record?.TxnDate || null, taxMode: record?.GlobalTaxCalculation || null,
    tax: record?.TxnTaxDetail || null,
    header: sortLinks(Array.isArray(record?.LinkedTxn) ? record.LinkedTxn : []),
    lines: linesOf(record).map(line => ({ line, links: sortLinks(Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : []) }))
      .map(({ line, links }) => ({ id: line.Id ?? null, amount: line.Amount, detailType: line.DetailType, detail: line[line.DetailType], links })),
  });
}
function preservesBillableState(before, current, entity) {
  if (entity === 'Invoice' && !hasBillableLinks(before)) return !hasBillableLinks(current);
  if (!hasBillableLinks(before) && !linesOf(before).some(line => line?.[line.DetailType]?.BillableStatus === 'HasBeenBilled')) return true;
  return Boolean(current) && canonical(nativeState(before)) === canonical(nativeState(current));
}
module.exports = { SUPPORT, UI_ONLY, hasBillableLinks, billableWriteProblems, preservesBillableState };
