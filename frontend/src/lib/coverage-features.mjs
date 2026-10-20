// Adapt the existing company read into feature presence, keeping activity age
// separate and preserving failed reads, manual evidence, and minimum volumes.
const NAMES = {
  'active-customers': 'Customers', 'active-vendors': 'Vendors',
  'customer-provinces': 'Customers across provinces', 'customers-owing': 'Customers with unpaid balances',
  'vendors-owed': 'Vendors with unpaid balances', 'inactive-customer': 'Inactive customers',
  'inactive-vendor': 'Inactive vendors', 'inactive-item': 'Inactive products and services',
  'inactive-account': 'Inactive accounts', 'class-tracking': 'Class tracking',
  'location-tracking': 'Location tracking', 'inventory-tracking': 'Inventory quantity tracking',
  'custom-txn-numbers': 'Custom transaction numbers', 'multicurrency-on': 'Multicurrency',
  'tax-codes': 'Sales tax codes', budgets: 'Budgets', 'books-closed': 'Closed accounting periods',
  classes: 'Multiple classes', locations: 'Multiple locations',
}
export function featureName(signal) { return NAMES[signal.key] || signal.label || signal.key }
export function featureState(signal) {
  if (signal.status === 'manual') return 'manual'
  if (signal.status === 'error') return 'unverified'
  if (signal.status === 'ok') return 'available'
  if (signal.status === 'stale' && (signal.count > 0 || signal.last)) return 'available'
  if (signal.blockedBy) return 'blocked'
  if (signal.status === 'missing' && signal.kind === 'setup' && signal.count > 0) {
    return ['active-customers', 'active-vendors'].includes(signal.key) ? 'limited' : 'incomplete'
  }
  if (signal.status === 'missing') return 'missing'
  return 'unverified'
}
export function featureGroup(signal) {
  const state = featureState(signal)
  if (state === 'available' || state === 'limited') return 'available'
  return state === 'missing' || state === 'incomplete' ? 'missing' : 'verification'
}
export function filterFeatureAreas(areas, { query = '', domain = 'all', view = 'all' } = {}) {
  const search = query.trim().toLocaleLowerCase()
  return areas.flatMap(area => {
    if (domain !== 'all' && area.domain !== domain) return []
    const wholeArea = !search || `${area.name} ${area.domain}`.toLocaleLowerCase().includes(search)
    const signals = area.signals.filter(signal => (wholeArea || `${featureName(signal)} ${signal.label || ''}`.toLocaleLowerCase().includes(search)) && (view === 'all' || featureGroup(signal) === view))
    return signals.length ? [{ ...area, signals }] : []
  })
}
const RECORD_GROUPS = {
  Customer: ['active-customers', 'sub-customers', 'customer-terms', 'customer-provinces', 'inactive-customer', 'customers-owing', 'projects'],
  Vendor: ['active-vendors', 'vendor-terms', 'vendors-owed', 'inactive-vendor'],
  Item: ['service-items', 'inventory-items', 'non-inventory-items', 'bundles', 'inactive-item'],
  Account: ['cash-accounts', 'asset-accounts', 'liability-accounts', 'cogs-accounts', 'sub-accounts', 'inactive-account'],
  Estimate: ['estimates'],
  Invoice: ['estimate-to-invoice', 'invoices', 'partly-paid-invoices', 'current-invoices', 'overdue-invoices', 'billable-expenses', 'taxed-sales', 'project-invoices', 'class-tagged-sales', 'foreign-sales', 'custom-field-values'],
  Payment: ['payments', 'unapplied-payments', 'multi-invoice-payments'],
  CreditMemo: ['credit-memos'], SalesReceipt: ['sales-receipts'], RefundReceipt: ['refund-receipts'],
  PurchaseOrder: ['purchase-orders'], Bill: ['po-to-bill', 'bills', 'partly-paid-bills', 'current-bills', 'overdue-bills', 'taxed-purchases', 'project-costs', 'class-tagged-costs', 'foreign-bills'],
  BillPayment: ['bill-payments', 'card-bill-payments'], VendorCredit: ['vendor-credits'],
  Purchase: ['cheques-and-cash', 'card-charges', 'card-credits'],
  Deposit: ['deposits', 'grouped-deposits'], Transfer: ['transfers'],
  JournalEntry: ['journal-entries', 'adjusting-entries'], TimeActivity: ['time-entries', 'billable-time', 'project-time'],
}
export function featureRecordType(signal) {
  return Object.entries(RECORD_GROUPS).find(([, keys]) => keys.includes(signal.key))?.[0] || null
}
