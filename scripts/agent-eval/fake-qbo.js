'use strict';

// An in-memory, simulated QuickBooks Online Canada company for agent evaluation.
// It implements only the client surface the Reproduce tools use (read, query,
// create, update, apiCall incl. delete/void and reports, getLastIntuitTid) and
// never touches the network. Validation is pragmatic, not a full QBO clone:
// it rejects obviously invalid payloads with QBO-style 400 errors so the model
// gets realistic feedback. Every call is recorded for grading.

const LIST_TYPES = ['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'Class', 'Department', 'Term', 'PaymentMethod', 'TaxCode', 'TaxRate', 'Preferences', 'CompanyInfo'];
const TXN_TYPES = ['Invoice', 'Payment', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate', 'Bill', 'BillPayment',
  'VendorCredit', 'Purchase', 'PurchaseOrder', 'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity'];
const ENTITY_TYPES = [...LIST_TYPES, ...TXN_TYPES];
const TYPE_BY_LOWER = new Map(ENTITY_TYPES.map((t) => [t.toLowerCase(), t]));
const NAME_TYPES = ['Customer', 'Vendor', 'Employee'];
const READ_ONLY_TYPES = ['TaxCode', 'TaxRate', 'Preferences', 'CompanyInfo'];
const SINGLETONS = ['Preferences', 'CompanyInfo'];
const DELETABLE = ['Bill', 'PurchaseOrder', 'Invoice', 'Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Estimate',
  'SalesReceipt', 'RefundReceipt', 'Purchase', 'JournalEntry', 'Deposit', 'Transfer', 'TimeActivity'];
const SALES_FORMS = ['Invoice', 'SalesReceipt', 'CreditMemo', 'Estimate', 'RefundReceipt'];
const PURCHASE_FORMS = ['Bill', 'Purchase', 'VendorCredit', 'PurchaseOrder'];

// Reference fields and the entity type they point to (null: resolved from context).
const REF_TYPES = {
  CustomerRef: 'Customer', VendorRef: 'Vendor', EmployeeRef: 'Employee', ItemRef: 'Item', ParentRef: null,
  AccountRef: 'Account', IncomeAccountRef: 'Account', ExpenseAccountRef: 'Account', AssetAccountRef: 'Account',
  DepositToAccountRef: 'Account', ARAccountRef: 'Account', APAccountRef: 'Account', BankAccountRef: 'Account',
  CCAccountRef: 'Account', FromAccountRef: 'Account', ToAccountRef: 'Account', TaxCodeRef: 'TaxCode',
  SalesTaxCodeRef: 'TaxCode', PurchaseTaxCodeRef: 'TaxCode', TaxRateRef: 'TaxRate', ClassRef: 'Class',
  DepartmentRef: 'Department', SalesTermRef: 'Term', PaymentMethodRef: 'PaymentMethod', EntityRef: null,
};

const ACCOUNT_TYPES = {
  Bank: { classification: 'Asset', debit: true, bs: true, subtypes: ['CashOnHand', 'Checking', 'MoneyMarket', 'RentsHeldInTrust', 'Savings', 'TrustAccounts'], defaultSub: 'Checking' },
  'Accounts Receivable': { classification: 'Asset', debit: true, bs: true, subtypes: ['AccountsReceivable'], defaultSub: 'AccountsReceivable' },
  'Other Current Asset': { classification: 'Asset', debit: true, bs: true, defaultSub: 'OtherCurrentAssets' },
  'Fixed Asset': { classification: 'Asset', debit: true, bs: true, defaultSub: 'OtherFixedAssets' },
  'Other Asset': { classification: 'Asset', debit: true, bs: true, defaultSub: 'OtherLongTermAssets' },
  'Accounts Payable': { classification: 'Liability', debit: false, bs: true, subtypes: ['AccountsPayable'], defaultSub: 'AccountsPayable' },
  'Credit Card': { classification: 'Liability', debit: false, bs: true, subtypes: ['CreditCard'], defaultSub: 'CreditCard' },
  'Other Current Liability': { classification: 'Liability', debit: false, bs: true, defaultSub: 'OtherCurrentLiabilities' },
  'Long Term Liability': { classification: 'Liability', debit: false, bs: true, defaultSub: 'OtherLongTermLiabilities' },
  Equity: { classification: 'Equity', debit: false, bs: true, defaultSub: 'OwnersEquity', subtypes: ['OpeningBalanceEquity', 'PartnersEquity',
    'RetainedEarnings', 'AccumulatedAdjustment', 'OwnersEquity', 'PaidInCapitalOrSurplus', 'PartnerContributions', 'PartnerDistributions',
    'PreferredStock', 'CommonStock', 'TreasuryStock', 'EstimatedTaxes', 'Healthcare', 'PersonalIncome', 'PersonalExpense', 'OwnerDrawings', 'ShareCapital'] },
  Income: { classification: 'Revenue', debit: false, bs: false, defaultSub: 'SalesOfProductIncome' },
  'Other Income': { classification: 'Revenue', debit: false, bs: false, defaultSub: 'OtherMiscellaneousIncome' },
  'Cost of Goods Sold': { classification: 'Expense', debit: true, bs: false, defaultSub: 'SuppliesMaterialsCogs' },
  Expense: { classification: 'Expense', debit: true, bs: false, defaultSub: 'OtherMiscellaneousServiceCost' },
  'Other Expense': { classification: 'Expense', debit: true, bs: false, defaultSub: 'OtherMiscellaneousExpense' },
};
const ACCOUNT_TYPE_BY_KEY = new Map(Object.keys(ACCOUNT_TYPES).map((t) => [t.replace(/\s+/g, '').toLowerCase(), t]));
// Detail types known to belong to one account type. Unknown detail types are
// accepted: the Canadian enum is not fully modelled here.
const SUBTYPE_OWNER = new Map(Object.entries(ACCOUNT_TYPES).flatMap(([t, info]) => (info.subtypes || []).map((s) => [s, t])));

// Fixed account Ids used by defaults and by graders.
const ACCOUNTS = { chequing: '1', savings: '2', visa: '3', ar: '4', ap: '5', undeposited: '6', inventory: '7', taxPayable: '8',
  openingEquity: '9', ownersEquity: '10', retained: '11', sales: '12', services: '13', cogs: '14', advertising: '15',
  officeSupplies: '16', rent: '17', utilities: '18', bankCharges: '19', repairs: '20', accrued: '21', professional: '22' };

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : NaN);

function qboError(message, code = '6000', status = 400) {
  const err = new Error(`QBO API error (HTTP ${status}): ${message}`);
  err.status = status;
  err.qboStage = 'api';
  err.qboCode = code;
  err.fakeQbo = true;
  return err;
}
const notFound = () => qboError("Object Not Found: Something you're trying to use has been made inactive or deleted. Check and try again.", '610');
const invalidRef = (field, id) => qboError(`Invalid Reference Id: Something you're trying to use has been made inactive. Check the fields with accounts, customers, items, vendors or employees. (${field} ${String(id).slice(0, 40)})`, '2500');
const missingParam = (field) => qboError(`Required param missing, need to supply the required value for the API: ${field}`, '2020');
const business = (message) => qboError(`Business Validation Error: ${message}`, '6000');

