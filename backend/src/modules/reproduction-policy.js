'use strict';

// Model instructions alone never grant access to another case's transactions.
const { WRITABLE_ENTITY_TYPES } = require('./ai-tools');
const WRITES = new Set(['createRecord', 'updateRecord', 'voidTransaction', 'deleteRecord']);
const DELETE_TYPES = ['Bill', 'PurchaseOrder', 'Invoice', 'Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Estimate', 'SalesReceipt', 'RefundReceipt', 'Purchase', 'JournalEntry', 'Deposit', 'Transfer', 'TimeActivity'];
// References to shared lists (accounts, taxes, terms, classes...) may point to
// existing records. Server-populated read-only references (ItemAccountRef,
// TaxClassificationRef) appear in saved records and are harmless in payloads.
const SAFE_REF_TYPES = {
  CustomerRef: 'Customer', VendorRef: 'Vendor', EmployeeRef: 'Employee', ItemRef: 'Item', GroupItemRef: 'Item',
  ParentRef: null, AccountRef: 'Account', IncomeAccountRef: 'Account', ExpenseAccountRef: 'Account',
  AssetAccountRef: 'Account', DepositToAccountRef: 'Account', ARAccountRef: 'Account', APAccountRef: 'Account',
  BankAccountRef: 'Account', CCAccountRef: 'Account', FromAccountRef: 'Account', ToAccountRef: 'Account',
  DiscountAccountRef: 'Account', ItemAccountRef: 'Account',
  TaxCodeRef: 'TaxCode', SalesTaxCodeRef: 'TaxCode', PurchaseTaxCodeRef: 'TaxCode', DefaultTaxCodeRef: 'TaxCode', TxnTaxCodeRef: 'TaxCode',
  TaxRateRef: 'TaxRate', TaxAgencyRef: 'TaxAgency', TaxClassificationRef: null, ClassRef: 'Class', DepartmentRef: 'Department',
  SalesTermRef: 'Term', TermRef: 'Term', PaymentMethodRef: 'PaymentMethod', CurrencyRef: 'Currency',
  CustomerTypeRef: null, ShipMethodRef: null, PriceLevelRef: null, EntityRef: null,
  ProjectRef: 'Customer', PrefVendorRef: 'Vendor',
};
// Party references must name a customer/vendor created by this case.
const PARTY_REFS = { CustomerRef: 'Customer', VendorRef: 'Vendor', EmployeeRef: 'Employee', ProjectRef: 'Customer', PrefVendorRef: 'Vendor' };
// Shared lists whose existing records may be parents (a sub-account under Chequing).
const SHARED_PARENT_TYPES = ['Account', 'Class', 'Department', 'Item'];
// An unlisted reference is allowed only when its name cannot denote a person,
// party, project, user or transaction.
const RESTRICTED_REF_NAME = /Customer|Vendor|Employee|Entity|Project|Party|Payee|Payer|Rep|Txn|Linked|Invoice|Bill|Payment|Estimate|Order|Receipt|Memo|Credit|Deposit|Transfer|Journal|Charge|Parent|Owner|User|ByRef$/i;
const owns = (owned, type, id) => owned.some((r) => r.entityType === type && String(r.id) === String(id) && !r.deleted);
const fail = (message) => { throw new Error(message); };

function checkReferences(value, owned, entityType) {
  if (Array.isArray(value)) return value.forEach((v) => checkReferences(v, owned, entityType));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['ProcessPayment', 'ProcessBillPayment', 'CreditChargeInfo'].includes(key) && item) {
      fail('Reproduction records cannot process real payments.');
    }
    if (key === 'ParentRef' && !SHARED_PARENT_TYPES.includes(entityType) && !owns(owned, entityType, item?.value)) fail('Parent records must belong to this case.');
    if (Object.hasOwn(PARTY_REFS, key) && !owns(owned, PARTY_REFS[key], item?.value)) fail('Counterparty records must belong to this case to protect existing balances.');
    if (key === 'EntityRef') {
      // Journal entry lines carry the type beside the reference: Entity { Type, EntityRef }.
      if (item?.type && value.Type && item.type !== value.Type) fail('EntityRef.type and Entity.Type disagree.');
      const type = item?.type || value.Type;
      if (!type) fail('Entity relationships need a type: include EntityRef.type (Customer, Vendor or Employee).');
      if (!owns(owned, type, item?.value)) fail('Entity relationships must belong to this case.');
    }
    // Deposit lines name the party directly: DepositLineDetail.Entity { value, type }.
    if (/Entity$/.test(key) && item && typeof item === 'object' && Object.hasOwn(item, 'value')) {
      if (!item.type) fail('Entity relationships need a type: include Entity.type (Customer, Vendor or Employee).');
      if (!owns(owned, item.type, item.value)) fail('Entity relationships must belong to this case.');
    }
    if (key === 'LinkedTxn') {
      if (!Array.isArray(item)) fail('LinkedTxn must be a list.');
      for (const link of item) {
        if (!owns(owned, link.TxnType, link.TxnId)) fail('Transaction links must point to records created in this case.');
      }
    } else if (key === 'TxnId') {
      if (!owns(owned, value.TxnType, item)) fail('Transaction links must point to records created in this case.');
    } else if (key.endsWith('Ref') && !Object.hasOwn(SAFE_REF_TYPES, key) && RESTRICTED_REF_NAME.test(key)) {
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
  const key = [sources, check.aggregate, check.operator, check.expected];
  // A historical (intermediate-state) reading is separate from a current one.
  return JSON.stringify(check.historical ? [...key, 'historical'] : key);
}

