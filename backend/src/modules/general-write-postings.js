'use strict';
// Declarative posting rules of the general governed write tool, contract general-write-v1
// (design rev 3, R1-1 and R2-1). Pure and entity-generic: a record's expected postings
// are derived from ITS OWN lines, never from the General Ledger, so a balanced posting to
// a wrong expense, income, bank or tax account is caught when its GL rows are compared.
//
// Signs: debit positive, credit negative, in cents, keyed by QuickBooks account id.
// Two comparisons, never mixed (R2-1):
//   - current postings: a record's current GL rows equal postingsOf(its current record)
//     (an update from $100 to $150 expects $150; a deleted or voided record expects none);
//   - period movement: date-allocated before/after differences (movementsOf).
// Provider presentation is audit data. Only typed accounting content participates in
// close comparisons; retained request/receipt bodies themselves are never rewritten.
const ACCOUNTING_FIELDS = new Set(['Id','TxnDate','DueDate','TotalAmt','HomeTotalAmt','Amount','Balance','HomeBalance','RemainingCredit','UnappliedAmt','CurrencyRef','ExchangeRate','GlobalTaxCalculation','TxnTaxDetail','TotalTax','TaxLine','TaxLineDetail','TaxRateRef','NetAmountTaxable','TaxPercent','PercentBased','Line','DetailType','SalesItemLineDetail','ItemBasedExpenseLineDetail','AccountBasedExpenseLineDetail','JournalEntryLineDetail','DepositLineDetail','DiscountLineDetail','SubTotalLineDetail','SalesItemLineGroupDetail','GroupLineDetail','Qty','UnitPrice','TaxInclusiveAmt','MarkupInfo','Percent','Value','PriceLevelRef','LinkedTxn','TxnId','TxnType','TxnLineId','PostingType','Credit','PaymentType','PayType','CheckPayment','CreditCardPayment','Entity','Type','BillableStatus','Billable','Taxable','Hours','Minutes','HourlyRate','StartTime','EndTime','BreakHours','BreakMinutes','TimeActivityType','NameOf','PurchaseCost','PurchaseTaxIncluded','SalesTaxIncluded','TrackQtyOnHand','QtyOnHand','InvStartDate','AccountType','AccountSubType','Active','status']);
function accountingView(value, key = '') {
  if (Array.isArray(value)) return value.map(row => accountingView(row, key));
  if (!value || typeof value !== 'object') return value;
  if (/Ref$/.test(key)) return { ...(value.value === undefined ? {} : { value: value.value }), ...(value.type === undefined ? {} : { type: value.type }) };
  return Object.fromEntries(Object.entries(value).filter(([field]) => ACCOUNTING_FIELDS.has(field) || /Ref$/.test(field)).map(([field, child]) => [field, accountingView(child, field)]));
}
const NON_POSTING = new Set(['Estimate', 'PurchaseOrder', 'TimeActivity', 'Attachable', 'Customer', 'Vendor', 'Employee', 'Item', 'Account', 'Class', 'Department', 'Term', 'PaymentMethod', 'Preferences']);
// Control side of each posting entity: +1 debit, -1 credit, for the record's gross.
const SALES = { Invoice: -1, SalesReceipt: -1, CreditMemo: 1, RefundReceipt: 1 }, PURCHASES = { Bill: 1, Purchase: 1, VendorCredit: -1 };
function fail(message) { throw Object.assign(new Error(message), { code: 'GENERAL_POSTING_UNSUPPORTED' }); }
function cents(value) { const n = Math.round(Number(value) * 100); if (typeof value !== 'number' || !Number.isSafeInteger(n) || Math.abs(value * 100 - n) > 0.00001) fail('A posting amount is not an exact cent value.'); return n; }
const id = ref => ref?.value == null ? null : String(ref.value);
// ctx: { get(entity, id) (the local copy), receivables, payables, undepositedFunds: account
// ids used when QuickBooks omits the control account, taxAccount(rateId, direction) }.
function nativePostingsOf(entity, record, ctx) {
  const out = new Map(), add = (account, amount) => { if (!account) fail(entity + ' has a posting without an account.'); if (amount) out.set(account, (out.get(account) || 0) + amount); };
  if (!record || NON_POSTING.has(entity)) return out;
  if (record.status === 'Voided' || record.PrivateNote?.startsWith?.('Voided')) {
    if (!require('./general-write-recovery').voidedRecord(record)) fail('A void must have zero amounts, tax and quantities.');
    return out;
  }
  const lines = Array.isArray(record.Line) ? record.Line : [];
  // A deposit clears the receipt's original Undeposited Funds posting even when
  // QBO's current receipt now names the deposit's bank.
  const receiptAccount = () => (record.LinkedTxn || []).some(link => link.TxnType === 'Deposit') ? ctx.undepositedFunds : id(record.DepositToAccountRef) || ctx.undepositedFunds;
  const sales = SALES[entity], purchases = PURCHASES[entity];
  if (sales !== undefined || purchases !== undefined) {
    // Each line posts to its own account (the item's income or expense account), with the
    // opposite sign of the control side; tax posts to the rate's published tax account.
    const lineSign = sales !== undefined ? sales : purchases, direction = sales !== undefined ? 'sales' : 'purchases';
    let gross = 0;
    for (const [lineIndex, line] of lines.entries()) {
      const type = line?.DetailType, detail = line?.[type];
      if (type === 'SubTotalLineDetail' || type === 'DescriptionOnly') continue;
      if (type === 'DiscountLineDetail') fail('Discount lines are not in general-write-v1.');
      let account;
      if (type === 'SalesItemLineDetail' || type === 'ItemBasedExpenseLineDetail') {
        const item = ctx.get('Item', id(detail?.ItemRef));
        if (!item) fail(entity + ' line item ' + id(detail?.ItemRef) + ' is not in the company copy.');
        if (item.Type === 'Inventory') {
          if (ctx.inventory?.enabled !== true || ctx.inventory.entities?.[entity] !== true) fail('Inventory postings for ' + entity + ' are disabled.');
          if (purchases !== undefined) {
            if (!['Bill', 'Purchase'].includes(entity) || record.Credit === true || type !== 'ItemBasedExpenseLineDetail') fail('Unsupported inventory purchase reversal.');
            account = id(item.AssetAccountRef);
          } else {
            if (type !== 'SalesItemLineDetail' || typeof ctx.stockCost !== 'function') fail('Inventory sales require independent FIFO replay.');
            const cost = ctx.stockCost(entity, record, lineIndex);
            if (!Number.isSafeInteger(cost) || (sales === -1 ? cost < 0 : cost > 0)) fail('Inventory line cost direction is invalid.');
            add(id(item.ExpenseAccountRef), cost); add(id(item.AssetAccountRef), -cost);
            account = id(item.IncomeAccountRef);
          }
        } else account = id(type === 'SalesItemLineDetail' ? item.IncomeAccountRef : item.ExpenseAccountRef) || id(item.IncomeAccountRef);
      } else if (type === 'AccountBasedExpenseLineDetail') account = id(detail?.AccountRef);
      else fail(entity + ' line type ' + type + ' has no posting rule.');
      const amount = cents(line.Amount); gross += amount; add(account, lineSign * amount);
    }
    for (const tax of record.TxnTaxDetail?.TaxLine || []) {
      const amount = cents(tax.Amount); if (!amount) continue;
      gross += amount; add(ctx.taxAccount(id(tax.TaxLineDetail?.TaxRateRef), direction), lineSign * amount);
    }
    const control = entity === 'Invoice' || entity === 'CreditMemo' ? id(record.ARAccountRef) || ctx.receivables
      : entity === 'Bill' || entity === 'VendorCredit' ? id(record.APAccountRef) || ctx.payables
      : entity === 'Purchase' ? id(record.AccountRef) : receiptAccount();
    // A Purchase with Credit:true is a refund from the payee: every sign flips.
    const flip = entity === 'Purchase' && record.Credit === true ? -1 : 1;
    if (flip === -1) for (const [account, amount] of out) out.set(account, -amount);
    add(control, -lineSign * gross * flip);
    return out;
  }
  switch (entity) {
    case 'Payment': {
      // All cash received (including unapplied/overpaid cash) credits receivables.
      // Later applications of the same cash do not post a second receipt.
      // A zero-funds credit application posts nothing.
      const total = cents(record.TotalAmt || 0); if (!total) return out;
      add(id(record.ARAccountRef) || ctx.receivables, -total); add(receiptAccount(), total); return out;
    }
    case 'BillPayment': {
      const total = cents(record.TotalAmt || 0); if (!total) return out;
      const bank = record.PayType === 'CreditCard' ? id(record.CreditCardPayment?.CCAccountRef) : id(record.CheckPayment?.BankAccountRef);
      add(id(record.APAccountRef) || ctx.payables, total); add(bank, -total); return out;
    }
    case 'Deposit': {
      let total = 0;
      for (const line of lines) {
        const amount = cents(line.Amount); total += amount;
        if ((line.LinkedTxn || []).length) add(ctx.undepositedFunds, -amount);
        // A negative fee debits its expense; linked cash still clears in full.
        else add(id(line.DepositLineDetail?.AccountRef), -amount);
      }
      add(id(record.DepositToAccountRef), total); return out;
    }
    case 'CreditCardPayment': { const amount=cents(record.Amount); add(id(record.BankAccountRef),-amount); add(id(record.CreditCardAccountRef),amount); return out; }
    case 'Transfer': { const amount = cents(record.Amount); add(id(record.FromAccountRef), -amount); add(id(record.ToAccountRef), amount); return out; }
    case 'JournalEntry':
      for (const line of lines) { const detail = line?.JournalEntryLineDetail; add(id(detail?.AccountRef), (detail?.PostingType === 'Debit' ? 1 : detail?.PostingType === 'Credit' ? -1 : fail('A journal line needs Debit or Credit.')) * cents(line.Amount)); }
      return out;
    default: return fail(entity + ' has no posting rule.');
  }
}
// A trusted current cash/credit application must also reconcile internally, even
// when its date is outside the period whose parent is being closed.
function settlementConsistent(entity, record) {
  if (!['Payment','BillPayment'].includes(entity)) return true;
  try {
    const total = cents(record.TotalAmt), left = record.UnappliedAmt === undefined ? null : cents(record.UnappliedAmt);
    let net = 0;
    for (const line of record.Line || []) {
      if (line.LinkedTxn?.length !== 1) return false;
      const type = line.LinkedTxn[0].TxnType, amount = cents(line.Amount);
      const normal = entity === 'Payment' ? 'Invoice' : 'Bill', credit = entity === 'Payment' ? 'CreditMemo' : 'VendorCredit';
      if (amount < 0 || ![normal, credit].includes(type)) return false;
      net += (type === credit ? -1 : 1) * amount;
    }
    return total >= 0 && net >= 0 && net <= total && Number.isSafeInteger(net) && (left === null || left >= 0 && net + left === total);
  } catch { return false; }
}
function postingsOf(entity, record, ctx) {
  const { currencyOf, foreignPostings } = require('./general-write-currency');
  if (!record || NON_POSTING.has(entity) || currencyOf(record) === 'CAD' || record.status === 'Voided' || record.PrivateNote?.startsWith?.('Voided')) return nativePostingsOf(entity, record, ctx);
  return foreignPostings(entity, record, ctx, nativePostingsOf, cents);
}
// Current postings: a record's GL rows ([{ accountId, cents }]) equal its rule postings.
function compareLedger(expected, rows) {
  const actual = new Map();
  for (const row of rows) if (row.cents) actual.set(String(row.accountId), (actual.get(String(row.accountId)) || 0) + row.cents);
  const differences = [];
  for (const account of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(account) || 0, got = actual.get(account) || 0;
    if (want !== got) differences.push({ accountId: account, expectedCents: want, actualCents: got });
  }
  return { ok: differences.length === 0, differences };
}
// Period movement: date-allocated before/after differences. The before-image's postings
// leave on its date; the after-image's arrive on its date. Returns [{ date, accountId, cents }].
function movementsOf(entity, before, after, ctx) {
  const rows = new Map(), put = (date, account, amount) => { if (!amount) return; const key = date + '|' + account; rows.set(key, (rows.get(key) || 0) + amount); };
  if (before) for (const [account, amount] of postingsOf(entity, before, ctx)) put(before.TxnDate, account, -amount);
  if (after) for (const [account, amount] of postingsOf(entity, after, ctx)) put(after.TxnDate, account, amount);
  return [...rows].filter(([, amount]) => amount).map(([key, amount]) => { const [date, accountId] = key.split('|'); return { date, accountId, cents: amount }; }).sort((a, b) => (a.date + a.accountId).localeCompare(b.date + b.accountId));
}
const isPosting = entity => !NON_POSTING.has(entity);
module.exports = { accountingView, settlementConsistent, postingsOf, compareLedger, movementsOf, isPosting, NON_POSTING };