function createFakeQbo({ today = new Date().toISOString().slice(0, 10) } = {}) {
  const records = new Map(); // `${Type}:${Id}` -> stored record
  const meta = new Map(); // same key -> { preExisting, voided, deleted }
  const everExisted = new Set();
  const calls = [];
  const seq = { name: 60, account: 90, item: 20, txn: 150, other: 10, salesDoc: 1004, estimateDoc: 1001, poDoc: 1001 };
  let clockTick = 0;
  let lastTid = '';
  let seeding = true;

  const key = (type, id) => type + ':' + String(id);
  const now = () => new Date(Date.parse(today + 'T12:00:00-04:00') + (clockTick++) * 1000).toISOString().replace('.000Z', '-00:00');
  const live = (type, id) => { const k = key(type, id); const m = meta.get(k); return records.has(k) && !m?.deleted ? records.get(k) : null; };
  const allLive = (type) => [...records.entries()].filter(([k]) => k.startsWith(type + ':') && !meta.get(k)?.deleted).map(([, r]) => r);
  const isVoided = (type, id) => !!meta.get(key(type, id))?.voided;

  function nextId(type) {
    if (NAME_TYPES.includes(type)) return String(seq.name++);
    if (type === 'Account') return String(seq.account++);
    if (type === 'Item') return String(seq.item++);
    if (TXN_TYPES.includes(type)) return String(seq.txn++);
    return String(seq.other++);
  }

  // ---------------------------------------------------------------------------
  // Reference checks
  // ---------------------------------------------------------------------------
  function refTarget(field, ref, ownerType, parent) {
    if (field === 'ParentRef') return ownerType;
    if (field === 'EntityRef') {
      const t = ref.type || parent?.Type;
      return NAME_TYPES.includes(t) ? t : null;
    }
    return REF_TYPES[field];
  }

  function checkRefs(value, ownerType, missing, parent) {
    if (Array.isArray(value)) { value.forEach((v) => checkRefs(v, ownerType, missing, parent)); return; }
    if (!isObj(value)) return;
    for (const [field, item] of Object.entries(value)) {
      if (Object.hasOwn(REF_TYPES, field) && isObj(item) && item.value !== undefined && item.value !== null && item.value !== '') {
        const target = refTarget(field, item, ownerType, value);
        const id = String(item.value);
        const types = target ? [target] : NAME_TYPES;
        const found = types.map((t) => [t, live(t, id)]).find(([, r]) => r);
        if (!found || (Object.hasOwn(found[1], 'Active') && found[1].Active === false && !seeding)) {
          missing.push({ field, type: target || 'Name', id, everExisted: types.some((t) => everExisted.has(key(t, id))) });
        } else if (!item.name) {
          const r = found[1];
          item.name = r.DisplayName || r.FullyQualifiedName || r.Name || undefined;
          if (item.name === undefined) delete item.name;
        }
      }
      if (field === 'LinkedTxn' && Array.isArray(item)) {
        for (const link of item) {
          if (!isObj(link)) continue;
          const t = TYPE_BY_LOWER.get(String(link.TxnType || '').toLowerCase());
          if (!t || !live(t, link.TxnId)) missing.push({ field: 'LinkedTxn', type: link.TxnType, id: String(link.TxnId), everExisted: !!t && everExisted.has(key(t, link.TxnId)) });
          else link.TxnType = t;
        }
        continue;
      }
      checkRefs(item, ownerType, missing, value);
    }
  }

  // ---------------------------------------------------------------------------
  // Amount and tax calculation
  // ---------------------------------------------------------------------------
  const detailOf = (line) => line && (line.SalesItemLineDetail || line.ItemBasedExpenseLineDetail || line.AccountBasedExpenseLineDetail
    || line.DepositLineDetail || line.JournalEntryLineDetail || line.GroupLineDetail || null);

  function taxRateOf(codeId, side) {
    const code = live('TaxCode', codeId);
    if (!code) return 0;
    const list = (side === 'purchase' ? code.PurchaseTaxRateList : code.SalesTaxRateList)?.TaxRateDetail || [];
    return list.reduce((sum, d) => sum + (live('TaxRate', d.TaxRateRef?.value)?.RateValue || 0), 0) / 100;
  }

  function normalizeLines(type, record) {
    if (!Array.isArray(record.Line)) return;
    let nextLine = record.Line.reduce((m, l) => Math.max(m, Number(l?.Id) || 0), 0) + 1;
    record.Line = record.Line.filter((l) => isObj(l) && l.DetailType !== 'SubTotalLineDetail');
    record.Line.forEach((line, index) => {
      if (!line.Id) line.Id = String(nextLine++);
      line.LineNum = index + 1;
      const d = line.SalesItemLineDetail || line.ItemBasedExpenseLineDetail;
      if (d) {
        const qty = num(d.Qty); const price = num(d.UnitPrice); const amount = num(line.Amount);
        if (Number.isNaN(amount)) {
          if (!Number.isNaN(qty) && !Number.isNaN(price)) line.Amount = round2(qty * price);
          else throw missingParam('Line.Amount');
        } else if (!Number.isNaN(qty) && !Number.isNaN(price) && Math.abs(qty * price - amount) > 0.011) {
          throw business(`Amount is not equal to UnitPrice * Qty. Supplied value: ${amount}, calculated value: ${round2(qty * price)}.`);
        }
        if (!Number.isNaN(qty)) d.Qty = qty;
        if (!Number.isNaN(price)) d.UnitPrice = price;
      }
      if (line.DetailType !== 'DescriptionOnly') {
        const amount = num(line.Amount);
        if (Number.isNaN(amount)) throw missingParam('Line.Amount');
        line.Amount = round2(amount);
      }
    });
  }

  function computeTax(type, record) {
    const side = SALES_FORMS.includes(type) || type === 'Deposit' ? 'sales' : 'purchase';
    const mode = record.GlobalTaxCalculation || 'TaxExcluded';
    record.GlobalTaxCalculation = mode;
    const byCode = new Map();
    let subtotal = 0;
    for (const line of record.Line || []) {
      if (line.DetailType === 'DescriptionOnly' || line.DetailType === 'SubTotalLineDetail') continue;
      if (line.DetailType === 'DiscountLineDetail') { subtotal -= line.Amount; continue; }
      const d = detailOf(line);
      const code = d?.TaxCodeRef?.value;
      const rate = code && mode !== 'NotApplicable' ? taxRateOf(code, side) : 0;
      let net = line.Amount;
      let tax = round2(net * rate);
      if (mode === 'TaxInclusive') {
        // QBO stores the net Amount with the gross in TaxInclusiveAmt; accept a
        // gross-only Amount and normalize it the same way.
        const gross = Number.isFinite(num(line.TaxInclusiveAmt)) ? num(line.TaxInclusiveAmt) : line.Amount;
        net = Number.isFinite(num(line.TaxInclusiveAmt)) ? line.Amount : round2(gross / (1 + rate));
        tax = round2(gross - net);
        line.Amount = net;
        line.TaxInclusiveAmt = round2(gross);
      }
      subtotal += net;
      if (code) {
        const entry = byCode.get(code) || { net: 0, tax: 0, rate };
        entry.net += net; entry.tax += tax; byCode.set(code, entry);
      }
    }
    const taxLines = [...byCode.entries()].filter(([, e]) => e.rate > 0).map(([code, e]) => {
      const detail = (side === 'purchase' ? live('TaxCode', code).PurchaseTaxRateList : live('TaxCode', code).SalesTaxRateList).TaxRateDetail[0];
      return { Amount: round2(e.tax), DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: detail.TaxRateRef.value },
        PercentBased: true, TaxPercent: round2(e.rate * 100), NetAmountTaxable: round2(e.net) } };
    });
    const totalTax = round2(taxLines.reduce((s, l) => s + l.Amount, 0));
    const firstCode = [...byCode.keys()][0];
    record.TxnTaxDetail = { ...(firstCode ? { TxnTaxCodeRef: { value: firstCode } } : {}), TotalTax: totalTax, TaxLine: taxLines };
    return { subtotal: round2(subtotal), totalTax };
  }

  // ---------------------------------------------------------------------------
  // Validation per entity
  // ---------------------------------------------------------------------------
  function requireRef(record, field) {
    if (!isObj(record[field]) || record[field].value === undefined || record[field].value === '') throw missingParam(field);
  }
  function requireLines(record) {
    if (!Array.isArray(record.Line) || !record.Line.length) throw missingParam('Line');
  }
  function accountOf(ref) { return ref ? live('Account', ref.value) : null; }
  function accountTypeOf(ref) { return accountOf(ref)?.AccountType; }
  function requireTaxCodes(type, record) {
    for (const line of record.Line || []) {
      const d = line.SalesItemLineDetail || line.ItemBasedExpenseLineDetail || line.AccountBasedExpenseLineDetail;
      if (d && !d.TaxCodeRef?.value) throw business('Make sure all your transactions have a GST/HST rate before you save.');
    }
  }

  function checkSalesLines(type, record) {
    requireLines(record);
    for (const line of record.Line) {
      if (!['SalesItemLineDetail', 'DescriptionOnly', 'DiscountLineDetail', 'SubTotalLineDetail', 'GroupLineDetail'].includes(line.DetailType)) {
        throw qboError(`Invalid Enumeration: Line.DetailType ${String(line.DetailType).slice(0, 40)} is not valid for ${type}.`, '2010');
      }
      if (line.DetailType === 'SalesItemLineDetail' && !line.SalesItemLineDetail?.ItemRef?.value) throw missingParam('Line.SalesItemLineDetail.ItemRef');
    }
  }
  function checkExpenseLines(type, record) {
    requireLines(record);
    for (const line of record.Line) {
      if (line.DetailType === 'AccountBasedExpenseLineDetail') {
        if (!line.AccountBasedExpenseLineDetail?.AccountRef?.value) throw missingParam('Line.AccountBasedExpenseLineDetail.AccountRef');
      } else if (line.DetailType === 'ItemBasedExpenseLineDetail') {
        if (!line.ItemBasedExpenseLineDetail?.ItemRef?.value) throw missingParam('Line.ItemBasedExpenseLineDetail.ItemRef');
      } else if (line.DetailType !== 'DescriptionOnly') {
        throw qboError(`Invalid Enumeration: Line.DetailType ${String(line.DetailType).slice(0, 40)} is not valid for ${type}.`, '2010');
      }
    }
  }

  function uniqueName(type, record, field, ignoreId) {
    const name = String(record[field] || '').trim().toLowerCase();
    const pool = NAME_TYPES.includes(type) ? NAME_TYPES : [type];
    for (const t of pool) {
      for (const other of allLive(t)) {
        if (String(other.Id) === String(ignoreId) && t === type) continue;
        if (String(other[field] || other.DisplayName || other.Name || '').trim().toLowerCase() === name) {
          throw qboError('Duplicate Name Exists Error: The name supplied already exists. : Another customer, vendor or employee is already using this name. Please use a different name.', '6240');
        }
      }
    }
  }

  function validate(type, record, existingId) {
    switch (type) {
      case 'Customer': case 'Vendor': case 'Employee': {
        if (!record.DisplayName) {
          const composed = [record.GivenName, record.FamilyName].filter(Boolean).join(' ') || record.CompanyName;
          if (!composed) throw missingParam('DisplayName');
          record.DisplayName = composed;
        }
        if (String(record.DisplayName).includes(':')) throw qboError('Invalid name: The name cannot contain a colon (:).', '6000');
        uniqueName(type, record, 'DisplayName', existingId);
        record.Active ??= true;
        if (type === 'Customer') { record.Job ??= false; record.BillWithParent ??= false; }
        record.PrintOnCheckName ??= record.DisplayName;
        if (record.ParentRef?.value) {
          const parent = live(type, record.ParentRef.value);
          record.Job ??= true;
          record.FullyQualifiedName = (parent.FullyQualifiedName || parent.DisplayName) + ':' + record.DisplayName;
        } else record.FullyQualifiedName = record.DisplayName;
        break;
      }
      case 'Account': {
        if (!record.Name) throw missingParam('Name');
        if (String(record.Name).includes(':')) throw qboError('Invalid name: Account names cannot contain a colon (:).', '6000');
        const canonical = ACCOUNT_TYPE_BY_KEY.get(String(record.AccountType || '').replace(/\s+/g, '').toLowerCase());
        if (!record.AccountType) throw missingParam('AccountType');
        if (!canonical) throw qboError(`Invalid Enumeration: ${String(record.AccountType).slice(0, 60)} is not a valid AccountType.`, '2010');
        record.AccountType = canonical;
        const info = ACCOUNT_TYPES[canonical];
        const owner = SUBTYPE_OWNER.get(record.AccountSubType);
        if (record.AccountSubType && owner && owner !== canonical) {
          throw qboError(`Invalid Enumeration: ${String(record.AccountSubType).slice(0, 60)} is not a valid AccountSubType for AccountType ${canonical}.`, '2010');
        }
        record.AccountSubType ||= info.defaultSub;
        record.Classification = info.classification;
        uniqueName(type, record, 'Name', existingId);
        const parentAccount = record.ParentRef?.value ? live('Account', record.ParentRef.value) : null;
        if (parentAccount && parentAccount.AccountType !== canonical) throw business(`A sub-account must have the same type as its parent account (${parentAccount.AccountType}).`);
        record.FullyQualifiedName = parentAccount ? parentAccount.FullyQualifiedName + ':' + record.Name : record.Name;
        record.SubAccount = !!record.ParentRef?.value;
        record.Active ??= true;
        record.CurrencyRef ||= { value: 'CAD', name: 'Canadian Dollar' };
        break;
      }
      case 'Item': {
        if (!record.Name) throw missingParam('Name');
        const t = record.Type || 'Service';
        if (!['Service', 'NonInventory', 'Inventory', 'Category'].includes(t)) throw qboError(`Invalid Enumeration: ${String(t).slice(0, 40)} is not a valid item Type.`, '2010');
        record.Type = t;
        uniqueName(type, record, 'Name', existingId);
        if (t === 'Inventory') {
          for (const f of ['IncomeAccountRef', 'ExpenseAccountRef', 'AssetAccountRef']) requireRef(record, f);
          if (record.TrackQtyOnHand !== true) throw business('TrackQtyOnHand must be true for an inventory item.');
          if (record._startQty === undefined) {
            if (!Number.isFinite(num(record.QtyOnHand))) throw missingParam('QtyOnHand');
            record._startQty = num(record.QtyOnHand);
          }
          record.QtyOnHand = record._startQty;
          if (!record.InvStartDate) throw missingParam('InvStartDate');
          if (accountTypeOf(record.AssetAccountRef) !== 'Other Current Asset') throw business('The inventory asset account must be an Other Current Asset account.');
        } else if (t !== 'Category' && !record.IncomeAccountRef?.value && !record.ExpenseAccountRef?.value) {
          throw missingParam('IncomeAccountRef');
        }
        for (const f of ['UnitPrice', 'PurchaseCost']) if (record[f] !== undefined) record[f] = num(record[f]) || 0;
        record.FullyQualifiedName = record.Name;
        record.Active ??= true;
        break;
      }
      case 'TaxCode': case 'TaxRate': case 'Preferences': case 'CompanyInfo':
        break;
      case 'Class': case 'Department': case 'Term': case 'PaymentMethod':
        if (!record.Name) throw missingParam('Name');
        uniqueName(type, record, 'Name', existingId);
        record.Active ??= true;
        record.FullyQualifiedName ??= record.Name;
        break;
      case 'Invoice': case 'Estimate': case 'CreditMemo': case 'SalesReceipt': case 'RefundReceipt': {
        if (type !== 'SalesReceipt') requireRef(record, 'CustomerRef');
        checkSalesLines(type, record);
        requireTaxCodes(type, record);
        if (['SalesReceipt', 'RefundReceipt'].includes(type)) {
          if (type === 'RefundReceipt') requireRef(record, 'DepositToAccountRef');
          record.DepositToAccountRef ||= { value: ACCOUNTS.undeposited, name: 'Undeposited Funds' };
          if (!['Bank', 'Other Current Asset', 'Credit Card'].includes(accountTypeOf(record.DepositToAccountRef))) throw business('Invalid account type: You need to select a different type of account for this transaction.');
        }
        if (type === 'Invoice') {
          for (const l of record.LinkedTxn || []) {
            const linked = live(l.TxnType, l.TxnId);
            if (l.TxnType !== 'Estimate' && l.TxnType !== 'TimeActivity') throw business('An invoice can only link estimates or time activities here.');
            if (l.TxnType === 'Estimate' && String(linked.CustomerRef?.value) !== String(record.CustomerRef.value)) throw business('The linked estimate belongs to a different customer.');
          }
        }
        break;
      }
      case 'Bill': case 'VendorCredit': case 'PurchaseOrder': {
        requireRef(record, 'VendorRef');
        checkExpenseLines(type, record);
        requireTaxCodes(type, record);
        if (type !== 'PurchaseOrder') record.APAccountRef ||= { value: ACCOUNTS.ap, name: 'Accounts Payable (A/P)' };
        if (record.APAccountRef && accountTypeOf(record.APAccountRef) !== 'Accounts Payable') throw business('APAccountRef must be an Accounts Payable account.');
        for (const line of record.Line) {
          for (const link of line.LinkedTxn || []) {
            if (link.TxnType !== 'PurchaseOrder') throw business('Bill lines can only link purchase orders.');
            const po = live('PurchaseOrder', link.TxnId);
            if (String(po.VendorRef?.value) !== String(record.VendorRef.value)) throw business('The linked purchase order belongs to a different vendor.');
            if (link.TxnLineId && !(po.Line || []).some((l) => String(l.Id) === String(link.TxnLineId))) throw business(`Purchase order ${po.Id} has no line ${String(link.TxnLineId).slice(0, 20)}.`);
          }
        }
        break;
      }
      case 'Purchase': {
        const pt = record.PaymentType;
        if (!pt) throw missingParam('PaymentType');
        if (!['Cash', 'Check', 'CreditCard'].includes(pt)) throw qboError(`Invalid Enumeration: ${String(pt).slice(0, 30)} is not a valid PaymentType.`, '2010');
        requireRef(record, 'AccountRef');
        const at = accountTypeOf(record.AccountRef);
        if ((pt === 'CreditCard' && at !== 'Credit Card') || (pt !== 'CreditCard' && !['Bank', 'Other Current Asset'].includes(at))) {
          throw business('Invalid account type: You need to select a different type of account for this transaction.');
        }
        checkExpenseLines(type, record);
        requireTaxCodes(type, record);
        break;
      }
      case 'Payment': {
        requireRef(record, 'CustomerRef');
        if (!Number.isFinite(num(record.TotalAmt))) throw missingParam('TotalAmt');
        record.TotalAmt = round2(num(record.TotalAmt));
        if (record.TotalAmt < 0) throw business('The payment amount cannot be negative.');
        record.DepositToAccountRef ||= { value: ACCOUNTS.undeposited, name: 'Undeposited Funds' };
        record.Line = Array.isArray(record.Line) ? record.Line : [];
        let applied = 0;
        const appliedNow = new Map();
        for (const line of record.Line) {
          const amount = num(line.Amount);
          if (Number.isNaN(amount) || amount < 0) throw missingParam('Line.Amount');
          line.Amount = round2(amount);
          for (const link of line.LinkedTxn || []) {
            if (!['Invoice', 'CreditMemo', 'JournalEntry'].includes(link.TxnType)) throw business('A payment can only be applied to invoices, credit memos or journal entries.');
            const target = live(link.TxnType, link.TxnId);
            if (link.TxnType !== 'JournalEntry' && String(target.CustomerRef?.value) !== String(record.CustomerRef.value)) {
              throw business("The transaction you're applying belongs to a different customer.");
            }
            if (isVoided(link.TxnType, link.TxnId)) throw business('You cannot apply a payment to a voided transaction.');
            const k = key(link.TxnType, link.TxnId);
            appliedNow.set(k, (appliedNow.get(k) || 0) + line.Amount);
            applied += link.TxnType === 'CreditMemo' ? -line.Amount : link.TxnType === 'Invoice' ? line.Amount : 0;
          }
        }
        const ledger = buildLedger(existingId ? key('Payment', existingId) : null);
        for (const [k, amount] of appliedNow) {
          const [t, id] = k.split(':');
          const open = t === 'Invoice' ? round2(live(t, id).TotalAmt - (ledger.applied.get(k) || 0))
            : t === 'CreditMemo' ? round2(live(t, id).TotalAmt - (ledger.creditUsed.get(k) || 0)) : Infinity;
          if (amount - open > 0.005) throw business(`The amount applied to ${t} ${id} (${round2(amount)}) exceeds its open balance (${open}).`);
        }
        if (round2(applied) - record.TotalAmt > 0.005) throw business('The payment amount must be greater than or equal to the sum of the amounts applied.');
        break;
      }
      case 'BillPayment': {
        requireRef(record, 'VendorRef');
        if (!Number.isFinite(num(record.TotalAmt))) throw missingParam('TotalAmt');
        record.TotalAmt = round2(num(record.TotalAmt));
        if (!['Check', 'CreditCard'].includes(record.PayType)) throw missingParam('PayType');
        if (record.PayType === 'Check') {
          if (!record.CheckPayment?.BankAccountRef?.value) throw missingParam('CheckPayment.BankAccountRef');
          if (accountTypeOf(record.CheckPayment.BankAccountRef) !== 'Bank') throw business('Invalid account type: the payment account must be a bank account.');
        } else {
          if (!record.CreditCardPayment?.CCAccountRef?.value) throw missingParam('CreditCardPayment.CCAccountRef');
          if (accountTypeOf(record.CreditCardPayment.CCAccountRef) !== 'Credit Card') throw business('Invalid account type: the payment account must be a credit card account.');
        }
        requireLines(record);
        const ledger = buildLedger(existingId ? key('BillPayment', existingId) : null);
        let applied = 0;
        for (const line of record.Line) {
          const amount = num(line.Amount);
          if (Number.isNaN(amount) || amount < 0) throw missingParam('Line.Amount');
          line.Amount = round2(amount);
          if (!Array.isArray(line.LinkedTxn) || !line.LinkedTxn.length) throw missingParam('Line.LinkedTxn');
          for (const link of line.LinkedTxn) {
            if (!['Bill', 'VendorCredit'].includes(link.TxnType)) throw business('A bill payment can only be applied to bills or vendor credits.');
            const target = live(link.TxnType, link.TxnId);
            if (String(target.VendorRef?.value) !== String(record.VendorRef.value)) throw business("The bill you're paying belongs to a different vendor.");
            const k = key(link.TxnType, link.TxnId);
            const open = round2(target.TotalAmt - (link.TxnType === 'Bill' ? ledger.applied.get(k) || 0 : ledger.creditUsed.get(k) || 0));
            if (line.Amount - open > 0.005) throw business(`The amount applied to ${link.TxnType} ${link.TxnId} (${line.Amount}) exceeds its open balance (${open}).`);
            applied += link.TxnType === 'Bill' ? line.Amount : -line.Amount;
          }
        }
        if (round2(applied) - record.TotalAmt > 0.005) throw business('The bill payment total must cover the amounts applied.');
        break;
      }
      case 'Deposit': {
        requireRef(record, 'DepositToAccountRef');
        if (!['Bank', 'Other Current Asset'].includes(accountTypeOf(record.DepositToAccountRef))) throw business('Invalid account type: deposits must go to a bank or other current asset account.');
        requireLines(record);
        for (const line of record.Line) {
          if (Array.isArray(line.LinkedTxn) && line.LinkedTxn.length) {
            for (const link of line.LinkedTxn) {
              if (!['Payment', 'SalesReceipt', 'RefundReceipt', 'JournalEntry'].includes(link.TxnType)) throw business('Deposits can only include payments, sales receipts or journal entries.');
            }
          } else {
            line.DetailType ||= 'DepositLineDetail';
            if (!line.DepositLineDetail?.AccountRef?.value) throw missingParam('Line.DepositLineDetail.AccountRef');
            if (String(line.DepositLineDetail.AccountRef.value) === String(record.DepositToAccountRef.value)) throw business("A deposit line can't use the account you're depositing to.");
          }
        }
        break;
      }
      case 'Transfer': {
        requireRef(record, 'FromAccountRef');
        requireRef(record, 'ToAccountRef');
        const amount = num(record.Amount);
        if (Number.isNaN(amount)) throw missingParam('Amount');
        if (amount <= 0) throw business('The transfer amount must be greater than zero.');
        record.Amount = round2(amount);
        if (String(record.FromAccountRef.value) === String(record.ToAccountRef.value)) throw business("The transfer from and to accounts can't be the same.");
        for (const f of ['FromAccountRef', 'ToAccountRef']) {
          const t = accountTypeOf(record[f]);
          if (!ACCOUNT_TYPES[t]?.bs) throw business(`Transfers can only use balance sheet accounts; ${accountOf(record[f]).Name} is an account of type ${t}.`);
        }
        break;
      }
      case 'JournalEntry': {
        requireLines(record);
        let debit = 0; let credit = 0;
        for (const line of record.Line) {
          if (line.DetailType !== 'JournalEntryLineDetail') throw qboError('Invalid Enumeration: journal entry lines must use DetailType JournalEntryLineDetail.', '2010');
          const d = line.JournalEntryLineDetail;
          if (!d || !['Debit', 'Credit'].includes(d.PostingType)) throw missingParam('Line.JournalEntryLineDetail.PostingType');
          if (!d.AccountRef?.value) throw missingParam('Line.JournalEntryLineDetail.AccountRef');
          const amount = num(line.Amount);
          if (Number.isNaN(amount)) throw missingParam('Line.Amount');
          if (amount < 0) throw business('Journal entry line amounts must be positive; use PostingType for direction.');
          line.Amount = round2(amount);
          const at = accountTypeOf(d.AccountRef);
          const entityType = d.Entity?.Type || d.Entity?.EntityRef?.type;
          if (at === 'Accounts Receivable' && (entityType !== 'Customer' || !d.Entity?.EntityRef?.value)) throw business('When you use Accounts Receivable, you must choose a customer in the Name field.');
          if (at === 'Accounts Payable' && (entityType !== 'Vendor' || !d.Entity?.EntityRef?.value)) throw business('When you use Accounts Payable, you must select a vendor in the Name field.');
          if (d.PostingType === 'Debit') debit += line.Amount; else credit += line.Amount;
        }
        if (Math.abs(debit - credit) > 0.005) throw business(`You must balance debits (${round2(debit)}) and credits (${round2(credit)}).`);
        record.TotalAmt = round2(debit);
        break;
      }
      case 'TimeActivity': {
        if (!['Employee', 'Vendor'].includes(record.NameOf)) throw missingParam('NameOf');
        requireRef(record, record.NameOf === 'Employee' ? 'EmployeeRef' : 'VendorRef');
        if (!Number.isFinite(num(record.Hours)) && !Number.isFinite(num(record.Minutes)) && !(record.StartTime && record.EndTime)) throw missingParam('Hours');
        break;
      }
      default:
        throw qboError(`Unsupported entity for this simulated company: ${type}`, '500');
    }
  }

  function finalizeTxn(type, record) {
    record.TxnDate ||= today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record.TxnDate))) throw qboError(`Invalid date: ${String(record.TxnDate).slice(0, 30)} must be YYYY-MM-DD.`, '2010');
    record.CurrencyRef ||= { value: 'CAD', name: 'Canadian Dollar' };
    if ([...SALES_FORMS, ...PURCHASE_FORMS, 'Deposit'].includes(type)) {
      const { subtotal, totalTax } = computeTax(type, record);
      record.TotalAmt = round2(subtotal + totalTax);
      if (['Invoice', 'Estimate', 'CreditMemo', 'SalesReceipt'].includes(type)) record.ApplyTaxAfterDiscount ??= false;
    }
    if (['Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt'].includes(type) && !record.DocNumber) record.DocNumber = String(seq.salesDoc++);
    if (type === 'Estimate' && !record.DocNumber) record.DocNumber = String(seq.estimateDoc++);
    if (type === 'PurchaseOrder' && !record.DocNumber) record.DocNumber = String(seq.poDoc++);
    if (['Invoice', 'Bill'].includes(type)) record.DueDate ||= record.TxnDate;
    if (type === 'Estimate') record.TxnStatus ||= 'Pending';
    if (type === 'PurchaseOrder') record.POStatus ||= 'Open';
  }

  function prepare(type, input, existing) {
    if (!isObj(input)) throw qboError('Request has invalid or unsupported property: the body must be an object.', '2010');
    if (Object.hasOwn(input, 'MetaData') && !existing) delete input.MetaData;
    const record = clone(input);
    delete record.sparse;
    delete record.domain;
    stripDerived(type, record);
    const missing = [];
    checkRefs(record, type, missing);
    if (missing.length) {
      const err = invalidRef(missing[0].field, missing[0].id);
      err.missingRefs = missing;
      throw err;
    }
    if (TXN_TYPES.includes(type)) normalizeLines(type, record);
    validate(type, record, existing?.Id);
    if (TXN_TYPES.includes(type)) finalizeTxn(type, record);
    return record;
  }

  // Read-back fields this simulation derives; a model echoing them is ignored.
  function stripDerived(type, record) {
    for (const f of ['Balance', 'RemainingCredit', 'UnappliedAmt', 'CurrentBalance', 'CurrentBalanceWithSubAccounts', 'BalanceWithJobs', 'Classification', 'time']) delete record[f];
    if (type === 'Invoice' && Array.isArray(record.LinkedTxn)) record.LinkedTxn = record.LinkedTxn.filter((l) => ['Estimate', 'TimeActivity'].includes(l?.TxnType));
    if (['Bill', 'CreditMemo', 'VendorCredit', 'Estimate', 'PurchaseOrder'].includes(type)) delete record.LinkedTxn;
    if (type === 'Estimate' && record.TxnStatus === 'Closed') delete record.TxnStatus;
    if (type === 'PurchaseOrder') for (const line of record.Line || []) if (isObj(line)) delete line.Received;
    if (type === 'Item' && record.Type === 'Inventory' && record._startQty !== undefined) delete record.QtyOnHand;
    for (const line of Array.isArray(record.Line) ? record.Line : []) if (isObj(line?.SalesItemLineDetail)) delete line.SalesItemLineDetail.ItemAccountRef;
  }

  function store(type, record, { preExisting = false } = {}) {
    const k = key(type, record.Id);
    records.set(k, record);
    everExisted.add(k);
    meta.set(k, { ...(meta.get(k) || {}), preExisting });
  }

  function insert(type, input, opts = {}) {
    const record = prepare(type, input);
    record.Id = opts.id ? String(opts.id) : nextId(type);
    record.SyncToken = '0';
    record.domain = 'QBO';
    record.sparse = false;
    const stamp = opts.createTime || now();
    record.MetaData = { CreateTime: stamp, LastUpdatedTime: stamp, LastModifiedByRef: { value: '9130356997460016' } };
    store(type, record, { preExisting: !!opts.preExisting });
    return record;
  }

  // ---------------------------------------------------------------------------
  // Derived state (balances, links, statuses), recomputed on every read
  // ---------------------------------------------------------------------------
  function buildLedger(excludeKey = null) {
    const applied = new Map(); const creditUsed = new Map(); const backLinks = new Map(); const poReceived = new Map(); const closedEstimates = new Map();
    const add = (map, k, v) => map.set(k, round2((map.get(k) || 0) + v));
    const link = (target, source) => { const list = backLinks.get(target) || []; list.push(source); backLinks.set(target, list); };
    for (const [k, record] of records) {
      if (meta.get(k)?.deleted || meta.get(k)?.voided || k === excludeKey) continue;
      const [type] = k.split(':');
      if (type === 'Payment' || type === 'BillPayment') {
        for (const line of record.Line || []) {
          for (const l of line.LinkedTxn || []) {
            const tk = key(l.TxnType, l.TxnId);
            if (!live(l.TxnType, l.TxnId) || meta.get(tk)?.voided) continue;
            if (['Invoice', 'Bill'].includes(l.TxnType)) add(applied, tk, line.Amount);
            if (['CreditMemo', 'VendorCredit'].includes(l.TxnType)) add(creditUsed, tk, line.Amount);
            link(tk, { TxnId: record.Id, TxnType: type });
          }
        }
      }
      if (type === 'Invoice') {
        for (const l of [...(record.LinkedTxn || []), ...(record.Line || []).flatMap((line) => line.LinkedTxn || [])]) {
          if (l.TxnType === 'Estimate' && live('Estimate', l.TxnId)) { closedEstimates.set(key('Estimate', l.TxnId), record.Id); link(key('Estimate', l.TxnId), { TxnId: record.Id, TxnType: 'Invoice' }); }
        }
      }
      if (type === 'Bill') {
        const seen = new Set();
        for (const line of record.Line || []) {
          for (const l of line.LinkedTxn || []) {
            if (l.TxnType !== 'PurchaseOrder' || !live('PurchaseOrder', l.TxnId)) continue;
            const pk = key('PurchaseOrder', l.TxnId);
            if (!seen.has(pk)) { link(pk, { TxnId: record.Id, TxnType: 'Bill' }); seen.add(pk); }
            const lineId = l.TxnLineId ? String(l.TxnLineId) : null;
            const qty = line.ItemBasedExpenseLineDetail ? num(line.ItemBasedExpenseLineDetail.Qty) || 0 : line.Amount;
            const m = poReceived.get(pk) || new Map();
            m.set(lineId, round2((m.get(lineId) || 0) + qty));
            poReceived.set(pk, m);
          }
        }
      }
    }
    return { applied, creditUsed, backLinks, poReceived, closedEstimates };
  }

  function itemOf(line) {
    const ref = line.SalesItemLineDetail?.ItemRef || line.ItemBasedExpenseLineDetail?.ItemRef;
    return ref ? live('Item', ref.value) : null;
  }

  // Double-entry postings for balances and reports: [{ account, debit, credit }].
  function postingsOf(type, record) {
    if (isVoided(type, record.Id)) return [];
    const out = [];
    const post = (account, amount, extra = {}) => {
      if (!account || !amount) return;
      const a = round2(amount);
      out.push({ account: String(account), debit: a > 0 ? a : 0, credit: a < 0 ? -a : 0, ...extra });
    };
    const tax = record.TxnTaxDetail?.TotalTax || 0;
    const netLines = (record.Line || []).filter((l) => !['DescriptionOnly', 'SubTotalLineDetail'].includes(l.DetailType));
    const sales = (sign) => {
      for (const line of netLines) {
        if (line.DetailType === 'DiscountLineDetail') { post(line.DiscountLineDetail?.DiscountAccountRef?.value || ACCOUNTS.sales, sign * line.Amount); continue; }
        const item = itemOf(line);
        post(item?.IncomeAccountRef?.value || ACCOUNTS.sales, -sign * line.Amount);
        if (item?.Type === 'Inventory') {
          const qty = num(line.SalesItemLineDetail?.Qty) || 1;
          post(item.ExpenseAccountRef?.value || ACCOUNTS.cogs, sign * qty * (item.PurchaseCost || 0));
          post(item.AssetAccountRef?.value || ACCOUNTS.inventory, -sign * qty * (item.PurchaseCost || 0));
        }
      }
      post(ACCOUNTS.taxPayable, -sign * tax);
    };
    const expenses = (sign) => {
      for (const line of record.Line || []) {
        if (line.DetailType === 'AccountBasedExpenseLineDetail') post(line.AccountBasedExpenseLineDetail.AccountRef.value, sign * line.Amount);
        if (line.DetailType === 'ItemBasedExpenseLineDetail') {
          const item = itemOf(line);
          post(item?.Type === 'Inventory' ? item.AssetAccountRef.value : item?.ExpenseAccountRef?.value || ACCOUNTS.cogs, sign * line.Amount);
        }
      }
      post(ACCOUNTS.taxPayable, sign * tax);
    };
    switch (type) {
      case 'Invoice': post(record.ARAccountRef?.value || ACCOUNTS.ar, record.TotalAmt); sales(1); break;
      case 'CreditMemo': post(record.ARAccountRef?.value || ACCOUNTS.ar, -record.TotalAmt); sales(-1); break;
      case 'SalesReceipt': post(record.DepositToAccountRef.value, record.TotalAmt); sales(1); break;
      case 'RefundReceipt': post(record.DepositToAccountRef.value, -record.TotalAmt); sales(-1); break;
      case 'Payment': post(record.DepositToAccountRef.value, record.TotalAmt); post(record.ARAccountRef?.value || ACCOUNTS.ar, -record.TotalAmt); break;
      case 'Bill': post(record.APAccountRef.value, -record.TotalAmt); expenses(1); break;
      case 'VendorCredit': post(record.APAccountRef.value, record.TotalAmt); expenses(-1); break;
      case 'Purchase': post(record.AccountRef.value, -record.TotalAmt); expenses(1); break;
      case 'BillPayment': post(record.APAccountRef?.value || ACCOUNTS.ap, record.TotalAmt);
        post(record.PayType === 'Check' ? record.CheckPayment.BankAccountRef.value : record.CreditCardPayment.CCAccountRef.value, -record.TotalAmt); break;
      case 'Deposit':
        post(record.DepositToAccountRef.value, record.TotalAmt);
        for (const line of record.Line || []) {
          if (line.LinkedTxn?.length) post(ACCOUNTS.undeposited, -line.Amount);
          else post(line.DepositLineDetail.AccountRef.value, -line.Amount);
        }
        post(ACCOUNTS.taxPayable, -tax);
        break;
      case 'Transfer': post(record.ToAccountRef.value, record.Amount); post(record.FromAccountRef.value, -record.Amount); break;
      case 'JournalEntry':
        for (const line of record.Line || []) post(line.JournalEntryLineDetail.AccountRef.value, line.JournalEntryLineDetail.PostingType === 'Debit' ? line.Amount : -line.Amount);
        break;
      default: break;
    }
    return out.map((p) => ({ ...p, type, id: record.Id, date: record.TxnDate, docNumber: record.DocNumber || '', memo: record.PrivateNote || '' }));
  }

  function allPostings(endDate = '9999-12-31', startDate = '0000-01-01') {
    const out = [];
    for (const type of TXN_TYPES) for (const r of allLive(type)) for (const p of postingsOf(type, r)) if (p.date >= startDate && p.date <= endDate) out.push(p);
    return out;
  }

  function accountBalance(id, endDate) {
    const account = live('Account', id);
    const info = ACCOUNT_TYPES[account?.AccountType] || { debit: true };
    const net = allPostings(endDate).filter((p) => p.account === String(id)).reduce((s, p) => s + p.debit - p.credit, 0);
    return round2(info.debit ? net : -net);
  }

  function inventoryQty(item) {
    let qty = item._startQty ?? item.QtyOnHand ?? 0;
    for (const type of ['Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt', 'Bill', 'Purchase', 'VendorCredit']) {
      for (const r of allLive(type)) {
        if (isVoided(type, r.Id)) continue;
        for (const line of r.Line || []) {
          const ref = line.SalesItemLineDetail?.ItemRef || line.ItemBasedExpenseLineDetail?.ItemRef;
          if (!ref || String(ref.value) !== String(item.Id)) continue;
          const q = num((line.SalesItemLineDetail || line.ItemBasedExpenseLineDetail).Qty);
          const amount = Number.isFinite(q) ? q : 1;
          qty += ['Invoice', 'SalesReceipt', 'VendorCredit'].includes(type) ? -amount : amount;
        }
      }
    }
    return round2(qty);
  }

  function view(type, record, ledger = buildLedger()) {
    const out = clone(record);
    delete out._startQty;
    const k = key(type, record.Id);
    const back = ledger.backLinks.get(k) || [];
    const withLinks = () => {
      const links = [...(out.LinkedTxn || []), ...back];
      if (links.length) out.LinkedTxn = links;
    };
    if (type === 'Invoice' || type === 'Bill') { out.Balance = isVoided(type, record.Id) ? 0 : round2(record.TotalAmt - (ledger.applied.get(k) || 0)); withLinks(); }
    if (type === 'CreditMemo') { out.RemainingCredit = isVoided(type, record.Id) ? 0 : round2(record.TotalAmt - (ledger.creditUsed.get(k) || 0)); out.Balance = out.RemainingCredit; withLinks(); }
    if (type === 'VendorCredit') { out.Balance = round2(record.TotalAmt - (ledger.creditUsed.get(k) || 0)); withLinks(); }
    if (type === 'Payment') {
      let applied = 0;
      for (const line of record.Line || []) for (const l of line.LinkedTxn || []) {
        if (!live(l.TxnType, l.TxnId) || isVoided(l.TxnType, l.TxnId)) continue;
        applied += l.TxnType === 'CreditMemo' ? -line.Amount : l.TxnType === 'Invoice' ? line.Amount : 0;
      }
      out.UnappliedAmt = isVoided(type, record.Id) ? 0 : round2(record.TotalAmt - applied);
    }
    if (type === 'Estimate') { if (ledger.closedEstimates.has(k)) out.TxnStatus = 'Closed'; withLinks(); }
    if (type === 'PurchaseOrder') {
      const received = ledger.poReceived.get(k) || new Map();
      let open = false;
      for (const line of out.Line || []) {
        const got = (received.get(String(line.Id)) || 0);
        if (got) line.Received = got;
        const ordered = line.ItemBasedExpenseLineDetail ? num(line.ItemBasedExpenseLineDetail.Qty) || 0 : line.Amount;
        if (got < ordered) open = true;
      }
      if (record.POStatus !== 'Closed') out.POStatus = open || !(out.Line || []).length ? 'Open' : 'Closed';
      withLinks();
    }
    if (SALES_FORMS.includes(type) && Array.isArray(out.Line)) {
      // Saved Canadian sales lines carry the read-only income account of their item.
      for (const line of out.Line) {
        const item = line.SalesItemLineDetail?.ItemRef ? live('Item', line.SalesItemLineDetail.ItemRef.value) : null;
        if (item?.IncomeAccountRef) line.SalesItemLineDetail.ItemAccountRef = { value: item.IncomeAccountRef.value, name: live('Account', item.IncomeAccountRef.value)?.Name };
      }
      const subtotal = round2(out.Line.filter((l) => l.DetailType === 'SalesItemLineDetail').reduce((s, l) => s + l.Amount, 0));
      out.Line.push({ Amount: subtotal, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} });
    }
    if (type === 'Account') {
      if (ACCOUNT_TYPES[record.AccountType]?.bs) {
        out.CurrentBalance = accountBalance(record.Id);
        out.CurrentBalanceWithSubAccounts = out.CurrentBalance;
      }
    }
    if (type === 'Item' && record.Type === 'Inventory') out.QtyOnHand = inventoryQty(record);
    if (type === 'Customer') {
      let balance = 0;
      for (const inv of allLive('Invoice')) if (String(inv.CustomerRef?.value) === String(record.Id) && !isVoided('Invoice', inv.Id)) balance += inv.TotalAmt - (ledger.applied.get(key('Invoice', inv.Id)) || 0);
      for (const cm of allLive('CreditMemo')) if (String(cm.CustomerRef?.value) === String(record.Id)) balance -= cm.TotalAmt - (ledger.creditUsed.get(key('CreditMemo', cm.Id)) || 0);
      for (const p of allLive('Payment')) if (String(p.CustomerRef?.value) === String(record.Id)) balance -= view('Payment', p, ledger).UnappliedAmt;
      out.Balance = round2(balance);
      out.BalanceWithJobs = out.Balance;
    }
    if (type === 'Vendor') {
      let balance = 0;
      for (const bill of allLive('Bill')) if (String(bill.VendorRef?.value) === String(record.Id)) balance += bill.TotalAmt - (ledger.applied.get(key('Bill', bill.Id)) || 0);
      for (const vc of allLive('VendorCredit')) if (String(vc.VendorRef?.value) === String(record.Id)) balance -= vc.TotalAmt - (ledger.creditUsed.get(key('VendorCredit', vc.Id)) || 0);
      out.Balance = round2(balance);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Query language (the subset the tools send)
  // ---------------------------------------------------------------------------
  function parseValue(raw) {
    const v = raw.trim();
    if (/^'.*'$/s.test(v)) return v.slice(1, -1).replace(/\\'/g, "'");
    if (/^\(.*\)$/s.test(v)) return v.slice(1, -1).split(',').map((s) => parseValue(s));
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }
  function fieldValue(record, field) {
    let value = record;
    for (const part of field.split('.')) value = value?.[part];
    if (isObj(value) && Object.hasOwn(value, 'value')) return value.value;
    return value;
  }
  function matches(record, cond) {
    const actual = fieldValue(record, cond.field);
    const expected = cond.value;
    const cmp = (a, b) => (typeof b === 'number' ? Number(a) : String(a ?? '')).toString().localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    switch (cond.op) {
      case '=': return typeof expected === 'boolean' ? actual === expected : String(actual ?? '').toLowerCase() === String(expected).toLowerCase();
      case '!=': case '<>': return String(actual ?? '').toLowerCase() !== String(expected).toLowerCase();
      case 'like': {
        const pattern = '^' + String(expected).toLowerCase().split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
        const name = isObj(record[cond.field]) ? record[cond.field].name : undefined;
        return new RegExp(pattern, 's').test(String(actual ?? '').toLowerCase()) || (name !== undefined && new RegExp(pattern, 's').test(String(name).toLowerCase()));
      }
      case 'in': return (Array.isArray(expected) ? expected : [expected]).some((v) => String(v).toLowerCase() === String(actual ?? '').toLowerCase());
      case '<': return cmp(actual, expected) < 0;
      case '>': return cmp(actual, expected) > 0;
      case '<=': return cmp(actual, expected) <= 0;
      case '>=': return cmp(actual, expected) >= 0;
      default: return false;
    }
  }
  function runQuery(sql) {
    const m = /^\s*select\s+(\*|count\(\*\))\s+from\s+(\w+)(?:\s+where\s+(.+?))?(?:\s+orderby\s+(\w+(?:\.\w+)*)(?:\s+(asc|desc))?)?(?:\s+startposition\s+(\d+))?(?:\s+maxresults\s+(\d+))?\s*$/is.exec(String(sql));
    if (!m) throw qboError(`QueryParserError: Encountered an unexpected token in the query: ${String(sql).slice(0, 120)}`, '4000');
    const type = TYPE_BY_LOWER.get(m[2].toLowerCase());
    if (!type) throw qboError(`QueryValidationError: Invalid context declaration: ${m[2].slice(0, 40)}`, '4001');
    const conditions = (m[3] ? m[3].split(/\s+and\s+/i) : []).map((part) => {
      const c = /^\s*(\w+(?:\.\w+)*)\s*(<=|>=|!=|<>|=|<|>|\blike\b|\bin\b)\s*(.+?)\s*$/is.exec(part);
      if (!c) throw qboError(`QueryParserError: Encountered an unexpected token: ${part.slice(0, 80)}`, '4000');
      return { field: c[1], op: c[2].toLowerCase(), value: parseValue(c[3]) };
    });
    const mentionsActive = conditions.some((c) => c.field === 'Active');
    const ledger = buildLedger();
    let rows = allLive(type).map((r) => view(type, r, ledger))
      .filter((r) => mentionsActive || !Object.hasOwn(r, 'Active') || r.Active !== false)
      .filter((r) => conditions.every((c) => matches(r, c)));
    const order = m[4];
    rows.sort((a, b) => order ? String(fieldValue(a, order)).localeCompare(String(fieldValue(b, order)), undefined, { numeric: true }) * (m[5]?.toLowerCase() === 'desc' ? -1 : 1)
      : TXN_TYPES.includes(type) ? Number(b.Id) - Number(a.Id) : Number(a.Id) - Number(b.Id));
    if (m[1].toLowerCase().startsWith('count')) return { QueryResponse: { totalCount: rows.length }, time: now() };
    const start = Math.max(Number(m[6] || 1), 1);
    const max = Math.min(Number(m[7] || 100), 1000);
    rows = rows.slice(start - 1, start - 1 + max);
    return { QueryResponse: rows.length ? { [type]: rows, startPosition: start, maxResults: rows.length } : {}, time: now() };
  }

  // ---------------------------------------------------------------------------
  // Reports (Accrual basis, simplified layouts in QBO's Rows/ColData shape)
  // ---------------------------------------------------------------------------
  const money = (n) => round2(n).toFixed(2);
  const row = (cells) => ({ ColData: cells.map((v) => ({ value: String(v) })), type: 'Data' });
  const section = (title, rows, total) => ({ Header: { ColData: [{ value: title }, { value: '' }] }, Rows: { Row: rows }, Summary: { ColData: [{ value: 'Total ' + title }, { value: money(total) }] }, type: 'Section' });
  function report(name, params) {
    const yearStart = today.slice(0, 4) + '-01-01';
    const start = params.get('start_date') || yearStart;
    const end = params.get('end_date') || params.get('report_date') || today;
    const header = (extra = {}) => ({ Time: now(), ReportName: name, ReportBasis: params.get('accounting_method') || 'Accrual', StartPeriod: start, EndPeriod: end, Currency: 'CAD', Option: [{ Name: 'NoReportData', Value: 'false' }], ...extra });
    const accounts = allLive('Account').filter((a) => a.Active !== false);
    const bal = (a, s, e) => {
      const info = ACCOUNT_TYPES[a.AccountType];
      const net = allPostings(e, s).filter((p) => p.account === String(a.Id)).reduce((t, p) => t + p.debit - p.credit, 0);
      return round2(info.debit ? net : -net);
    };
    const byClass = (types, s, e) => accounts.filter((a) => types.includes(a.AccountType)).map((a) => [a, bal(a, s, e)]).filter(([, v]) => Math.abs(v) > 0.004);
    const sum = (list) => round2(list.reduce((t, [, v]) => t + v, 0));
    const twoCols = { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] };
    const empty = () => ({ Header: header({ Option: [{ Name: 'NoReportData', Value: 'true' }] }), Columns: twoCols, Rows: {} });
    switch (name) {
      case 'BalanceSheet': {
        const assets = byClass(['Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset'], '0000-01-01', end);
        const liabilities = byClass(['Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability'], '0000-01-01', end);
        const equity = byClass(['Equity'], '0000-01-01', end);
        const pl = (s, e) => sum(byClass(['Income', 'Other Income'], s, e)) - sum(byClass(['Cost of Goods Sold', 'Expense', 'Other Expense'], s, e));
        const netIncome = round2(pl(end.slice(0, 4) + '-01-01', end));
        const priorIncome = round2(pl('0000-01-01', String(Number(end.slice(0, 4)) - 1) + '-12-31'));
        const eqRows = equity.map(([a, v]) => [a, a.AccountSubType === 'RetainedEarnings' ? round2(v + priorIncome) : v]);
        if (!eqRows.some(([a]) => a.AccountSubType === 'RetainedEarnings') && priorIncome) eqRows.push([{ Name: 'Retained Earnings' }, priorIncome]);
        const eqTotal = round2(sum(eqRows) + netIncome);
        return { Header: header({ StartPeriod: undefined }), Columns: twoCols, Rows: { Row: [
          section('Assets', assets.map(([a, v]) => row([a.Name, money(v)])), sum(assets)),
          section('Liabilities and Equity', [
            section('Liabilities', liabilities.map(([a, v]) => row([a.Name, money(v)])), sum(liabilities)),
            section('Equity', [...eqRows.map(([a, v]) => row([a.Name, money(v)])), row(['Profit for the year', money(netIncome)])], eqTotal),
          ], round2(sum(liabilities) + eqTotal)),
        ] } };
      }
      case 'ProfitAndLoss': case 'ProfitAndLossDetail': {
        const income = byClass(['Income', 'Other Income'], start, end);
        const cogs = byClass(['Cost of Goods Sold'], start, end);
        const expenses = byClass(['Expense', 'Other Expense'], start, end);
        const net = round2(sum(income) - sum(cogs) - sum(expenses));
        if (!income.length && !cogs.length && !expenses.length) return empty();
        return { Header: header(), Columns: twoCols, Rows: { Row: [
          section('Income', income.map(([a, v]) => row([a.Name, money(v)])), sum(income)),
          section('Cost of Goods Sold', cogs.map(([a, v]) => row([a.Name, money(v)])), sum(cogs)),
          { Summary: { ColData: [{ value: 'Gross Profit' }, { value: money(sum(income) - sum(cogs)) }] }, type: 'Section' },
          section('Expenses', expenses.map(([a, v]) => row([a.Name, money(v)])), sum(expenses)),
          { Summary: { ColData: [{ value: 'Net Income' }, { value: money(net) }] }, type: 'Section' },
        ] } };
      }
      case 'TrialBalance': {
        const rows = accounts.map((a) => {
          const net = round2(allPostings(end).filter((p) => p.account === String(a.Id)).reduce((t, p) => t + p.debit - p.credit, 0));
          return [a, net];
        }).filter(([, v]) => Math.abs(v) > 0.004);
        const debit = round2(rows.filter(([, v]) => v > 0).reduce((t, [, v]) => t + v, 0));
        return { Header: header(), Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Debit' }, { ColTitle: 'Credit' }] }, Rows: { Row: [
          ...rows.map(([a, v]) => row([a.Name, v > 0 ? money(v) : '', v < 0 ? money(-v) : ''])),
          { Summary: { ColData: [{ value: 'TOTAL' }, { value: money(debit) }, { value: money(debit) }] }, type: 'Section' },
        ] } };
      }
      case 'GeneralLedger': {
        const postings = allPostings(end, start);
        const sections = accounts.map((a) => {
          const mine = postings.filter((p) => p.account === String(a.Id)).sort((x, y) => x.date.localeCompare(y.date));
          if (!mine.length) return null;
          return { Header: { ColData: [{ value: a.Name }] }, Rows: { Row: mine.map((p) => row([p.date, p.type, p.docNumber, p.memo, money(p.debit - p.credit)])) },
            Summary: { ColData: [{ value: 'Total for ' + a.Name }, { value: '' }, { value: '' }, { value: '' }, { value: money(mine.reduce((t, p) => t + p.debit - p.credit, 0)) }] }, type: 'Section' };
        }).filter(Boolean);
        if (!sections.length) return empty();
        return { Header: header(), Columns: { Column: ['Date', 'Transaction Type', 'Num', 'Memo/Description', 'Amount'].map((t) => ({ ColTitle: t })) }, Rows: { Row: sections } };
      }
      case 'AgedReceivables': case 'AgedReceivableDetail': case 'CustomerBalance': case 'CustomerBalanceDetail':
      case 'AgedPayables': case 'AgedPayableDetail': case 'VendorBalance': case 'VendorBalanceDetail': {
        const party = /Receiv|Customer/.test(name) ? 'Customer' : 'Vendor';
        const ledger = buildLedger();
        const rows = allLive(party).map((p) => [p, view(party, p, ledger).Balance]).filter(([, v]) => Math.abs(v) > 0.004);
        if (!rows.length) return empty();
        return { Header: header(), Columns: twoCols, Rows: { Row: [...rows.map(([p, v]) => row([p.DisplayName, money(v)])),
          { Summary: { ColData: [{ value: 'TOTAL' }, { value: money(rows.reduce((t, [, v]) => t + v, 0)) }] }, type: 'Section' }] } };
      }
      case 'AccountList':
        return { Header: header(), Columns: { Column: ['Account', 'Type', 'Detail Type', 'Balance'].map((t) => ({ ColTitle: t })) },
          Rows: { Row: accounts.map((a) => row([a.Name, a.AccountType, a.AccountSubType, ACCOUNT_TYPES[a.AccountType].bs ? money(accountBalance(a.Id, end)) : ''])) } };
      case 'InventoryValuationSummary': case 'InventoryValuationDetail': {
        const items = allLive('Item').filter((i) => i.Type === 'Inventory');
        if (!items.length) return empty();
        return { Header: header(), Columns: { Column: ['Item', 'Qty', 'Asset Value'].map((t) => ({ ColTitle: t })) },
          Rows: { Row: items.map((i) => { const q = inventoryQty(i); return row([i.Name, String(q), money(q * (i.PurchaseCost || 0))]); }) } };
      }
      default:
        return empty();
    }
  }

  // ---------------------------------------------------------------------------
  // Client surface
  // ---------------------------------------------------------------------------
  function entityOf(name) {
    const type = TYPE_BY_LOWER.get(String(name || '').toLowerCase());
    if (!type) throw qboError(`Unsupported operation: unknown entity ${String(name).slice(0, 40)}`, '500');
    return type;
  }

  function logged(entry, fn) {
    const record = { seq: calls.length + 1, at: Date.now(), ...entry };
    calls.push(record);
    lastTid = 'fake-' + record.seq;
    try {
      const result = fn(record);
      record.ok = true;
      return Promise.resolve(clone(result));
    } catch (err) {
      record.ok = false;
      record.error = err.message;
      if (!err.fakeQbo) record.internalError = String(err.stack || err).slice(0, 2000);
      if (err.missingRefs) record.missingRefs = err.missingRefs;
      if (!err.fakeQbo) { const wrapped = qboError(err.message || 'Simulated QBO failure', '6000'); return Promise.reject(wrapped); }
      return Promise.reject(err);
    }
  }

  function doRead(type, id, entry) {
    if (SINGLETONS.includes(type)) id = '1'; // companyinfo/{realmId}, preferences
    const k = key(type, id);
    entry.preExisting = !!meta.get(k)?.preExisting;
    if (!/^\d+$/.test(String(id)) || !records.has(k) || meta.get(k)?.deleted) {
      entry.missing = true;
      entry.everExisted = everExisted.has(k);
      throw notFound();
    }
    return { [type]: view(type, records.get(k)), time: now() };
  }

  function doCreate(type, body, entry) {
    if (READ_ONLY_TYPES.includes(type)) throw qboError(`Operation Create is not supported for ${type} through this API.`, '500');
    if (isObj(body) && (body.Id !== undefined && body.Id !== null && body.Id !== '')) return doUpdate(type, body, entry);
    entry.kind = 'create';
    const record = insert(type, body);
    entry.resultId = record.Id;
    return { [type]: view(type, record), time: now() };
  }

  function doUpdate(type, body, entry) {
    entry.kind = 'update';
    entry.id = String(body?.Id);
    if (READ_ONLY_TYPES.includes(type)) throw qboError(`Operation Update is not supported for ${type} through this API.`, '500');
    const k = key(type, body.Id);
    entry.preExisting = !!meta.get(k)?.preExisting;
    const existing = live(type, body.Id);
    if (!existing) { entry.missing = true; entry.everExisted = everExisted.has(k); throw notFound(); }
    if (isVoided(type, body.Id)) throw business('This transaction has been voided and can no longer be edited.');
    if (body.SyncToken === undefined) throw missingParam('SyncToken');
    if (String(body.SyncToken) !== String(existing.SyncToken)) {
      throw qboError('Stale Object Error: You and another user were working on this at the same time. The other user finished before you did, so your work was not saved.', '5010');
    }
    const base = body.sparse === true ? { ...clone(existing), ...clone(body) } : { ...clone(body) };
    delete base.MetaData;
    if (body.sparse === true && Array.isArray(body.Line)) base.Line = clone(body.Line);
    if (type === 'Item' && existing._startQty !== undefined) base._startQty = existing._startQty;
    const record = prepare(type, base, existing);
    record.Id = existing.Id;
    record.SyncToken = String(Number(existing.SyncToken) + 1);
    record.domain = 'QBO';
    record.sparse = false;
    record.MetaData = { ...existing.MetaData, LastUpdatedTime: now() };
    store(type, record, { preExisting: !!meta.get(k)?.preExisting });
    entry.resultId = record.Id;
    return { [type]: view(type, record), time: now() };
  }

  function doDelete(type, body, entry) {
    entry.kind = 'delete';
    entry.id = String(body?.Id);
    const k = key(type, body?.Id);
    entry.preExisting = !!meta.get(k)?.preExisting;
    if (!DELETABLE.includes(type)) throw business(`${type} records can't be deleted; make them inactive instead.`);
    const existing = live(type, body?.Id);
    if (!existing) { entry.missing = true; entry.everExisted = everExisted.has(k); throw notFound(); }
    if (String(body.SyncToken) !== String(existing.SyncToken)) throw qboError('Stale Object Error: the record changed since it was read.', '5010');
    meta.set(k, { ...meta.get(k), deleted: true });
    return { [type]: { Id: existing.Id, status: 'Deleted', domain: 'QBO' }, time: now() };
  }

  function doVoid(type, body, entry) {
    entry.kind = 'void';
    entry.id = String(body?.Id);
    const k = key(type, body?.Id);
    entry.preExisting = !!meta.get(k)?.preExisting;
    if (!['Invoice', 'SalesReceipt', 'Payment', 'BillPayment'].includes(type)) throw business(`${type} can't be voided.`);
    const existing = live(type, body?.Id);
    if (!existing) { entry.missing = true; entry.everExisted = everExisted.has(k); throw notFound(); }
    if (String(body.SyncToken) !== String(existing.SyncToken)) throw qboError('Stale Object Error: the record changed since it was read.', '5010');
    if (isVoided(type, body.Id)) throw business('This transaction is already voided.');
    existing.SyncToken = String(Number(existing.SyncToken) + 1);
    existing.PrivateNote = 'Voided' + (existing.PrivateNote ? ' - ' + existing.PrivateNote : '');
    existing.MetaData = { ...existing.MetaData, LastUpdatedTime: now() };
    meta.set(k, { ...meta.get(k), voided: true, voidedTotal: existing.TotalAmt });
    for (const line of existing.Line || []) line.Amount = 0;
    existing.TotalAmt = 0;
    if (existing.TxnTaxDetail) existing.TxnTaxDetail = { TotalTax: 0, TaxLine: [] };
    return { [type]: view(type, existing), time: now() };
  }

  const client = {
    realmId: 'eval-simulated-realm',
    async read(entity, id) {
      return logged({ method: 'read', entity: String(entity), id: String(id) }, (entry) => doRead(entityOf(entity), id, entry));
    },
    async query(sql) {
      return logged({ method: 'query', query: String(sql).slice(0, 500) }, () => runQuery(sql));
    },
    async create(entity, data) {
      return logged({ method: 'create', entity: String(entity), payload: clone(data) }, (entry) => doCreate(entityOf(entity), data, entry));
    },
    async update(entity, data) {
      return logged({ method: 'update', entity: String(entity), id: String(data?.Id), payload: clone(data) }, (entry) => doUpdate(entityOf(entity), data, entry));
    },
    async apiCall(method, endpoint, body) {
      const [pathPart, queryPart = ''] = String(endpoint).split('?');
      const params = new URLSearchParams(queryPart);
      return logged({ method: 'apiCall', http: String(method).toUpperCase(), endpoint: String(endpoint).slice(0, 300), payload: clone(body) }, (entry) => {
        const verb = String(method).toUpperCase();
        if (verb === 'GET' && pathPart.startsWith('reports/')) { entry.kind = 'report'; return report(pathPart.slice('reports/'.length), params); }
        if (verb === 'GET' && pathPart === 'query') { entry.kind = 'query'; return runQuery(params.get('query') || ''); }
        if (verb === 'GET' && /^\w+\/[^/]+$/.test(pathPart)) {
          const [entity, id] = pathPart.split('/');
          entry.kind = 'read'; entry.entity = entity; entry.id = id;
          return doRead(entityOf(entity), id, entry);
        }
        if (verb === 'POST' && /^\w+$/.test(pathPart)) {
          const type = entityOf(pathPart);
          entry.entity = pathPart;
          const operation = params.get('operation');
          if (operation === 'delete') return doDelete(type, body || {}, entry);
          if (operation === 'void' || (operation === 'update' && params.get('include') === 'void')) return doVoid(type, body || {}, entry);
          if (operation && operation !== 'update') throw qboError(`Unsupported operation: ${operation.slice(0, 30)}`, '500');
          return doCreate(type, body, entry);
        }
        throw qboError(`Unsupported request in simulated company: ${verb} ${pathPart.slice(0, 80)}`, '500');
      });
    },
    getLastIntuitTid() { return lastTid; },
    getRequestCount() { return calls.length; },
  };

  // ---------------------------------------------------------------------------
  // Inspection helpers for graders (not part of the QBO client surface)
  // ---------------------------------------------------------------------------
  const inspect = {
    calls,
    today,
    accounts: ACCOUNTS,
    get(type, id) { const r = live(type, id); return r ? view(type, r) : null; },
    exists(type, id) { return !!live(type, id); },
    everExisted(type, id) { return everExisted.has(key(type, id)); },
    isPreExisting(type, id) { return !!meta.get(key(type, id))?.preExisting; },
    isDeleted(type, id) { return !!meta.get(key(type, id))?.deleted; },
    isVoided(type, id) { return isVoided(type, id); },
    list(type, { includeDeleted = false } = {}) {
      const ledger = buildLedger();
      return [...records.entries()].filter(([k]) => k.startsWith(type + ':') && (includeDeleted || !meta.get(k)?.deleted))
        .map(([k, r]) => ({ ...view(type, r, ledger), _eval: { preExisting: !!meta.get(k)?.preExisting, deleted: !!meta.get(k)?.deleted, voided: !!meta.get(k)?.voided } }));
    },
    created(type, opts) { return inspect.list(type, opts).filter((r) => !r._eval.preExisting); },
    postings(type, id) { const r = live(type, id); return r ? postingsOf(type, r) : []; },
    balance(accountId, endDate) { return accountBalance(accountId, endDate); },
    qtyOnHand(itemId) { const i = live('Item', itemId); return i ? inventoryQty(i) : null; },
    mutations() { return calls.filter((c) => c.ok && ['create', 'update', 'delete', 'void'].includes(c.kind)); },
    snapshotCreated() {
      const out = {};
      for (const type of ENTITY_TYPES) {
        const list = inspect.created(type, { includeDeleted: true });
        if (list.length) out[type] = list;
      }
      return out;
    },
  };

  seedCompany({ insert, ACCOUNTS });
  seeding = false;
  return { qbo: client, company: inspect };
}

