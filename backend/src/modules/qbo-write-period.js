'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { scoped, denied } = require('./qbo-write-contract');
const TRANSACTIONS = new Map(['Invoice', 'Payment', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate', 'Bill', 'BillPayment', 'VendorCredit', 'Purchase', 'PurchaseOrder', 'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity', 'InventoryAdjustment', 'TaxPayment'].map(name => [name.toLowerCase(), name]));
const LISTS = new Map(['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'Class', 'Department', 'Term', 'TaxCode', 'TaxRate', 'PaymentMethod'].map(name => [name.toLowerCase(), name]));
const ID = /^\d{1,30}$/, HASH = /^[a-f0-9]{64}$/;
const AUTOMATIC_CREDITS_CODE = 'BUSINESS_AUTOMATIC_CREDITS_BLOCKED';
const AUTOMATIC_CREDITS_MESSAGE = 'QuickBooks must have Automatically apply credits switched off before this request. Check Settings → Account and settings → Advanced → Automation, then explicitly continue the saved work. This request was not sent.';
const plain = value => Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function automaticCreditsBlocked() { return Object.assign(denied(AUTOMATIC_CREDITS_MESSAGE), { code: AUTOMATIC_CREDITS_CODE }); }
function needsCreditControl(request, payload) {
  return request.operation === 'create' && (['invoice', 'creditmemo'].includes(request.entity) || (request.entity === 'payment' && linksIn(payload).some(link => link.entity === 'CreditMemo')));
}
function day(value) { try { date(value); return value; } catch { throw denied('A valid explicit accounting date is required before writing.'); } }
function linksIn(value) {
  const found = new Map(); let visits = 0;
  function walk(node, depth = 0) {
    if (depth > 25 || ++visits > 20000) throw denied('The transaction links exceed the protected-period read budget.');
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'LinkedTxn') {
        if (!Array.isArray(child)) throw denied('Transaction links must be explicit complete lists.');
        for (const link of child) {
          const entity = typeof link?.TxnType === 'string' ? TRANSACTIONS.get(link.TxnType.toLowerCase()) : null;
          if (!entity || !ID.test(link?.TxnId || '')) throw denied('A linked transaction type or identity cannot be checked for protected dates.');
          found.set(entity + ':' + link.TxnId, { entity, id: link.TxnId });
        }
      } else walk(child, depth + 1);
    }
  }
  walk(value); return [...found.values()].sort((a, b) => (a.entity + ':' + a.id).localeCompare(b.entity + ':' + b.id));
}
function datesIn(entity, record, required) {
  const dates = [];
  const field = entity === 'taxpayment' ? 'PaymentDate' : 'TxnDate';
  if (required || record[field] !== undefined) dates.push(day(record[field]));
  if (entity === 'item' && record.InvStartDate !== undefined) dates.push(day(record.InvStartDate));
  return dates;
}
// New settlement records post on their own date. Their historical sources are
// read-only prerequisites; updates, reversals and ambiguous relinking remain protected.
function settlementSources(request, payload) {
  if (request.operation !== 'create') return false;
  const contracts = { payment: ['Invoice'], billpayment: ['Bill'], invoice: ['Estimate', 'TimeActivity'], bill: ['PurchaseOrder'], deposit: ['Payment', 'SalesReceipt'] };
  const types = contracts[request.entity], links = linksIn(payload);
  if (!types || !links.length || links.some(link => !types.includes(link.entity)) || !Array.isArray(payload.Line) || !payload.Line.length) return false;
  if (['payment', 'billpayment', 'deposit'].includes(request.entity)) return payload.LinkedTxn === undefined && payload.Line.every(line => Number.isFinite(line.Amount) && line.Amount > 0 && Array.isArray(line.LinkedTxn) && line.LinkedTxn.length === 1 && types.includes(line.LinkedTxn[0].TxnType));
  // Conversions have explicit source links and positive item amounts. Unsupported
  // credits/relinks are never inferred to be harmless historical prerequisites.
  return payload.Line.every(line => Number.isFinite(line.Amount) && line.Amount > 0 && ['SalesItemLineDetail', 'ItemBasedExpenseLineDetail'].includes(line.DetailType));
}
function postingDates(request, payload, records, directDates) {
  return [...new Set([...directDates, ...(settlementSources(request, payload) ? [] : records.flatMap(row => row.dates))])].sort();
}
async function readWritePeriodEvidence(request, client, now = () => Date.now(), coordination = null) {
  const scope = scoped(request.scope), payload = JSON.parse(request.body), financial = TRANSACTIONS.has(request.entity), creditControl = needsCreditControl(request, payload);
  if (!financial && !LISTS.has(request.entity)) throw denied('This write type has no reviewed protected-period contract.');
  if (!financial && ['Balance', 'OpeningBalance', 'OpenBalanceDate', 'CurrentBalance'].some(key => payload[key] !== undefined)) throw denied('Opening balances require a separately reviewed dated transaction.');
  if (request.entity === 'item' && payload.QtyOnHand !== undefined) {
    if (request.operation !== 'create') throw denied('Inventory quantity changes require a dated inventory adjustment.');
    day(payload.InvStartDate);
  }
  const started = now(), records = new Map(), pending = linksIn(payload), directDates = datesIn(request.entity, payload, financial && request.operation === 'create');
  if (request.operation !== 'create') pending.unshift({ entity: TRANSACTIONS.get(request.entity) || LISTS.get(request.entity), id: request.targetId, target: true });
  while (pending.length) {
    const next = pending.shift(), key = next.entity + ':' + next.id;
    if (records.has(key)) continue;
    if (records.size >= 50 || now() - started > 180000) throw denied('Linked period evidence exceeds its read budget. Nothing was sent.');
    const body = await client.read(next.entity.toLowerCase(), next.id), record = body?.[next.entity];
    if (!record || record.Id !== next.id || typeof record.SyncToken !== 'string' || !/^\d+$/.test(record.SyncToken)) throw denied('An original or linked record could not be read completely before writing.');
    if (next.target && (typeof payload.SyncToken !== 'string' || payload.SyncToken !== record.SyncToken)) throw denied('The original record changed before protected-period verification.');
    const entity = next.entity.toLowerCase(), dates = datesIn(entity, record, TRANSACTIONS.has(entity)), links = linksIn(record);
    records.set(key, { entity: next.entity, id: next.id, syncToken: record.SyncToken, recordHash: hash(record), dates, links });
    for (const link of links) if (!records.has(link.entity + ':' + link.id)) pending.push(link);
  }
  const affectedDates = postingDates(request, payload, [...records.values()], directDates);
  let qboClosedThrough = null, preferencesHash = null;
  if (affectedDates.length) {
    const response = await client.query('SELECT * FROM Preferences MAXRESULTS 1'), preferences = response?.QueryResponse?.Preferences;
    if (!Array.isArray(preferences) || preferences.length !== 1 || !preferences[0]?.AccountingInfoPrefs || typeof preferences[0].AccountingInfoPrefs !== 'object') throw denied('QuickBooks closing preferences could not be verified. Nothing was sent.');
    if (creditControl && (!plain(preferences[0]) || !plain(preferences[0].AccountingInfoPrefs) || !plain(preferences[0].SalesFormsPrefs) || !own(preferences[0].SalesFormsPrefs, 'AutoApplyCredit') || preferences[0].SalesFormsPrefs.AutoApplyCredit !== false)) throw automaticCreditsBlocked();
    const raw = preferences[0].AccountingInfoPrefs.BookCloseDate;
    if (raw !== undefined && raw !== null && raw !== '') qboClosedThrough = day(raw);
    preferencesHash = hash(preferences[0]);
  }
  if (now() < started || now() - started > 180000) throw denied('Protected-period evidence expired during reading. Nothing was sent.');
  const evidence = { version: creditControl ? 2 : 1, ...(creditControl ? { autoApplyCredit: false } : {}), scope, coordination, requestHash: request.requestHash, startedAt: new Date(started).toISOString(), observedAt: new Date(now()).toISOString(), directDates, affectedDates, records: [...records.values()].sort((a, b) => (a.entity + ':' + a.id).localeCompare(b.entity + ':' + b.id)), preferencesHash, qboClosedThrough };
  if (Buffer.byteLength(canonical(evidence)) > 65536) throw denied('Protected-period evidence exceeds its retained evidence budget.');
  return { ...evidence, evidenceHash: hash(evidence) };
}
function assertPeriodControl(controls, scope, ownerId) {
  if (!controls || controls.version !== 1 || !HASH.test(controls.contentHash || '') || controls.status !== 'owner-recorded' || controls.ownerId !== ownerId) throw denied('The owner must record protected-period choices on the Company page before writing.');
  const { contentHash, ...control } = controls;
  if (hash(control) !== contentHash || canonical(control.scope) !== canonical(scope)) throw denied('Protected-period controls changed or belong to another company.');
  if (typeof controls.evidenceNote !== 'string' || controls.evidenceNote.trim().length < 10 || controls.evidenceNote.length > 2000 || !Number.isFinite(Date.parse(controls.recordedAt))) throw denied('Protected-period choices need retained owner evidence.');
  for (const key of ['closedThrough', 'reconciledThrough']) if (controls[key] !== null) day(controls[key]);
  return controls;
}
function assertWritePeriod(request, evidence, controls, now = Date.now(), ownerId) {
  assertPeriodControl(controls, request.scope, ownerId);
  if (!evidence) throw denied('Fresh protected-period and linked-record evidence is required.');
  const { evidenceHash, ...source } = evidence, started = Date.parse(source.startedAt), ended = Date.parse(source.observedAt);
  const payload = JSON.parse(request.body), creditControl = needsCreditControl(request, payload);
  if (source.version !== (creditControl ? 2 : 1) || source.requestHash !== request.requestHash || canonical(source.scope) !== canonical(request.scope) || hash(source) !== evidenceHash || !Number.isFinite(started) || !Number.isFinite(ended) || ended < started || ended > now || now - started > 300000 || !Array.isArray(source.directDates) || !Array.isArray(source.affectedDates) || !Array.isArray(source.records) || source.records.length > 50 || (source.affectedDates.length && !HASH.test(source.preferencesHash || ''))) throw denied('Protected-period observations are stale, incomplete or changed.');
  if (creditControl && (!own(source, 'autoApplyCredit') || source.autoApplyCredit !== false)) throw automaticCreditsBlocked();
  const direct = datesIn(request.entity, payload, TRANSACTIONS.has(request.entity) && request.operation === 'create');
  if (canonical(direct) !== canonical(source.directDates)) throw denied('The requested accounting dates changed.');
  const records = new Map();
  for (const row of source.records) {
    if (!row || typeof row.entity !== 'string' || !ID.test(row.id || '') || !HASH.test(row.recordHash || '') || !Array.isArray(row.dates) || !Array.isArray(row.links) || records.has(row.entity + ':' + row.id)) throw denied('Linked date observations are incomplete or repeated.');
    records.set(row.entity + ':' + row.id, row);
  }
  const roots = linksIn(payload);
  if (request.operation !== 'create') roots.push({ entity: TRANSACTIONS.get(request.entity) || LISTS.get(request.entity), id: request.targetId });
  const needed = new Set(), visit = link => { const key = link.entity + ':' + link.id; if (needed.has(key)) return; needed.add(key); const row = records.get(key); if (!row) throw denied('An original or linked transaction date is missing.'); for (const child of row.links) visit(child); };
  for (const link of roots) visit(link);
  if (needed.size !== records.size) throw denied('Period evidence contains unrelated records.');
  const expected = postingDates(request, payload, source.records, source.directDates);
  if (canonical(expected) !== canonical(source.affectedDates)) throw denied('Affected accounting dates are incomplete.');
  const cutoff = [controls.closedThrough, controls.reconciledThrough, source.qboClosedThrough].filter(value => value !== null).map(day).sort().at(-1) || null;
  for (const value of source.affectedDates) if (cutoff && day(value) <= cutoff) throw denied('This request affects a closed or reconciled period through ' + cutoff + '. No request was sent.');
  if (Buffer.byteLength(canonical(evidence)) > 65536) throw denied('Protected-period evidence exceeds its retained evidence budget.');
  return { evidenceHash, controlHash: controls.contentHash, protectedThrough: cutoff, affectedDates: [...source.affectedDates], evidence, controls: JSON.parse(canonical(controls)) };
}
module.exports = { readWritePeriodEvidence, assertPeriodControl, assertWritePeriod, linksIn, TRANSACTIONS, AUTOMATIC_CREDITS_CODE, AUTOMATIC_CREDITS_MESSAGE };
