'use strict';
// Versioned support situations seeded by discovery keys. A field/state is not posting proof.
const discovery = require('../../../docs/discovery/catalog.v1.json');
const VERSION = 1;
const AREA_NAMES = Object.fromEntries(discovery.capabilities.map(c => [c.key,c.name]));
const rows = [], line = r => Array.isArray(r.Line) ? r.Line : [];
const details = r => line(r).flatMap(l => Object.entries(l).filter(([k,v]) => k.endsWith('Detail') && v && typeof v === 'object').map(([,v]) => v));
const links = r => [...(r.LinkedTxn || []), ...line(r).flatMap(l => l.LinkedTxn || [])];
const linked = (r,t) => links(r).some(l => l.TxnType === t);
const refs = (r,k) => [r[k]?.value,...details(r).map(d => d[k]?.value)].filter(Boolean).map(String);
const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const positive = v => finite(v) && Number(v)>0, zero = v => finite(v) && Number(v)===0;
const voided = r => /^(void|voided)$/i.test(r.TxnStatus || r.status || '') || zero(r.TotalAmt) && /^void(?:ed)?(?:\s|:|$)/i.test(r.PrivateNote || '');
const deleted = row => row.deleted === true || row.record?.status === 'Deleted';
const taxIds = r => [...new Set(details(r).map(d => d.TaxCodeRef?.value).filter(Boolean).map(String))];
const taxName = (r,c,re) => taxIds(r).some(id => re.test(c.byId.get('TaxCode:'+id)?.Name || ''));
const settings = {
  classes:p => p.AccountingInfoPrefs?.ClassTrackingPerTxn || p.AccountingInfoPrefs?.ClassTrackingPerTxnLine,
  locations:p => p.AccountingInfoPrefs?.TrackDepartments,
  inventory:p => p.ProductAndServicesPrefs?.QuantityOnHand,
  multicurrency:p => p.CurrencyPrefs?.MultiCurrencyEnabled,
};
const settingText = {classes:'Enable class tracking',locations:'Enable location tracking',inventory:'Enable inventory quantity tracking',multicurrency:'Owner must decide whether to enable multicurrency; it cannot be turned off'};
const entityArea = {
  Invoice:'sales.receivables-lifecycle',Payment:'sales.receivables-lifecycle',Estimate:'sales.receivables-lifecycle',SalesReceipt:'sales.receivables-lifecycle',CreditMemo:'sales.receivables-lifecycle',RefundReceipt:'sales.receivables-lifecycle',
  Bill:'expenses.payables-lifecycle',BillPayment:'expenses.payables-lifecycle',PurchaseOrder:'expenses.payables-lifecycle',VendorCredit:'expenses.payables-lifecycle',Purchase:'expenses.payables-lifecycle',
  Deposit:'banking.cash-and-clearing',Transfer:'banking.cash-and-clearing',JournalEntry:'accounting.journals-and-close',TimeActivity:'expenses.time-activity',InventoryAdjustment:'inventory.items',
  Item:'inventory.items',Customer:'sales.customers',Vendor:'expenses.vendors',Employee:'expenses.time-activity',Account:'accounting.chart-of-accounts',Class:'company.dimensions',Department:'company.dimensions',Term:'expenses.vendors',PaymentMethod:'banking.cash-and-clearing',
  Preferences:'company.preferences',Budget:'accounting.budgets',RecurringTransaction:'accounting.recurring-transactions',Attachable:'administration.attachments',TaxPayment:'tax.canadian-sales-tax',
};
const lists = new Set(['Item','Customer','Vendor','Employee','Account','Class','Department','Term','PaymentMethod','Preferences','Budget','RecurringTransaction','Attachable']);
function add(entity,key,label,match,extra={}) {
  const area=extra.area || entityArea[entity];
  if (!AREA_NAMES[area]) throw new Error('No discovery capability: '+area);
  rows.push({key:entity+'.'+key,entity,label,area,group:entity,kind:lists.has(entity)?'setup':'activity',match,...extra});
}
for (const entity of Object.keys(entityArea).filter(e => !lists.has(e))) {
  add(entity,'recorded','Recorded',r => !voided(r));
  add(entity,'deleted','Deleted record retained in mirror',()=>true,{tombstone:true,historyLimited:true,need:'Retain deletion tombstones; absence cannot establish that no deletion ever occurred.'});
  add(entity,'backdated','Dated before its creation day',r => r.TxnDate && r.MetaData?.CreateTime && r.TxnDate < r.MetaData.CreateTime.slice(0,10),{tool:'Historical creation is held; use retained history or request governed dated-history tooling.'});
  if (!['TimeActivity','InventoryAdjustment','TaxPayment'].includes(entity)) add(entity,'foreign-currency','Foreign currency',(r,c) => r.CurrencyRef?.value && r.CurrencyRef.value!==c.homeCurrency,{setting:'multicurrency',tool:'Add governed non-CAD writes and exchange-rate verification.',dependencies:['Preferences']});
}
for (const entity of ['Invoice','Payment','BillPayment','SalesReceipt']) add(entity,'voided','Voided with explicit void evidence',voided);
for (const entity of ['Invoice','Bill']) {
  add(entity,'open','Open and unpaid',r => positive(r.Balance) && finite(r.TotalAmt) && Number(r.Balance)===Number(r.TotalAmt));
  add(entity,'partially-paid','Partially paid',r => positive(r.Balance) && positive(r.TotalAmt) && Number(r.Balance)<Number(r.TotalAmt));
  add(entity,'paid','Fully paid',r => zero(r.Balance) && positive(r.TotalAmt) && !voided(r));
  add(entity,'overdue','Overdue and still open',(r,c) => positive(r.Balance) && r.DueDate && r.DueDate<c.today);
  add(entity,'terms','Payment terms',r => !!r.SalesTermRef?.value);
  add(entity,'credit-applied','Credit applied through settlement',(r,c) => c.creditApplied.has(entity+':'+r.Id),{dependencies:[entity==='Invoice'?'Payment':'BillPayment']});
}
for (const entity of ['Invoice','Estimate','SalesReceipt','CreditMemo','RefundReceipt','Bill','PurchaseOrder','VendorCredit','Purchase']) {
  add(entity,'multi-line','Several detail lines',r => details(r).length>1);
  add(entity,'taxed','Positive Canadian sales or purchase tax',r => positive(r.TxnTaxDetail?.TotalTax));
  add(entity,'multi-tax','Different tax codes on detail lines',r => taxIds(r).length>1);
  add(entity,'zero-rated','Explicit zero-rated code',(r,c) => taxName(r,c,/^zero[ -]?rated$/i),{dependencies:['TaxCode']});
  add(entity,'exempt','Explicit exempt code',(r,c) => taxName(r,c,/^exempt$/i),{dependencies:['TaxCode']});
  add(entity,'out-of-scope','Explicit out-of-scope code',(r,c) => taxName(r,c,/^out of scope$/i),{dependencies:['TaxCode']});
  add(entity,'tax-inclusive','Tax included in price',r => r.GlobalTaxCalculation==='TaxInclusive',{tool:'Add governed tax-inclusive pricing; general writes require TaxExcluded.'});
  add(entity,'class','Class on saved activity',r => refs(r,'ClassRef').length>0,{setting:'classes',dependencies:['Preferences']});
  add(entity,'location','Location on saved activity',r => refs(r,'DepartmentRef').length>0,{setting:'locations',dependencies:['Preferences']});
  add(entity,'custom-field','Custom field has a value',r => (r.CustomField || []).some(f => [f.StringValue,f.NumberValue,f.DateValue,f.BooleanValue].some(v => v!==undefined && v!==null && v!=='')),{tool:'Add governed custom-field values after inspecting field definitions.'});
  add(entity,'inventory-line','Inventory item line',(r,c) => details(r).some(d => c.byId.get('Item:'+d.ItemRef?.value)?.Type==='Inventory'),{dependencies:['Item'],...(['Bill','PurchaseOrder','Invoice'].includes(entity)?{need:'Use supported fixed stock workflows or an enabled verified inventory tool.'}:{tool:'Enable this inventory entity with dated FIFO and return valuation proof.'})});
}
for (const entity of ['Invoice','Estimate','SalesReceipt','CreditMemo','RefundReceipt']) {
  add(entity,'discounted','Discount detail line',r => line(r).some(l => l.DetailType==='DiscountLineDetail' && positive(l.Amount)),{tool:'Add governed discount-line writing; the current guard refuses DiscountLineDetail.'});
  add(entity,'out-of-province','Address outside company province',(r,c) => !!c.province && [r.ShipAddr?.CountrySubDivisionCode,r.BillAddr?.CountrySubDivisionCode].some(p => p && p!==c.province),{dependencies:['CompanyInfo'],tool:'Add governed delivery/address fields with applicable dated Canadian tax policy.',need:'Address difference proves geography only, not place-of-supply compliance.'});
  add(entity,'recurring','Native recurring-template link',r => !!r.RecurringInfo?.RecurDataRef?.value || linked(r,'RecurringTransaction'),{observable:false,tool:'Add native recurring-template evidence; repeated dates or descriptions do not prove recurrence.'});
}
add('Invoice','draft','Explicit draft state',r => r.TxnStatus==='Draft',{observable:false,tool:'Add native draft evidence; an unsent saved invoice is not proof of a draft.'});
add('Invoice','sent','Email explicitly sent',r => r.EmailStatus==='EmailSent',{tool:'Add governed invoice send/email; BillEmail alone does not send it.'});
add('Invoice','not-sent','Saved invoice marked not sent',r => ['NotSet','NeedToSend'].includes(r.EmailStatus));
add('Invoice','overpaid','Negative invoice balance',r => finite(r.Balance) && Number(r.Balance)<0,{tool:'Use supported excess-cash Payment; never fabricate a negative invoice balance.'});
add('Invoice','deposit','Invoice has deposit amount',r => positive(r.Deposit),{tool:'Add Invoice.Deposit support and cash-posting proof.'});
add('Invoice','estimate-linked','Estimate linked',r => linked(r,'Estimate'));
add('Invoice','time-linked','Billable time linked',r => linked(r,'TimeActivity'));
add('Invoice','billable-expense-linked','Billable expense linked',r => ['ReimburseCharge','Bill','Purchase'].some(t=>linked(r,t)),{tool:'Add billable-charge invoicing with source reimbursement verification.'});
add('Invoice','progress','Explicit progress invoice',r => linked(r,'Estimate') && r.ProgressInvoice===true,{observable:false,tool:'Add native progress-invoice evidence and verified progress tooling.'});
for (const entity of ['Payment','BillPayment']) {
  const obligation=entity==='Payment'?'Invoice':'Bill',credit=entity==='Payment'?'CreditMemo':'VendorCredit';
  add(entity,'single-obligation','Applied to one obligation',r => new Set(links(r).filter(l=>l.TxnType===obligation).map(l=>l.TxnId)).size===1);
  add(entity,'multiple-obligations','Applied to multiple obligations',r => new Set(links(r).filter(l=>l.TxnType===obligation).map(l=>l.TxnId)).size>1);
  add(entity,'credit-application','Credit and obligation linked',r => linked(r,credit) && linked(r,obligation));
  add(entity,'zero-cash-credit','Zero-cash credit application',r => zero(r.TotalAmt) && linked(r,credit) && linked(r,obligation) && !voided(r));
  add(entity,'late','Applied after obligation due date',(r,c) => links(r).some(l => l.TxnType===obligation && c.byId.get(obligation+':'+l.TxnId)?.DueDate<r.TxnDate),{dependencies:[obligation]});
}
add('Payment','unapplied','Unapplied customer cash',r => positive(r.UnappliedAmt));
add('Payment','overpayment','Excess cash after invoice application',r => positive(r.UnappliedAmt) && linked(r,'Invoice'));
add('Payment','deposited','Payment linked to deposit',r => linked(r,'Deposit'));
add('BillPayment','cheque','Bank/cheque payment',r => r.PayType==='Check');
add('BillPayment','credit-card','Credit-card payment',r => r.PayType==='CreditCard');
for (const s of ['Pending','Accepted','Rejected','Closed']) add('Estimate',s.toLowerCase(),s,r=>r.TxnStatus===s);
add('Estimate','expired','Expired and not closed/rejected',(r,c) => !!r.ExpirationDate && r.ExpirationDate<c.today && !['Closed','Rejected'].includes(r.TxnStatus));
add('Estimate','converted','Converted with invoice link',(r,c) => linked(r,'Invoice') || c.estimateInvoiced.has(String(r.Id)),{dependencies:['Invoice']});
for (const entity of ['CreditMemo','VendorCredit']) {
  add(entity,'open','Unapplied credit remains',r=>positive(r.RemainingCredit ?? r.Balance));
  add(entity,'partially-applied','Partly applied credit',r=>positive(r.RemainingCredit ?? r.Balance) && positive(r.TotalAmt) && Number(r.RemainingCredit ?? r.Balance)<Number(r.TotalAmt));
  add(entity,'fully-applied','Fully applied credit',r=>zero(r.RemainingCredit ?? r.Balance) && positive(r.TotalAmt));
}
for (const entity of ['SalesReceipt','RefundReceipt']) {
  add(entity,'payment-method','Payment method specified',r=>!!r.PaymentMethodRef?.value);
  add(entity,'bank-account','Bank/cash account specified',r=>!!r.DepositToAccountRef?.value);
}
add('SalesReceipt','deposited','Receipt linked to deposit',r=>linked(r,'Deposit'));
add('RefundReceipt','credit-linked','Refund linked to credit',r=>linked(r,'CreditMemo') || linked(r,'Payment'),{tool:'Add a verified linked-credit refund; standalone refunds do not apply open credits.'});
add('Bill','po-linked','Bill received from purchase order',r=>linked(r,'PurchaseOrder'));
for (const s of ['Open','Closed']) add('PurchaseOrder',s.toLowerCase(),s,r=>r.POStatus===s);
for (const [key,label,pred] of [['partially-received','Partially received',(o,r)=>r>0&&r<o],['fully-received','Fully received',(o,r)=>o>0&&r>=o]]) {
  add('PurchaseOrder',key,label,(r,c)=>pred(details(r).reduce((n,d)=>n+(Number(d.Qty)||0),0),c.poReceived.get(String(r.Id))||0),{dependencies:['Bill']});
}
for (const [key,label,pred] of [
  ['cheque','Cheque expense',r=>r.PaymentType==='Check'],['cash','Cash expense',r=>r.PaymentType==='Cash'],
  ['credit-card-charge','Credit-card charge',r=>r.PaymentType==='CreditCard'&&r.Credit!==true],['credit-card-credit','Credit-card credit',r=>r.PaymentType==='CreditCard'&&r.Credit===true],
  ['account-line','Category/account expense line',r=>line(r).some(l=>l.DetailType==='AccountBasedExpenseLineDetail')],['item-line','Item expense line',r=>line(r).some(l=>l.DetailType==='ItemBasedExpenseLineDetail')],
]) add('Purchase',key,label,pred);
for (const entity of ['Bill','Purchase','VendorCredit']) {
  add(entity,'billable','Billable expense line',r=>details(r).some(d=>d.BillableStatus==='Billable'),{tool:'Add governed billable-expense fields and reimbursement verification.'});
  add(entity,'billed','Expense line marked billed',r=>details(r).some(d=>d.BillableStatus==='HasBeenBilled'),{tool:'Add verified billable-expense invoicing.'});
  add(entity,'customer-linked','Expense linked to customer/job',r=>refs(r,'CustomerRef').length>0,{tool:'Add governed expense CustomerRef and billable linkage.'});
}
add('Deposit','grouped','Several receipts/payments grouped',r=>new Set(links(r).filter(l=>['Payment','SalesReceipt'].includes(l.TxnType)).map(l=>l.TxnType+':'+l.TxnId)).size>1);
add('Deposit','payment-linked','Existing payment deposited',r=>linked(r,'Payment'));
add('Deposit','receipt-linked','Sales receipt deposited',r=>linked(r,'SalesReceipt'));
add('Deposit','fee','Negative expense fee line',r=>line(r).some(l=>l.DetailType==='DepositLineDetail'&&Number(l.Amount)<0));
add('Deposit','direct-account','Direct-account deposit line',r=>details(r).some(d=>d.AccountRef?.value));
add('Transfer','bank-to-bank','Bank to bank',(r,c)=>['FromAccountRef','ToAccountRef'].every(k=>c.byId.get('Account:'+r[k]?.value)?.AccountType==='Bank'),{dependencies:['Account']});
add('Transfer','card-payment','Transfer involving credit card',(r,c)=>['FromAccountRef','ToAccountRef'].some(k=>c.byId.get('Account:'+r[k]?.value)?.AccountType==='Credit Card'),{dependencies:['Account']});
add('JournalEntry','adjusting','Adjusting journal',r=>r.Adjustment===true);
add('JournalEntry','multi-account','Three or more account lines',r=>details(r).length>=3);
add('JournalEntry','class','Class on journal line',r=>refs(r,'ClassRef').length>0,{setting:'classes',dependencies:['Preferences']});
add('JournalEntry','location','Location on journal line',r=>refs(r,'DepartmentRef').length>0,{setting:'locations',dependencies:['Preferences']});
add('JournalEntry','customer-vendor','Entity on journal line',r=>details(r).some(d=>d.Entity?.EntityRef?.value));
for (const s of ['Billable','NotBillable','HasBeenBilled']) add('TimeActivity',s.toLowerCase(),s,r=>r.BillableStatus===s);
add('TimeActivity','employee','Employee time',r=>r.NameOf==='Employee');
add('TimeActivity','vendor','Vendor time',r=>r.NameOf==='Vendor');
add('TimeActivity','minutes','Fractional-hour time',r=>positive(r.Minutes));
add('TimeActivity','class','Class on time',r=>!!r.ClassRef?.value,{setting:'classes',dependencies:['Preferences']});
add('TimeActivity','location','Location on time',r=>!!r.DepartmentRef?.value,{setting:'locations',dependencies:['Preferences']});
for (const [key,label,pred] of [['increase','Positive quantity adjustment',v=>positive(v)],['decrease','Negative quantity adjustment',v=>finite(v)&&Number(v)<0]]) add('InventoryAdjustment',key,label,r=>details(r).some(d=>pred(d.QtyDiff)),{tool:'Build a supported Canadian adjustment contract and independently dated valuation proof.'});
for (const entity of ['Customer','Vendor','Employee','Item','Account','Class','Department','Term','PaymentMethod']) {
  add(entity,'active','Active list record',r=>r.Active===true);
  add(entity,'inactive','Inactive list record',r=>r.Active===false);
}
for (const entity of ['Customer','Vendor']) {
  add(entity,'terms','Default payment terms',r=>!!(r.SalesTermRef?.value||r.TermRef?.value));
  add(entity,'open-balance','Open balance',r=>positive(r.Balance));
  add(entity,'foreign-currency','Foreign-currency party',(r,c)=>r.CurrencyRef?.value&&r.CurrencyRef.value!==c.homeCurrency,{setting:'multicurrency',tool:'Add governed non-CAD party maintenance.',dependencies:['Preferences']});
}
add('Customer','sub-customer','Sub-customer',r=>!!r.ParentRef?.value&&r.IsProject!==true);
add('Customer','job','Job customer',r=>r.Job===true);
add('Customer','bill-parent','Sub-customer billed with parent',r=>!!r.ParentRef?.value&&r.BillWithParent===true);
add('Customer','project','Native project',r=>r.IsProject===true,{tool:'Add native project management; a sub-customer alone is not a project.',area:'projects.project-lifecycle'});
add('Customer','tax-default','Default tax code',r=>!!r.DefaultTaxCodeRef?.value);
for (const type of ['Service','NonInventory','Inventory','Group']) add('Item',type.toLowerCase(),type+' item',r=>r.Type===type,{...(['Inventory','Group'].includes(type)?{tool:type==='Inventory'?'Use retained fixed stock setup; direct quantity changes remain held.':'Add governed bundle maintenance.'}:{})});
add('Item','sub-item','Sub-item',r=>r.SubItem===true&&!!r.ParentRef?.value);
add('Item','sku','SKU specified',r=>!!r.Sku);
add('Item','zero-stock','Zero stock',r=>r.Type==='Inventory'&&zero(r.QtyOnHand));
add('Item','negative-stock','Negative stock exception',r=>r.Type==='Inventory'&&finite(r.QtyOnHand)&&Number(r.QtyOnHand)<0,{tool:'Use an isolated approved negative-stock reproduction; do not force the running business below zero.'});
add('Item','positive-stock','Positive stock',r=>r.Type==='Inventory'&&positive(r.QtyOnHand));
add('Account','sub-account','Sub-account',r=>r.SubAccount===true&&!!r.ParentRef?.value);
for (const type of ['Bank','Credit Card','Accounts Receivable','Accounts Payable','Fixed Asset','Long Term Liability','Cost of Goods Sold','Other Income']) add('Account',type.toLowerCase().replace(/ /g,'-'),type+' account',r=>r.AccountType===type);
add('Class','subclass','Subclass',r=>r.SubClass===true);
add('Department','sub-location','Sub-location',r=>r.SubDepartment===true);
add('Term','date-driven','Day-of-month terms',r=>r.Type==='DATE_DRIVEN');
add('Term','early-discount','Early-payment discount',r=>positive(r.DiscountPercent));
for (const setting of ['classes','locations','inventory','multicurrency']) add('Preferences',setting,settingText[setting],r=>!!settings[setting](r),{setting,area:setting==='multicurrency'?'company.multicurrency':'company.preferences'});
add('Preferences','closing-date','Books protected through closing date',r=>!!r.AccountingInfoPrefs?.BookCloseDate,{owner:'Owner must set and attest closing date/password in QuickBooks.',area:'accounting.journals-and-close'});
for (const [entity,key,label,area,need] of [
  ['Budget','budget','Budget exists','accounting.budgets','Add native budget evidence and governed budget tools.'],
  ['RecurringTransaction','template','Native recurring template','accounting.recurring-transactions','Add native recurring-template mirroring and management.'],
  ['Attachable','attached','Attached document or note','administration.attachments','Add attachment mirroring; file upload requires a separate governed tool.'],
  ['TaxPayment','tax-payment','Tax-centre payment','tax.canadian-sales-tax','Owner tax-centre evidence and supported tax workflows are required.'],
  ['Preferences','bank-reconciled','Bank/card reconciliation','accounting.reconciliation','Owner must supply statement and native reconciliation evidence.'],
  ['Preferences','payroll','Payroll processed','accounting.payroll-summary','Owner must supply payroll-run evidence; employee time is not payroll.'],
  ['Preferences','users','Company users and roles','users.qbo-company-roles','Owner must supply native user/role evidence.'],
]) add(entity,key,label,()=>false,{observable:false,tool:need,area,kind:'manual'});

add('Employee','billable-time','Billable time enabled',r=>r.BillableTime===true);
add('Employee','bill-rate','Employee bill rate',r=>positive(r.BillRate));
add('Employee','hired-date','Hire date retained',r=>!!r.HiredDate);
for(const entity of ['Customer','Vendor','Employee']) {
  add(entity,'email','Contact email',r=>!!r.PrimaryEmailAddr?.Address);
  add(entity,'phone','Contact phone',r=>!!r.PrimaryPhone?.FreeFormNumber);
}
add('Customer','shipping-address','Separate shipping address',r=>!!r.ShipAddr?.Line1);
add('Vendor','account-number','Supplier account number',r=>!!r.AcctNum);

for(const def of rows) if(['multi-tax','zero-rated','exempt','out-of-scope'].includes(def.key.split('.').at(-1)) && !['Invoice','SalesReceipt'].includes(def.entity)) def.tool='Extend the governed alternate tax-code policy for this entity and retain dated tax proof.';
module.exports={VERSION,SITUATIONS:Object.freeze(rows),AREA_NAMES,entityArea,settings,settingText,helpers:{line,details,links,refs,voided,deleted,finite}};
