'use strict';

// Model instructions alone never grant access to another case's transactions.
const { WRITABLE_ENTITY_TYPES } = require('./ai-tools');
const WRITES = new Set(['createRecord', 'updateRecord', 'voidTransaction', 'deleteRecord']);
const DELETE_TYPES = ['Bill', 'PurchaseOrder', 'Invoice', 'Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Estimate', 'SalesReceipt', 'RefundReceipt', 'Purchase', 'JournalEntry', 'Deposit', 'Transfer', 'TimeActivity'];
const SAFE_REF_TYPES = {
  CustomerRef: 'Customer', VendorRef: 'Vendor', EmployeeRef: 'Employee', ItemRef: 'Item',
  ParentRef: null, AccountRef: 'Account', IncomeAccountRef: 'Account', ExpenseAccountRef: 'Account',
  AssetAccountRef: 'Account', DepositToAccountRef: 'Account', ARAccountRef: 'Account', APAccountRef: 'Account',
  BankAccountRef: 'Account', CCAccountRef: 'Account', FromAccountRef: 'Account', ToAccountRef: 'Account',
  TaxCodeRef: 'TaxCode', SalesTaxCodeRef: 'TaxCode', PurchaseTaxCodeRef: 'TaxCode',
  TaxRateRef: 'TaxRate', TaxAgencyRef: 'TaxAgency', ClassRef: 'Class', DepartmentRef: 'Department',
  SalesTermRef: 'Term', PaymentMethodRef: 'PaymentMethod', CurrencyRef: 'Currency', EntityRef: null,
};
const owns = (owned, type, id) => owned.some((r) => r.entityType === type && String(r.id) === String(id) && !r.deleted);
const fail = (message) => { throw new Error(message); };

function checkReferences(value, owned, entityType) {
  if (Array.isArray(value)) return value.forEach((v) => checkReferences(v, owned, entityType));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['ProcessPayment', 'ProcessBillPayment', 'CreditChargeInfo'].includes(key) && item) {
      fail('Reproduction records cannot process real payments.');
    }
    if (key === 'ParentRef' && !owns(owned, entityType, item?.value)) fail('Parent records must belong to this case.');
    if (['CustomerRef', 'VendorRef'].includes(key) && !owns(owned, SAFE_REF_TYPES[key], item?.value)) fail('Counterparty records must belong to this case to protect existing balances.');
    if (key === 'EntityRef' && !owns(owned, item?.type, item?.value)) fail('Entity relationships must belong to this case.');
    if (key === 'LinkedTxn') {
      if (!Array.isArray(item)) fail('LinkedTxn must be a list.');
      for (const link of item) {
        if (!owns(owned, link.TxnType, link.TxnId)) fail('Transaction links must point to records created in this case.');
      }
    } else if (key === 'TxnId') {
      if (!owns(owned, value.TxnType, item)) fail('Transaction links must point to records created in this case.');
    } else if (key.endsWith('Ref') && !Object.hasOwn(SAFE_REF_TYPES, key)) {
      fail('Unsupported relationship field: ' + key);
    }
    checkReferences(item, owned, entityType);
  }
}

// QBO's root MetaData describes who/when, not an accounting relationship.
// This helper is ONLY for records read from QBO. Outgoing payloads stay strict.
function checkSavedRecord(record, owned, entityType) {
  const { MetaData: _metadata, ...businessRecord } = record;
  checkReferences(businessRecord, owned, entityType);
  return businessRecord;
}

function checkWrite(name, input, owned) {
  if (!WRITES.has(name)) fail('This tool is not available for autonomous reproduction.');
  if (!WRITABLE_ENTITY_TYPES.includes(input.entityType)) fail('Unsupported record type.');
  if (name !== 'createRecord' && !owns(owned, input.entityType, input.id)) {
    fail('Only records created in this case can be changed or deleted.');
  }
  if (name === 'deleteRecord' && !DELETE_TYPES.includes(input.entityType)) fail('This record type cannot be deleted by the case runner.');
  if (name === 'updateRecord' && Object.hasOwn(input, 'record')) fail('An update accepts changes, not a record payload.');
  if (name === 'createRecord' && Object.hasOwn(input, 'changes')) fail('A create accepts a record, not changes.');
  if (['voidTransaction', 'deleteRecord'].includes(name) && (Object.hasOwn(input, 'record') || Object.hasOwn(input, 'changes'))) fail('This operation accepts only its record identity.');
  const body = name === 'createRecord' ? input.record : name === 'updateRecord' ? input.changes : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Provide an object payload.');
  if (Object.hasOwn(body, 'MetaData')) fail('MetaData is read-only. Omit it from changes and create payloads.');
  checkReferences(body, owned, input.entityType);
  // Isolate counterparties so auto-apply cannot consume pre-existing balances.
  for (const [key, type] of [['CustomerRef', 'Customer'], ['VendorRef', 'Vendor']]) {
    if (body[key] && !owns(owned, type, body[key].value)) {
      fail('Use a customer or vendor created for this case so existing balances cannot be affected.');
    }
  }
  if (name === 'createRecord' && (body.Id !== undefined || body.SyncToken !== undefined || body.sparse !== undefined)) {
    fail('A create must not contain update fields.');
  }
}

