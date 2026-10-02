// How each QuickBooks record type reads on the Records page: its name, what
// a search matches, the columns worth scanning, and its plain-English status.
import { isPastDue } from './format'

const party = (r) => r.CustomerRef?.name || r.VendorRef?.name || r.EntityRef?.name || r.EmployeeRef?.name || null

export const RECORD_GROUPS = [
  { label: 'Sales', types: ['Invoice', 'Payment', 'SalesReceipt', 'Estimate', 'CreditMemo', 'RefundReceipt', 'Customer'] },
  { label: 'Expenses', types: ['Bill', 'BillPayment', 'Purchase', 'PurchaseOrder', 'VendorCredit', 'Vendor'] },
  { label: 'Banking and accounting', types: ['Deposit', 'Transfer', 'JournalEntry', 'TimeActivity', 'Account', 'Item'] },
]

export const RECORD_TYPES = {
  Invoice: { plural: 'Invoices', one: 'Invoice', search: 'Invoice number', cols: ['number', 'customer', 'date', 'due', 'total', 'balance', 'status'] },
  Payment: { plural: 'Payments', one: 'Payment', search: null, cols: ['date', 'customer', 'total', 'unapplied'] },
  SalesReceipt: { plural: 'Sales receipts', one: 'Sales receipt', search: 'Receipt number', cols: ['number', 'customer', 'date', 'total'] },
  Estimate: { plural: 'Estimates', one: 'Estimate', search: 'Estimate number', cols: ['number', 'customer', 'date', 'total', 'status'] },
  CreditMemo: { plural: 'Credit memos', one: 'Credit memo', search: 'Credit memo number', cols: ['number', 'customer', 'date', 'total', 'remaining', 'status'] },
  RefundReceipt: { plural: 'Refunds', one: 'Refund receipt', search: 'Refund number', cols: ['number', 'customer', 'date', 'total'] },
  Customer: { plural: 'Customers', one: 'Customer', search: 'Customer name', cols: ['name', 'email', 'openBalance', 'active'], isList: true },
  Bill: { plural: 'Bills', one: 'Bill', search: 'Bill number', cols: ['number', 'vendor', 'date', 'due', 'total', 'balance', 'status'] },
  BillPayment: { plural: 'Bill payments', one: 'Bill payment', search: 'Cheque or reference number', cols: ['number', 'vendor', 'date', 'total', 'payType'] },
  Purchase: { plural: 'Expenses', one: 'Expense', search: 'Reference number', cols: ['number', 'payee', 'date', 'paidFrom', 'total'] },
  PurchaseOrder: { plural: 'Purchase orders', one: 'Purchase order', search: 'PO number', cols: ['number', 'vendor', 'date', 'total', 'poStatus'] },
  VendorCredit: { plural: 'Vendor credits', one: 'Vendor credit', search: 'Credit number', cols: ['number', 'vendor', 'date', 'total'] },
  Vendor: { plural: 'Vendors', one: 'Vendor', search: 'Vendor name', cols: ['name', 'email', 'openBalance', 'active'], isList: true },
  Deposit: { plural: 'Deposits', one: 'Deposit', search: null, cols: ['date', 'depositTo', 'total', 'memo'] },
  Transfer: { plural: 'Transfers', one: 'Transfer', search: null, cols: ['date', 'transferFrom', 'transferTo', 'amount'] },
  JournalEntry: { plural: 'Journal entries', one: 'Journal entry', search: 'Journal number', cols: ['number', 'date', 'total', 'memo'] },
  TimeActivity: { plural: 'Time entries', one: 'Time entry', search: null, cols: ['date', 'worker', 'customer', 'hours'] },
  Account: { plural: 'Accounts', one: 'Account', search: 'Account name', cols: ['name', 'accountType', 'accountBalance', 'active'], isList: true },
  Item: { plural: 'Products and services', one: 'Product or service', search: 'Product or service name', cols: ['name', 'itemType', 'price', 'active'], isList: true },
}

export const DEFAULT_TYPE = 'Invoice'

// QuickBooks names linked transactions differently from the record types
// it reads; map them back so links can be followed.
const LINK_TYPES = {
  invoice: 'Invoice', payment: 'Payment', receivepayment: 'Payment', creditmemo: 'CreditMemo', estimate: 'Estimate',
  salesreceipt: 'SalesReceipt', refundreceipt: 'RefundReceipt', bill: 'Bill', billpayment: 'BillPayment',
  billpaymentcheck: 'BillPayment', billpaymentcreditcard: 'BillPayment', vendorcredit: 'VendorCredit',
  purchase: 'Purchase', expense: 'Purchase', check: 'Purchase', creditcardcredit: 'Purchase', purchaseorder: 'PurchaseOrder',
  deposit: 'Deposit', transfer: 'Transfer', journalentry: 'JournalEntry', timeactivity: 'TimeActivity',
}

