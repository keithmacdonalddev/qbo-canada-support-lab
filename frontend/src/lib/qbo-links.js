// Deep links into the QuickBooks Online web app so a record created or found
// here can be opened where the customer would actually see it.

const PAGES = {
  invoice: { page: 'invoice', param: 'txnId', label: 'Invoice' },
  payment: { page: 'recvpayment', param: 'txnId', label: 'Payment' },
  bill: { page: 'bill', param: 'txnId', label: 'Bill' },
  billpayment: { page: 'billpayment', param: 'txnId', label: 'Bill payment' },
  creditmemo: { page: 'creditmemo', param: 'txnId', label: 'Credit memo' },
  vendorcredit: { page: 'vendorcredit', param: 'txnId', label: 'Vendor credit' },
  estimate: { page: 'estimate', param: 'txnId', label: 'Estimate' },
  deposit: { page: 'deposit', param: 'txnId', label: 'Deposit' },
  journalentry: { page: 'journal', param: 'txnId', label: 'Journal entry' },
  salesreceipt: { page: 'salesreceipt', param: 'txnId', label: 'Sales receipt' },
  refundreceipt: { page: 'refundreceipt', param: 'txnId', label: 'Refund receipt' },
  purchase: { page: 'expense', param: 'txnId', label: 'Expense' },
  purchaseorder: { page: 'purchaseorder', param: 'txnId', label: 'Purchase order' },
  transfer: { page: 'transfer', param: 'txnId', label: 'Transfer' },
  customer: { page: 'customerdetail', param: 'nameId', label: 'Customer' },
  vendor: { page: 'vendordetail', param: 'nameId', label: 'Vendor' },
}

// AI write tools and the QuickBooks record each one produces.
export const TOOL_RECORD_TYPE = {
  createInvoice: 'invoice',
  applyPayment: 'payment',
  createBill: 'bill',
  applyBillPayment: 'billpayment',
}

// Record type for a completed plan step: fixed for the older tools, reported
// by the server for createRecord / updateRecord / voidTransaction.
export function stepRecordType(step) {
  return TOOL_RECORD_TYPE[step?.toolName] || step?.result?.data?.entityType || null
}

export function qboRecordUrl(type, id, environment) {
  const entry = PAGES[String(type || '').toLowerCase()]
  if (!entry || !id) return null
  const host = environment === 'production' ? 'https://qbo.intuit.com' : 'https://app.sandbox.qbo.intuit.com'
  return `${host}/app/${entry.page}?${entry.param}=${encodeURIComponent(id)}`
}

export function qboRecordLabel(type) {
  return PAGES[String(type || '').toLowerCase()]?.label || 'Record'
}