// Per condition, the latest reading of each measurement counts. A historical
// reading (an intermediate state) stays valid evidence of what it saw. An older
// passing reading is superseded once the condition has current readings that
// all pass; an older failing or unavailable reading still blocks until that
// same measurement is re-read.
function conditionResults(conditions, checks, revision) {
  return conditions.map((label) => {
    const measurements = new Map();
    for (const check of checks) {
      if (check.label === label) measurements.set(measurementKey(check), check);
    }
    const all = [...measurements.values()].map((check) => ({
      ...check, current: check.revision === revision || (check.historical === true && check.available === true),
    }));
    const fresh = all.filter((check) => check.revision === revision && !check.historical);
    const freshPass = fresh.length > 0 && fresh.every((check) => check.available && check.passed === true);
    const evidence = all.map((check) => (!check.current && check.passed === true && freshPass ? { ...check, superseded: true } : check));
    const counted = evidence.filter((check) => !check.superseded);
    const available = counted.length > 0 && counted.every((check) => check.current && check.available);
    return { label, checks: evidence, available,
      passed: available ? counted.every((check) => check.passed === true) : null };
  });
}

// completed: built as requested and verified. reproduced / not_reproduced: a
// measured symptom. needs_input: waiting for the operator, not a conclusion.
const FINISH_OUTCOMES = ['completed', 'reproduced', 'not_reproduced', 'unverified'];

function classifyOutcome(requested, conditions, checks, revision) {
  if (requested === 'needs_input') return requested;
  if (!FINISH_OUTCOMES.includes(requested)) return 'unverified';
  if (requested === 'unverified') return requested;
  return unsupportedConditions(requested, conditions, checks, revision).length ? 'unverified' : requested;
}

// Conditions that keep a requested outcome from being supported. Every outcome
// needs complete, current evidence; completed also needs every condition to
// pass. Symptom outcomes trust the model's direction, because conditions are
// often phrased as expected behaviour.
function unsupportedConditions(requested, conditions, checks, revision) {
  if (!conditions.length) return [{ number: 0, label: '(none)', problem: 'no conditions are defined' }];
  return conditionResults(conditions, checks, revision).map((c, i) => ({ number: i + 1, label: c.label,
    problem: !c.checks.length ? 'not checked'
      : !c.available ? 'evidence is missing, unavailable or older than the latest change'
        : requested === 'completed' && !c.passed ? 'a check did not pass' : null }))
    .filter((c) => c.problem);
}

// Stages qbo-client assigns to failures raised before a request left this
// server: token refresh, connection storage and write admission.
const PRE_SEND_STAGES = ['refresh', 'refresh_response', 'storage_read', 'storage_save', 'conflict', 'write_admission'];

// True only when a failed write certainly did not change QuickBooks.
function writeFailureIsDefinite(err, sent) {
  if (!sent) return true;
  if (err?.outcomeUnknown === true || err?.qboStage === 'write_receipt') return false;
  if (err?.definite || PRE_SEND_STAGES.includes(err?.qboStage)) return true;
  const status = Number(err?.status);
  return status >= 400 && status < 500;
}

// Report evidence: find one cell in a raw QBO report by row label, optional
// enclosing section label and optional column title (default: last column).
function findReportCell(report, { row, section, column }) {
  const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const titles = (report?.Columns?.Column || []).map((c) => c?.ColTitle || c?.ColType || '');
  const index = column === undefined || column === null || column === '' ? titles.length - 1 : titles.findIndex((t) => norm(t) === norm(column));
  if (index < 0) return { available: false, reason: 'The report has no column titled ' + column + '.', columns: titles.slice(0, 40) };
  const matches = [];
  const walk = (rows, sections) => {
    for (const r of rows || []) {
      const heading = r?.Header?.ColData?.[0]?.value;
      const inside = heading ? [...sections, heading] : sections;
      // A section heading counts only when it carries a value in the column.
      for (const cells of [r?.Header?.ColData?.[index]?.value ? r.Header.ColData : null, r?.ColData, r?.Summary?.ColData]) {
        if (Array.isArray(cells) && norm(cells[0]?.value) === norm(row)
            && (!section || inside.some((s) => norm(s) === norm(section)))) matches.push(cells);
      }
      walk(r?.Rows?.Row, inside);
    }
  };
  walk(report?.Rows?.Row, []);
  if (!matches.length) return { available: false, reason: 'No report row is labelled ' + row + (section ? ' in ' + section : '') + '.' };
  if (matches.length > 1) return { available: false, reason: 'Several report rows are labelled ' + row + '; name the enclosing section.' };
  const cell = matches[0][index];
  if (!cell || cell.value === undefined || cell.value === '') return { available: false, reason: 'The matching report cell is empty.', column: titles[index] };
  return { available: true, text: String(cell.value), column: titles[index] };
}

// Report text to a number: 1,234.50, $40,000.00 and (12.00) for negatives.
function reportNumber(text) {
  const raw = String(text).trim();
  const negative = /^\(.*\)$/.test(raw);
  const value = Number(raw.replace(/[()$,\s]/g, ''));
  return raw && Number.isFinite(value) ? (negative ? -value : value) : null;
}

module.exports = { WRITES, DELETE_TYPES, FINISH_OUTCOMES, PRE_SEND_STAGES, writeFailureIsDefinite, findReportCell, reportNumber, unsupportedConditions, owns, checkReferences, checkSavedRecord, checkWrite, checkApprovalRequest, pathValues, evaluateCheck, measurementKey, conditionResults, classifyOutcome };