export function recordTypeForLink(txnType) {
  return LINK_TYPES[String(txnType || '').toLowerCase()] || null
}

export function typeLabel(type) {
  return RECORD_TYPES[type]?.one || String(type || 'Record').replace(/([a-z])([A-Z])/g, '$1 $2')
}

// Short title for one record: "Invoice 1042", "Ace Plumbing", "Payment".
export function recordTitle(type, r) {
  if (!r) return typeLabel(type)
  if (RECORD_TYPES[type]?.isList) return r.DisplayName || r.Name || `${typeLabel(type)} ${r.Id}`
  return r.DocNumber ? `${typeLabel(type)} ${r.DocNumber}` : typeLabel(type)
}

export function currencyOf(r) {
  return r?.CurrencyRef?.value || 'CAD'
}

const TONE = { ok: 'ok', attention: 'attention', danger: 'danger', muted: 'muted' }

function isVoided(r) {
  return /^voided/i.test(String(r.PrivateNote || '')) && Number(r.TotalAmt) === 0
}

// { label, tone } or null.
export function recordStatus(type, r) {
  if (!r) return null
  if (isVoided(r)) return { label: 'Voided', tone: TONE.muted }
  if (type === 'Invoice' || type === 'Bill') {
    const balance = Number(r.Balance)
    const total = Number(r.TotalAmt)
    if (!Number.isFinite(balance)) return null
    if (balance <= 0) return { label: 'Paid', tone: TONE.ok }
    if (isPastDue(r.DueDate)) return { label: 'Overdue', tone: TONE.danger }
    if (balance < total) return { label: 'Partly paid', tone: TONE.attention }
    return { label: type === 'Bill' ? 'Unpaid' : 'Open', tone: TONE.muted }
  }
  if (type === 'CreditMemo') {
    return Number(r.Balance) > 0 ? { label: 'Unapplied', tone: TONE.attention } : { label: 'Applied', tone: TONE.ok }
  }
  if (type === 'Estimate' && r.TxnStatus) {
    const tone = r.TxnStatus === 'Accepted' || r.TxnStatus === 'Closed' ? TONE.ok : r.TxnStatus === 'Rejected' ? TONE.danger : TONE.muted
    return { label: r.TxnStatus, tone }
  }
  if (type === 'PurchaseOrder' && r.POStatus) {
    return { label: r.POStatus, tone: r.POStatus === 'Closed' ? TONE.ok : TONE.muted }
  }
  if (type === 'Payment' && Number(r.UnappliedAmt) > 0) return { label: 'Not fully applied', tone: TONE.attention }
  if (RECORD_TYPES[type]?.isList && r.Active === false) return { label: 'Inactive', tone: TONE.muted }
  return null
}

const PAY_TYPES = { Check: 'Cheque', CreditCard: 'Credit card', Cash: 'Cash' }

// Column definitions. kind: text | money | date | status.
export const COLUMNS = {
  number: { label: 'No.', get: (r) => r.DocNumber || r.PaymentRefNum || '—', mono: true },
  customer: { label: 'Customer', get: (r) => r.CustomerRef?.name || '—', grow: true },
  vendor: { label: 'Vendor', get: (r) => r.VendorRef?.name || '—', grow: true },
  payee: { label: 'Payee', get: (r) => party(r) || '—', grow: true },
  worker: { label: 'Who', get: (r) => r.EmployeeRef?.name || r.VendorRef?.name || '—', grow: true },
  name: { label: 'Name', get: (r) => r.DisplayName || r.Name || '—', grow: true, strong: true },
  email: { label: 'Email', get: (r) => r.PrimaryEmailAddr?.Address || '—', secondary: true },
  date: { label: 'Date', get: (r) => r.TxnDate, kind: 'date' },
  due: { label: 'Due', get: (r) => r.DueDate, kind: 'date', secondary: true },
  total: { label: 'Total', get: (r) => r.TotalAmt, kind: 'money' },
  amount: { label: 'Amount', get: (r) => r.Amount, kind: 'money' },
  balance: { label: 'Balance', get: (r) => r.Balance, kind: 'money' },
  remaining: { label: 'Left to apply', get: (r) => r.RemainingCredit ?? r.Balance, kind: 'money' },
  openBalance: { label: 'Open balance', get: (r) => r.Balance, kind: 'money' },
  unapplied: { label: 'Unapplied', get: (r) => r.UnappliedAmt, kind: 'money' },
  accountBalance: { label: 'Balance', get: (r) => r.CurrentBalance, kind: 'money' },
  price: { label: 'Price', get: (r) => r.UnitPrice, kind: 'money' },
  payType: { label: 'Paid by', get: (r) => PAY_TYPES[r.PayType] || r.PayType || '—' },
  paidFrom: { label: 'Paid from', get: (r) => r.AccountRef?.name || '—' },
  depositTo: { label: 'Deposited to', get: (r) => r.DepositToAccountRef?.name || '—', grow: true },
  transferFrom: { label: 'From', get: (r) => r.FromAccountRef?.name || '—', grow: true },
  transferTo: { label: 'To', get: (r) => r.ToAccountRef?.name || '—', grow: true },
  hours: { label: 'Hours', get: (r) => (r.Hours != null || r.Minutes != null ? (Number(r.Hours || 0) + Number(r.Minutes || 0) / 60).toFixed(2) : '—'), numeric: true },
  memo: { label: 'Memo', get: (r) => r.PrivateNote || '—', grow: true, muted: true, secondary: true },
  accountType: { label: 'Type', get: (r) => r.AccountType || '—' },
  itemType: { label: 'Type', get: (r) => r.Type || '—' },
  active: { label: 'Status', kind: 'status' },
  status: { label: 'Status', kind: 'status' },
  poStatus: { label: 'Status', kind: 'status' },
}