// A small Ontario business: Maple Ridge Supply Co.
function seedCompany({ insert }) {
  const opts = (id, createTime = '2026-01-02T09:00:00-05:00') => ({ id, preExisting: true, createTime });
  const acct = (id, Name, AccountType, AccountSubType) => insert('Account', { Name, AccountType, AccountSubType }, opts(id));
  acct('1', 'Chequing', 'Bank', 'Checking');
  acct('2', 'Savings', 'Bank', 'Savings');
  acct('3', 'Visa', 'Credit Card', 'CreditCard');
  acct('4', 'Accounts Receivable (A/R)', 'Accounts Receivable', 'AccountsReceivable');
  acct('5', 'Accounts Payable (A/P)', 'Accounts Payable', 'AccountsPayable');
  acct('6', 'Undeposited Funds', 'Other Current Asset', 'UndepositedFunds');
  acct('7', 'Inventory Asset', 'Other Current Asset', 'Inventory');
  acct('8', 'GST/HST Payable', 'Other Current Liability', 'GlobalTaxPayable');
  acct('9', 'Opening Balance Equity', 'Equity', 'OpeningBalanceEquity');
  acct('10', "Owner's Equity", 'Equity', 'OwnersEquity');
  acct('11', 'Retained Earnings', 'Equity', 'RetainedEarnings');
  acct('12', 'Sales', 'Income', 'SalesOfProductIncome');
  acct('13', 'Services', 'Income', 'ServiceFeeIncome');
  acct('14', 'Cost of Goods Sold', 'Cost of Goods Sold', 'SuppliesMaterialsCogs');
  acct('15', 'Advertising', 'Expense', 'AdvertisingPromotional');
  acct('16', 'Office Supplies', 'Expense', 'OfficeGeneralAdministrativeExpenses');
  acct('17', 'Rent or Lease', 'Expense', 'RentOrLeaseOfBuildings');
  acct('18', 'Utilities', 'Expense', 'Utilities');
  acct('19', 'Bank Charges', 'Expense', 'BankCharges');
  acct('20', 'Repairs and Maintenance', 'Expense', 'RepairMaintenance');
  acct('21', 'Accrued Liabilities', 'Other Current Liability', 'AccruedLiabilities');
  acct('22', 'Legal and Professional Fees', 'Expense', 'LegalProfessionalFees');

  const rate = (id, Name, RateValue) => insert('TaxRate', { Name, Description: Name, Active: true, RateValue, AgencyRef: { value: '1' }, SpecialTaxType: 'NONE', DisplayType: 'ReadOnly' }, opts(id));
  rate('1', 'Exempt', 0); rate('2', 'Zero-rated', 0); rate('3', 'Out of Scope', 0);
  rate('4', 'GST (sales) 5%', 5); rate('5', 'GST (purchases) 5%', 5);
  rate('10', 'HST ON (sales) 13%', 13); rate('11', 'HST ON (purchases) 13%', 13);
  const code = (id, Name, salesRate, purchaseRate, Taxable = true) => insert('TaxCode', { Name, Description: Name, Active: true, Hidden: false, Taxable, TaxGroup: false,
    SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: salesRate }, TaxTypeApplicable: 'TaxOnAmount', TaxOrder: 0 }] },
    PurchaseTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: purchaseRate }, TaxTypeApplicable: 'TaxOnAmount', TaxOrder: 0 }] } }, opts(id));
  code('2', 'Exempt', '1', '1', false);
  code('3', 'Zero-rated', '2', '2');
  code('4', 'Out of Scope', '3', '3', false);
  code('5', 'GST', '4', '5');
  code('8', 'HST ON', '10', '11');

  insert('CompanyInfo', { CompanyName: 'Maple Ridge Supply Co.', LegalName: 'Maple Ridge Supply Co. Ltd.', Country: 'CA', FiscalYearStartMonth: 'January',
    CompanyAddr: { Line1: '120 King St W', City: 'Toronto', CountrySubDivisionCode: 'ON', PostalCode: 'M5H 1J9', Country: 'CA' }, SupportedLanguages: 'en' }, opts('1'));
  insert('Preferences', { AccountingInfoPrefs: { FirstMonthOfFiscalYear: 'January', ClassTrackingPerTxn: false, TrackDepartments: false, CustomerTerminology: 'Customers' },
    SalesFormsPrefs: { CustomTxnNumbers: false, AllowDiscount: true, AllowShipping: false, AllowDeposit: false, AutoApplyCredit: false, DefaultTerms: { value: '3' } },
    TaxPrefs: { UsingSalesTax: true, PartnerTaxEnabled: true }, CurrencyPrefs: { MultiCurrencyEnabled: false, HomeCurrency: { value: 'CAD' } },
    ProductAndServicesPrefs: { ForSales: true, ForPurchase: true, QuantityOnHand: true }, VendorAndPurchasesPrefs: { BillableExpenseTracking: false, POCustomField: [] } }, opts('1'));
  insert('Term', { Name: 'Due on receipt', DueDays: 0, Type: 'STANDARD' }, opts('1'));
  insert('Term', { Name: 'Net 15', DueDays: 15, Type: 'STANDARD' }, opts('2'));
  insert('Term', { Name: 'Net 30', DueDays: 30, Type: 'STANDARD' }, opts('3'));
  insert('PaymentMethod', { Name: 'Cash', Type: 'NON_CREDIT_CARD' }, opts('1'));
  insert('PaymentMethod', { Name: 'Cheque', Type: 'NON_CREDIT_CARD' }, opts('2'));
  insert('PaymentMethod', { Name: 'Visa', Type: 'CREDIT_CARD' }, opts('3'));
  insert('PaymentMethod', { Name: 'E-Transfer', Type: 'NON_CREDIT_CARD' }, opts('4'));

  insert('Item', { Name: 'Consulting', Type: 'Service', UnitPrice: 150, IncomeAccountRef: { value: '13' }, SalesTaxCodeRef: { value: '8' } }, opts('1'));
  insert('Item', { Name: 'Installation', Type: 'Service', UnitPrice: 850, IncomeAccountRef: { value: '13' }, ExpenseAccountRef: { value: '14' }, PurchaseCost: 0, SalesTaxCodeRef: { value: '8' } }, opts('2'));
  insert('Item', { Name: 'Shipping', Type: 'NonInventory', UnitPrice: 25, IncomeAccountRef: { value: '12' }, ExpenseAccountRef: { value: '14' } }, opts('3'));
  insert('Item', { Name: 'Hours', Type: 'Service', UnitPrice: 95, IncomeAccountRef: { value: '13' }, ExpenseAccountRef: { value: '14' } }, opts('4'));
  insert('Item', { Name: 'Widget', Type: 'Inventory', UnitPrice: 45, PurchaseCost: 20, TrackQtyOnHand: true, QtyOnHand: 25, InvStartDate: '2026-01-01',
    IncomeAccountRef: { value: '12' }, ExpenseAccountRef: { value: '14' }, AssetAccountRef: { value: '7' } }, opts('5'));

  insert('Customer', { DisplayName: 'Northwind Traders', CompanyName: 'Northwind Traders Ltd.', PrimaryEmailAddr: { Address: 'ap@northwind.example' } }, opts('1'));
  insert('Customer', { DisplayName: 'Lakeshore Dental', CompanyName: 'Lakeshore Dental Clinic', PrimaryEmailAddr: { Address: 'office@lakeshore.example' } }, opts('2'));
  insert('Vendor', { DisplayName: 'Hydro One', CompanyName: 'Hydro One Networks' }, opts('3'));
  insert('Vendor', { DisplayName: 'Staples Business', CompanyName: 'Staples Canada' }, opts('4'));
  insert('Employee', { DisplayName: 'Jordan Lee', GivenName: 'Jordan', FamilyName: 'Lee' }, opts('5'));

  const jeLine = (PostingType, account, Amount) => ({ DetailType: 'JournalEntryLineDetail', Amount, JournalEntryLineDetail: { PostingType, AccountRef: { value: account } } });
  insert('JournalEntry', { TxnDate: '2026-01-01', DocNumber: 'OB-1', PrivateNote: 'Opening balances',
    Line: [jeLine('Debit', '1', 85000), jeLine('Debit', '2', 120000), jeLine('Debit', '7', 500), jeLine('Credit', '9', 205500)] }, opts('140', '2026-01-02T09:10:00-05:00'));
  const salesLine = (item, Qty, UnitPrice, tax = '8') => ({ DetailType: 'SalesItemLineDetail', Amount: Qty * UnitPrice, SalesItemLineDetail: { ItemRef: { value: item }, Qty, UnitPrice, TaxCodeRef: { value: tax } } });
  insert('Invoice', { CustomerRef: { value: '1' }, TxnDate: '2026-02-12', DocNumber: '1001', SalesTermRef: { value: '3' }, DueDate: '2026-03-14',
    Line: [salesLine('1', 10, 150)] }, opts('145', '2026-02-12T10:00:00-05:00'));
  insert('Payment', { CustomerRef: { value: '1' }, TxnDate: '2026-03-01', TotalAmt: 1000, PaymentMethodRef: { value: '2' },
    Line: [{ Amount: 1000, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }] }, opts('146', '2026-03-01T10:00:00-05:00'));
  insert('Invoice', { CustomerRef: { value: '2' }, TxnDate: '2026-03-05', DocNumber: '1002', Line: [salesLine('2', 1, 850)] }, opts('147', '2026-03-05T11:00:00-05:00'));
  insert('Invoice', { CustomerRef: { value: '2' }, TxnDate: '2026-03-05', DocNumber: '1003', Line: [salesLine('2', 1, 850)] }, opts('148', '2026-03-05T11:02:00-05:00'));
  insert('Bill', { VendorRef: { value: '3' }, TxnDate: '2026-03-31', DueDate: '2026-04-30',
    Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 240, Description: 'March hydro', AccountBasedExpenseLineDetail: { AccountRef: { value: '18' }, TaxCodeRef: { value: '8' } } }] },
  opts('149', '2026-04-02T08:00:00-04:00'));
}

module.exports = { createFakeQbo, ACCOUNTS, ACCOUNT_TYPES, ENTITY_TYPES };
