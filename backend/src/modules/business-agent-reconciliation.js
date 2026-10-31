'use strict';
// Amount evidence is separate from freshness/counts: a complete mirror is not proof of a report match.
const DEFINITIONS = Object.freeze([
  { key: 'receivables', entity: 'Invoice', report: 'AgedReceivables' },
  { key: 'payables', entity: 'Bill', report: 'AgedPayables' },
  { key: 'accounts', entity: 'Account' },
]);
const fail = message => Object.assign(new Error(message), { code: 'BUSINESS_SYNC_INCOMPLETE', status: 409 });
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const ACCOUNT_TYPES = new Set(['Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset', 'Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability', 'Equity', 'Income', 'Cost of Goods Sold', 'Expense', 'Other Income', 'Other Expense', 'Non-Posting']);
const accountType = record => ['Bank', 'Credit Card'].includes(record?.AccountType);
// Decimal conversion avoids floating-point sums and refuses missing/rounded/unsafe amounts.
function moneyCents(value) {
  if (!['number', 'string'].includes(typeof value) || !/^-?\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
  const [whole, fraction = ''] = String(value).replace(/^-/, '').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? (String(value).startsWith('-') ? -amount : amount) : null;
}
function currentTime(value, clock) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || Math.abs(time - clock) > 300000) throw fail('The amount evidence has no current QuickBooks time.');
  return new Date(time).toISOString();
}
function parseAgingReport(body, report, currency, clock) {
  if (!plain(body) || body.Fault || body.fault || !plain(body.Header) || body.Header.ReportName !== report) throw fail('The aging report is missing or incomplete.');
  const qboAt = currentTime(body.Header.Time, clock);
  if (!currency || body.Header.Currency !== currency) throw fail('The aging report currency does not match the observed home currency.');
  const rows = body.Rows?.Row;
  const noData = body.Header.Option?.some(option => option.Name === 'NoReportData' && option.Value === 'true');
  if (noData && (rows === undefined || Array.isArray(rows) && rows.length === 0)) return { qboCents: 0, qboAt, currency };
  if (!Array.isArray(rows) || !Array.isArray(body.Columns?.Column)) throw fail('The aging report rows or columns are incomplete.');
  const columns = body.Columns.Column;
  const totals = columns.map((column, index) => column.ColType === 'Money' && (String(column.ColTitle).trim().toLowerCase() === 'total' || column.MetaData?.some(meta => meta.Name === 'ColKey' && meta.Value === 'total')) ? index : -1).filter(index => index >= 0);
  // Report sources retain Summary.ColData unchanged; accept the explicit TOTAL summary
  // when the provider omits group, but never a customer/vendor subtotal or a detail row.
  const grandTotals = rows.filter(row => row.group === 'GrandTotal' || (!row.group && row.type === 'Section' && String(row.Summary?.ColData?.[0]?.value).trim().toUpperCase() === 'TOTAL'));
  if (totals.length !== 1 || grandTotals.length !== 1 || grandTotals[0].Summary?.ColData?.length !== columns.length) throw fail('The aging report has no unambiguous grand total.');
  const qboCents = moneyCents(grandTotals[0].Summary.ColData[totals[0]].value);
  if (qboCents === null) throw fail('The aging report total is not an exact cent amount.');
  return { qboCents, qboAt, currency };
}
async function readAmountMirror(Records, scope, entity) {
  // CompanySyncRecord holds the complete record; select only fields needed for this private comparison.
  const rows = await Records.find({ ...scope, deleted: false, entity })
    .select('qboId record.Balance record.RemainingCredit record.TotalAmt record.HomeBalance record.UnappliedAmt record.HomeUnappliedAmt record.CurrencyRef record.CurrentBalance record.AccountType record.Line record.TxnDate record.ARAccountRef record.APAccountRef record.DepositToAccountRef record.AccountRef').maxTimeMS(5000).lean();
  if (!Array.isArray(rows)) throw fail('The local amount evidence could not be read.');
  return rows;
}
function mirrorTotal(rows, currency) {
  if (!currency) throw fail('The mirror home currency has not been independently observed.');
  let total = 0;
  for (const row of rows) {
    const record = row.record;
    if (!plain(record)) throw fail('An open balance is missing from the mirror.');
    const balance = moneyCents(record.Balance);
    if (balance === null || balance < 0) throw fail('A mirror balance is missing or is not an exact open amount.');
    if (balance === 0) continue;
    const home = !record.CurrencyRef?.value || record.CurrencyRef.value === currency;
    const amount = home ? balance : moneyCents(record.HomeBalance);
    if (amount === null) throw fail('A foreign open balance has no exact home-currency amount; the report comparison is unverified.');
    total += amount;
    if (!Number.isSafeInteger(total)) throw fail('The mirror total exceeds the exact amount budget.');
  }
  return total;
}
// Each contribution is signed in the report's direction (A/R debit, A/P credit).
const AGING_COMPONENTS = Object.freeze({
  Invoice: [
    { key: 'invoices', entity: 'Invoice', field: 'Balance', sign: 1 },
    { key: 'unappliedPayments', entity: 'Payment', field: 'UnappliedAmt', sign: -1 },
    { key: 'creditMemos', entity: 'CreditMemo', field: 'Balance', sign: -1 },
    { key: 'journalEntries', entity: 'JournalEntry' },
    { key: 'refundReceipts', entity: 'RefundReceipt' },
    { key: 'deposits', entity: 'Deposit' },
    { key: 'purchases', entity: 'Purchase' },
  ],
  Bill: [
    { key: 'bills', entity: 'Bill', field: 'Balance', sign: 1 },
    { key: 'unappliedBillPayments', entity: 'BillPayment', field: 'UnappliedAmt', sign: -1 },
    { key: 'vendorCredits', entity: 'VendorCredit', field: 'Balance', sign: -1 },
    { key: 'journalEntries', entity: 'JournalEntry' },
    { key: 'deposits', entity: 'Deposit' },
    { key: 'purchases', entity: 'Purchase' },
  ],
});
const agingEntities = entity => [...new Set([...(AGING_COMPONENTS[entity] || []).map(row => row.entity), 'Account'])];
function addCents(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw fail('The mirror total exceeds the exact amount budget.');
  return sum;
}
function fieldCents(record, field, currency) {
  if (!plain(record)) throw fail('A mirrored amount record is missing.');
  const amount = moneyCents(record[field]);
  if (amount === null || amount < 0) throw fail('The mirrored ' + field + ' is missing or is not an exact nonnegative amount.');
  if (amount === 0 || !record.CurrencyRef?.value || record.CurrencyRef.value === currency) return amount;
  // HomeBalance is a remaining balance, not an unapplied amount or an individual JE line.
  const home = moneyCents(record[field === 'Balance' ? 'HomeBalance' : 'HomeUnappliedAmt']);
  if (home === null || home < 0) throw fail('A foreign component has no exact home-currency amount.');
  return home;
}
// Native BillPayment has no guaranteed UnappliedAmt. Derive it only for
// unambiguous single Bill/VendorCredit applications; journals/mixed links need
// remaining-balance evidence that the mirror does not expose.
function billPaymentUnapplied(record) {
  const total = moneyCents(record.TotalAmt);
  if (total === null || total < 0 || !Array.isArray(record.Line)) throw fail('BillPayment has no exact unapplied amount or complete application lines.');
  let applied = 0;
  for (const line of record.Line) {
    const links = line.LinkedTxn, amount = moneyCents(line.Amount);
    if (amount === null || amount < 0 || !Array.isArray(links) || links.length !== 1 || !links[0].TxnId || !['Bill', 'VendorCredit'].includes(links[0].TxnType)) throw fail('BillPayment applications cannot establish an exact unapplied amount.');
    applied = addCents(applied, links[0].TxnType === 'Bill' ? amount : -amount);
  }
  const unapplied = addCents(total, -applied);
  if (unapplied < 0) throw fail('BillPayment applications exceed its total; the unapplied amount is unknown.');
  return unapplied;
}
function assertNoDirectPosting(record, type, target, accounts, accountRows) {
  if (!plain(record) || !Array.isArray(accountRows) || !Array.isArray(record.Line)) throw fail(type + ' has incomplete direct-posting account evidence.');
  const checkRef = reference => {
    if (!reference?.value || !ACCOUNT_TYPES.has(accounts.get(reference.value))) throw fail(type + ' references an account with no mirrored type.');
    if (accounts.get(reference.value) === target) throw fail(type + ' posts directly to ' + target + '; its remaining effect is not mirrored.');
  };
  if (type === 'Deposit') checkRef(record.DepositToAccountRef);
  else checkRef(record.AccountRef);
  for (const line of record.Line) {
    if (line.DetailType === 'DescriptionOnly') continue;
    const detail = type === 'Deposit' ? line.DepositLineDetail : line.AccountBasedExpenseLineDetail;
    if (!plain(detail)) throw fail(type + ' line posting accounts cannot be determined from mirrored fields.');
    checkRef(detail.AccountRef);
  }
}
function agingMirrorTotal(entity, byEntity, currency) {
  if (!currency) throw fail('The mirror home currency has not been independently observed.');
  const components = {}, limitations = [];
  if (!AGING_COMPONENTS[entity]) throw fail('The aging source is unsupported.');
  const accountRows = byEntity.Account;
  const accounts = new Map();
  if (Array.isArray(accountRows)) for (const row of accountRows) accounts.set(row.qboId, row.record?.AccountType);
  const target = entity === 'Invoice' ? 'Accounts Receivable' : 'Accounts Payable';
  let knownCents = 0;
  for (const definition of AGING_COMPONENTS[entity] || []) {
    const { key, entity: type, field, sign } = definition, rows = byEntity[type];
    const component = components[key] = { entity: type, field: field || 'Line', records: Array.isArray(rows) ? rows.length : null, cents: null, status: 'unverified' };
    try {
      if (!Array.isArray(rows)) throw fail(type + ' is not mirrored; its contribution is unknown.');
      let total = 0;
      const fieldsUsed = new Set();
      if (type === 'JournalEntry') {
        const settlements = byEntity[entity === 'Invoice' ? 'Payment' : 'BillPayment'];
        if (!Array.isArray(settlements)) throw fail('Journal settlement records are not mirrored.');
        if (settlements.some(row => row.record?.Line?.some(line => line.LinkedTxn?.some(link => link.TxnType === 'JournalEntry')))) throw fail('A journal is linked to a payment; its remaining A/R or A/P effect is not mirrored.');
      }
      for (const { record } of rows) {
        if (field) {
          let source = record, sourceField = field;
          if (type === 'CreditMemo' && record?.RemainingCredit !== undefined) {
            if (record.Balance !== undefined && (moneyCents(record.Balance) === null || moneyCents(record.Balance) !== moneyCents(record.RemainingCredit))) throw fail('CreditMemo remaining-credit fields disagree.');
            source = { ...record, Balance: record.RemainingCredit }; sourceField = 'RemainingCredit';
          }
          if (type === 'BillPayment' && record?.UnappliedAmt === undefined) {
            const digits = String(billPaymentUnapplied(record)).padStart(3, '0');
            source = { ...record, UnappliedAmt: digits.slice(0, -2) + '.' + digits.slice(-2) }; sourceField = 'TotalAmt - net applied Line.Amount';
          }
          total = addCents(total, sign * fieldCents(source, field, currency)); fieldsUsed.add(sourceField);
        }
        else if (type === 'RefundReceipt') {
          // TotalAmt is a cash refund, not a remaining customer A/R balance. Do not
          // manufacture a debit without a mirrored open-balance field.
          throw fail('RefundReceipt A/R effects cannot be determined from a cash refund total.');
        } else if (['Deposit', 'Purchase'].includes(type)) {
          assertNoDirectPosting(record, type, target, accounts, accountRows);
        } else {
          if (!Array.isArray(accountRows)) throw fail('Account is not mirrored; journal account types are unknown.');
          if (!Array.isArray(record?.Line)) throw fail('JournalEntry lines are missing.');
          for (const line of record.Line) {
            if (line.DetailType === 'DescriptionOnly') continue;
            const detail = line.JournalEntryLineDetail;
            if (line.DetailType !== 'JournalEntryLineDetail' || !plain(detail) || !ACCOUNT_TYPES.has(accounts.get(detail.AccountRef?.value))) throw fail('A journal line has no mirrored account type.');
            if (accounts.get(detail.AccountRef.value) !== target) continue;
            if (detail.Entity?.Type !== (entity === 'Invoice' ? 'Customer' : 'Vendor') || !detail.Entity.EntityRef?.value) throw fail('A journal A/R or A/P line has no customer or vendor.');
            if (!['Debit', 'Credit'].includes(detail.PostingType)) throw fail('A journal posting direction is missing.');
            const amount = moneyCents(line.Amount);
            if (amount === null || amount < 0) throw fail('A journal line is not an exact cent amount.');
            if (amount && record.CurrencyRef?.value && record.CurrencyRef.value !== currency) throw fail('A foreign journal line has no exact home-currency amount.');
            const positive = detail.PostingType === (entity === 'Invoice' ? 'Debit' : 'Credit');
            total = addCents(total, positive ? amount : -amount);
          }
        }
      }
      knownCents = addCents(knownCents, total);
      component.cents = total; component.status = 'included';
      if (fieldsUsed.size) { component.fieldsUsed = [...fieldsUsed]; component.field = component.fieldsUsed.join(' / '); }
    } catch (error) {
      if (error.code !== 'BUSINESS_SYNC_INCOMPLETE') throw error;
      component.reason = error.message; limitations.push({ component: key, entity: type, reason: error.message });
    }
  }
  return { mirrorCents: limitations.length ? null : knownCents, knownCents, components, limitations };
}
function compareAccounts(mirrored, live, currency) {
  const sides = [mirrored.map(row => ({ id: row.qboId, record: row.record })), live.map(record => ({ id: record.Id, record }))];
  const maps = sides.map(rows => {
    const entries = new Map();
    for (const { id, record } of rows) {
      if (!plain(record) || !ACCOUNT_TYPES.has(record.AccountType)) throw fail('An Account record has missing or unsupported account type evidence.');
      if (!accountType(record)) continue;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || entries.has(id)) throw fail('Bank account identities are incomplete or repeated.');
      const amount = moneyCents(record.CurrentBalance), accountCurrency = record.CurrencyRef?.value || currency;
      if (amount === null || !/^[A-Z]{3}$/.test(accountCurrency || '')) throw fail('A bank or credit-card balance or currency is missing.');
      entries.set(id, { cents: amount, currency: accountCurrency, type: record.AccountType });
    }
    return entries;
  });
  const accounts = [...new Set([...maps[0].keys(), ...maps[1].keys()])].sort().map(qboId => {
    const mirror = maps[0].get(qboId), qbo = maps[1].get(qboId);
    const matched = Boolean(mirror && qbo && mirror.cents === qbo.cents && mirror.currency === qbo.currency && mirror.type === qbo.type);
    return { qboId, status: matched ? 'matched' : 'mismatched', mirrorCents: mirror?.cents ?? null, qboCents: qbo?.cents ?? null,
      mirrorCurrency: mirror?.currency ?? null, qboCurrency: qbo?.currency ?? null };
  });
  return { status: accounts.every(row => row.status === 'matched') ? 'matched' : 'mismatched', accounts };
}
function amountStatus(checks) {
  const values = Object.values(checks);
  if (values.some(row => ['mismatched', 'error'].includes(row.status))) return 'attention';
  if (values.some(row => row.status === 'resyncing')) return 'resyncing';
  if (values.some(row => row.status === 'unverified')) return 'unverified';
  return values.every(row => row.status === 'matched') ? 'matched' : 'checking';
}
const TIMING_NOTE = 'CDC was refreshed before comparison. QuickBooks reads are not atomic: records can change between the change read and report/account read.';
const REPORT_NOTE = 'Expected aging totals net mirrored open balances, unapplied payments, remaining credits and customer/vendor journal lines. Missing types, fields or unsupported refund/currency effects are unverified, never assumed zero.';
module.exports = { DEFINITIONS, moneyCents, parseAgingReport, readAmountMirror, mirrorTotal, agingEntities, agingMirrorTotal, compareAccounts, amountStatus, TIMING_NOTE, REPORT_NOTE };