// Deleting or voiding a transaction that existed before the case is never run by
// the agent; it waits for the company owner. Edits of existing records stay
// refused: an approval card cannot yet show a field-by-field change.
function checkApprovalRequest(name, input, voidableTypes) {
  if (!['voidTransaction', 'deleteRecord'].includes(name)) fail('Only records created in this case can be changed. Deleting or voiding an existing transaction can be requested for the owner to approve.');
  if (!WRITABLE_ENTITY_TYPES.includes(input.entityType)) fail('Unsupported record type.');
  if (!/^\d+$/.test(String(input.id ?? ''))) fail('Give the QuickBooks Id of the existing record.');
  if (name === 'deleteRecord' && !DELETE_TYPES.includes(input.entityType)) fail('This record type cannot be deleted.');
  if (name === 'voidTransaction' && !voidableTypes.includes(input.entityType)) fail('This record type cannot be voided.');
  if (Object.hasOwn(input, 'record') || Object.hasOwn(input, 'changes')) fail('This operation accepts only its record identity.');
  if (typeof input.summary !== 'string' || !input.summary.trim()) fail('Explain the change in one sentence for the owner.');
}

function pathValues(record, path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_.*]+$/.test(path) || path.length > 250) fail('Invalid evidence field path.');
  let values = [record];
  for (const key of path.split('.')) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Invalid evidence field path.');
    values = values.flatMap((v) => key === '*'
      ? (Array.isArray(v) ? v : [])
      : (v && Object.hasOwn(v, key) ? [v[key]] : []));
  }
  return values;
}

function evaluateCheck(records, check) {
  const groups = records.map(({ record, path }) => pathValues(record, path));
  if (groups.some((values) => !values.length)) return { available: false, actual: null, passed: null };
  const values = groups.flat();
  const numeric = values.length > 0 && values.every((v) => typeof v === 'number' && Number.isFinite(v));
  const actual = check.aggregate === 'sum' && numeric ? values.reduce((a, b) => a + b, 0)
    : values.length === 1 ? values[0] : undefined;
  const available = actual !== undefined && (actual === null || ['number', 'string', 'boolean'].includes(typeof actual));
  const equal = typeof actual === 'number' && typeof check.expected === 'number'
    ? Math.abs(actual - check.expected) < 1e-8 : actual === check.expected;
  return { available, actual: available ? actual : null,
    passed: available ? (check.operator === 'not_equal' ? !equal : equal) : null };
}

function measurementKey(check) {
  const sources = (check.sources || []).map(({ entityType, id, path }) =>
    [entityType, String(id), path]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Changing the target or field adds evidence; it cannot erase an earlier failure.
  return JSON.stringify([sources, check.aggregate, check.operator, check.expected]);
}

function conditionResults(conditions, checks, revision) {
  return conditions.map((label) => {
    const measurements = new Map();
    for (const check of checks) {
      if (check.label === label) measurements.set(measurementKey(check), check);
    }
    const evidence = [...measurements.values()].map((check) => ({
      ...check, current: check.revision === revision,
    }));
    const available = evidence.length > 0 && evidence.every((check) => check.current && check.available);
    return { label, checks: evidence, available,
      passed: available ? evidence.every((check) => check.passed === true) : null };
  });
}

function classifyOutcome(requested, conditions, checks, revision) {
  if (!['reproduced', 'not_reproduced', 'unverified'].includes(requested)) return 'unverified';
  if (requested === 'unverified') return requested;
  const latest = conditionResults(conditions, checks, revision);
  if (!latest.length || latest.some((c) => !c || !c.available)) return 'unverified';
  const allPass = latest.every((c) => c.passed);
  return requested === 'reproduced' ? (allPass ? requested : 'unverified')
    : (!allPass ? requested : 'unverified');
}

module.exports = { WRITES, DELETE_TYPES, owns, checkReferences, checkSavedRecord, checkWrite, checkApprovalRequest, pathValues, evaluateCheck, measurementKey, conditionResults, classifyOutcome };
