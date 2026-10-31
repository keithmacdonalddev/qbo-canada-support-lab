// Guided create fields. Server schemas decide which types and fields are available.
export const LABELS = { Purchase: 'Expense / cheque', Payment: 'Customer payment', BillPayment: 'Bill payment', Vendor: 'Supplier', Department: 'Location', Term: 'Payment terms', Attachable: 'Attached note', TimeActivity: 'Time entry' }
export const label = key => ({ TxnDate: 'Record date', CustomerRef: 'Customer', VendorRef: 'Supplier', SalesTermRef: 'Payment terms', DepositToAccountRef: 'Deposit / refund account', APAccountRef: 'Payables account', ARAccountRef: 'Receivables account', AccountRef: 'Account', FromAccountRef: 'From account', ToAccountRef: 'To account', EntityRef: 'Payee', GlobalTaxCalculation: 'Tax calculation', PrimaryEmailAddr: 'Email address', PrimaryPhone: 'Phone', GivenName: 'First name', FamilyName: 'Last name', DisplayName: 'Display name', DueDate: 'Due date', NameOf: 'Time recorded by', AttachableRef: 'Attach to record' }[key] || key.replace(/Ref$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'))
export const REFS = { CustomerRef: 'Customer', VendorRef: 'Vendor', EmployeeRef: 'Employee', ItemRef: 'Item', AccountRef: 'Account', APAccountRef: 'Account', ARAccountRef: 'Account', DepositToAccountRef: 'Account', FromAccountRef: 'Account', ToAccountRef: 'Account', IncomeAccountRef: 'Account', ExpenseAccountRef: 'Account', AssetAccountRef: 'Account', ClassRef: 'Class', DepartmentRef: 'Department', SalesTermRef: 'Term', TermRef: 'Term', PaymentMethodRef: 'PaymentMethod', DefaultTaxCodeRef: 'TaxCode', SalesTaxCodeRef: 'TaxCode', PurchaseTaxCodeRef: 'TaxCode', TaxCodeRef: 'TaxCode', EntityRef: 'Vendor' }
export const ENUMS = { PaymentType: ['Cash', 'Check', 'CreditCard'], PayType: ['Check', 'CreditCard'], NameOf: ['Employee', 'Vendor'], BillableStatus: ['NotBillable', 'Billable'], AccountType: ['Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset', 'Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability', 'Equity', 'Income', 'Cost of Goods Sold', 'Expense', 'Other Income', 'Other Expense'], PostingType: ['Debit', 'Credit'] }
export const NUMBERS = new Set(['Amount', 'UnitPrice', 'PurchaseCost', 'DueDays', 'DiscountDays', 'DiscountPercent', 'DayOfMonthDue', 'DueNextMonthDays', 'DiscountDayOfMonth', 'Hours', 'Minutes', 'HourlyRate', 'BillRate'])
const OMIT = new Set(['Line', 'TotalAmt', 'GlobalTaxCalculation', 'CurrencyRef', 'CheckPayment', 'CreditCardPayment', 'LinkedTxn', 'TxnStatus', 'POStatus', 'ParentRef', 'Job', 'BillWithParent', 'SubItem', 'SubAccount', 'SubClass', 'SubDepartment', 'TrackQtyOnHand', 'QtyOnHand', 'InvStartDate', 'Active', 'Taxable', 'Vendor1099', 'Credit', 'Adjustment', 'BillableTime', 'AttachableRef', 'FileName', 'ContentType', 'Category'])
const ADDRESS = ['BillAddr', 'ShipAddr', 'PrimaryAddr']
export function fieldsFor(schema) { return [...new Set([...schema.required, ...schema.optional])].filter(key => !OMIT.has(key) && !ADDRESS.includes(key)) }
export function enumFor(key, entity) { return key === 'Type' ? entity === 'Item' ? ['Service', 'NonInventory'] : entity === 'Term' ? ['STANDARD', 'DATE_DRIVEN'] : entity === 'PaymentMethod' ? ['NON_CREDIT_CARD', 'CREDIT_CARD'] : [] : ENUMS[key] }
export const lineMode = entity => ['Invoice', 'Estimate', 'SalesReceipt', 'CreditMemo', 'RefundReceipt'].includes(entity) ? 'sales' : ['Bill', 'Purchase', 'PurchaseOrder', 'VendorCredit'].includes(entity) ? 'purchase' : ['Payment', 'BillPayment'].includes(entity) ? 'payment' : entity === 'JournalEntry' ? 'journal' : entity === 'Deposit' ? 'deposit' : null
export const newLine = () => ({ key: crypto.randomUUID(), mode: 'item', item: '', account: '', quantity: '1', price: '', amount: '', tax: '', description: '', posting: 'Debit', linkId: '', linkType: '', party: '', partyType: 'Customer' })
export function composeRecord(schema, values, lines) {
  const payload = {}, entity = schema.entity, mode = lineMode(entity)
  for (const key of fieldsFor(schema)) {
    const value = values[key]
    if (value === '' || value == null) continue
    payload[key] = REFS[key] ? { value, ...(key === 'EntityRef' ? { type: 'Vendor' } : {}) } : NUMBERS.has(key) ? Number(value) : ['PrimaryEmailAddr', 'BillEmail'].includes(key) ? { Address: value } : key === 'PrimaryPhone' ? { FreeFormNumber: value } : key === 'CustomerMemo' ? { value } : value
  }
  for (const key of ADDRESS) if (schema.optional.includes(key) && values[key]) payload[key] = { Line1: values[key], City: values[key + 'City'] || '', CountrySubDivisionCode: values[key + 'Province'] || '', PostalCode: values[key + 'Postal'] || '', Country: 'Canada' }
  if (schema.taxDirection) payload.GlobalTaxCalculation = 'TaxExcluded'
  if (mode) payload.Line = lines.map(row => {
    const Amount = Math.round(Number(mode === 'sales' || mode === 'purchase' && row.mode === 'item' ? Number(row.quantity) * Number(row.price) : row.amount) * 100) / 100
    const base = { Amount, ...(row.description ? { Description: row.description } : {}) }
    if (mode === 'payment' || mode === 'deposit' && row.mode !== 'account') return { ...base, LinkedTxn: [{ TxnId: row.linkId, TxnType: row.linkType || (entity === 'Payment' ? 'Invoice' : entity === 'BillPayment' ? 'Bill' : 'Payment'), ...(mode === 'deposit' ? { TxnLineId: '0' } : {}) }] }
    const DetailType = mode === 'sales' ? 'SalesItemLineDetail' : mode === 'journal' ? 'JournalEntryLineDetail' : mode === 'deposit' ? 'DepositLineDetail' : row.mode === 'item' ? 'ItemBasedExpenseLineDetail' : 'AccountBasedExpenseLineDetail'
    const detail = mode === 'sales' || mode === 'purchase' && row.mode === 'item' ? { ItemRef: { value: row.item }, Qty: Number(row.quantity), UnitPrice: Number(row.price), TaxCodeRef: { value: row.tax } } : { AccountRef: { value: row.account }, ...(mode === 'purchase' ? { TaxCodeRef: { value: row.tax } } : {}) }
    if (mode === 'journal') { detail.PostingType = row.posting; if (row.party) detail.Entity = { Type: row.partyType, EntityRef: { value: row.party } } }
    return { ...base, DetailType, [DetailType]: detail }
  })
  if (mode === 'payment') payload.TotalAmt = Math.round(lines.reduce((sum, row) => sum + Number(row.amount) * (['CreditMemo', 'VendorCredit'].includes(row.linkType) ? -1 : 1), 0) * 100) / 100
  if (entity === 'BillPayment') { const card = values.PayType === 'CreditCard'; payload[card ? 'CreditCardPayment' : 'CheckPayment'] = { [card ? 'CCAccountRef' : 'BankAccountRef']: { value: values.paymentAccount } } }
  if (entity === 'Attachable') payload.AttachableRef = [{ EntityRef: { type: values.attachType, value: values.attachId }, IncludeOnSend: false }]
  return payload
}

// Keep only this tab's owner draft; no credentials or saved record payloads.
export const draftKey = scope => 'tdl-owner-record-v1:' + ['environment', 'realmId', 'connectionId'].map(key => scope?.[key] || '').join(':')
export function readOwnerDraft(scope, storage = null) {
  try { storage ||= sessionStorage; const value = JSON.parse(storage.getItem(draftKey(scope)) || 'null'); return value?.draft?.decisionKey && value.draft.operations?.length === 1 ? value : null } catch { return null }
}
export function keepOwnerDraft(scope, value, storage = sessionStorage) {
  if (value) storage.setItem(draftKey(scope), JSON.stringify({ ...value, result: value.result ? { status: value.result.status, safeToReplace: value.result.safeToReplace } : null }))
  else storage.removeItem(draftKey(scope))
}