// Every transaction this record points at, once each.
export function linkedRecords(r) {
  if (!r) return []
  const seen = new Set()
  const out = []
  const add = (link, amount) => {
    if (!link?.TxnId || !link?.TxnType) return
    const key = `${link.TxnType}:${link.TxnId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ txnType: link.TxnType, id: String(link.TxnId), type: recordTypeForLink(link.TxnType), amount })
  }
  for (const link of r.LinkedTxn || []) add(link)
  for (const line of r.Line || []) {
    for (const link of line.LinkedTxn || []) add(link, line.Amount)
  }
  return out
}

// Lines as plain rows: what, quantity and rate when there are any, money.
export function recordLines(r) {
  const rows = []
  for (const line of r?.Line || []) {
    const type = line.DetailType
    if (type === 'SubTotalLineDetail') continue
    const detail = line[type] || {}
    if (type === 'JournalEntryLineDetail') {
      const debit = detail.PostingType === 'Debit'
      rows.push({
        label: detail.AccountRef?.name || 'Account',
        sub: line.Description || detail.Entity?.EntityRef?.name || null,
        debit: debit ? line.Amount : null,
        credit: debit ? null : line.Amount,
      })
      continue
    }
    const links = (line.LinkedTxn || []).map((l) => `${typeLabel(recordTypeForLink(l.TxnType) || l.TxnType)} #${l.TxnId}`)
    const label = detail.ItemRef?.name || detail.AccountRef?.name || (links.length ? `Applied to ${links.join(', ')}` : null)
      || (type === 'DiscountLineDetail' ? 'Discount' : null) || line.Description || 'Line'
    rows.push({
      label,
      sub: label === line.Description ? null : line.Description || null,
      qty: detail.Qty ?? null,
      rate: detail.UnitPrice ?? null,
      tax: detail.TaxCodeRef?.value ?? null,
      amount: line.Amount,
    })
  }
  return rows
}

// The handful of facts worth reading before the raw fields.
export function recordFacts(type, r) {
  if (!r) return []
  const facts = []
  const push = (label, value, kind) => { if (value !== undefined && value !== null && value !== '') facts.push({ label, value, kind }) }
  push('Customer', r.CustomerRef?.name)
  push('Vendor', r.VendorRef?.name)
  push('Payee', r.EntityRef?.name)
  push('Employee', r.EmployeeRef?.name)
  push('Date', r.TxnDate, 'date')
  push('Due', r.DueDate, 'date')
  push('Terms', r.SalesTermRef?.name)
  push('Total', r.TotalAmt, 'money')
  push('Tax', r.TxnTaxDetail?.TotalTax, 'money')
  push('Amount', r.Amount, 'money')
  push('Balance', type === 'Account' ? r.CurrentBalance : r.Balance, 'money')
  push('Unapplied', r.UnappliedAmt, 'money')
  push('Paid from', r.AccountRef?.name || r.CheckPayment?.BankAccountRef?.name || r.CreditCardPayment?.CCAccountRef?.name)
  push('Deposit to', r.DepositToAccountRef?.name)
  push('From', r.FromAccountRef?.name)
  push('To', r.ToAccountRef?.name)
  push('Type', r.AccountType || (RECORD_TYPES[type]?.isList ? r.Type : null))
  push('Detail type', r.AccountSubType)
  push('Email', r.PrimaryEmailAddr?.Address)
  push('Phone', r.PrimaryPhone?.FreeFormNumber)
  push('Price', r.UnitPrice, 'money')
  push('Project', r.ProjectRef?.name || r.ProjectRef?.value)
  push('Memo', r.PrivateNote)
  push('Message on form', r.CustomerMemo?.value)
  return facts
}
