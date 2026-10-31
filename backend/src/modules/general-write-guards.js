'use strict';
// Deterministic guards of the general governed write tool (manageQboRecord), contract
// general-write-v1, design docs/plans/general-governed-write-tool-2026-10-31.md (rev 3).
// Pure: every input is passed in (the proposal, a local-copy reader over the synced
// company records, and the published business context). Nothing here calls QuickBooks,
// reads the database or writes. The same check runs at preparation, at approval and
// immediately before each batch is sent, against the copy at its current watermark.
//
// Guards apply to the EFFECTIVE record: the payload of a create, the current record
// merged with a sparse update, and the current record that a void or delete removes.
// checkGeneralWrite returns { ok, problems, plan }; problems name each operation by its
// ref and say plainly what to change, so the model can correct and re-propose.
const { ENTITIES, REF_TARGETS, ACCOUNT_TYPES, readOnlyFields } = require('./qbo-entity-schema');
const REF = /^[a-z][a-z0-9-]{0,39}$/, QBO_ID = /^\d{1,30}$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_CAPS = Object.freeze({ record: 5000000, operation: 12000000, journalLine: 1000000, quantity: 1000000, operations: 60, lines: 100, bytes: 65536 });
const TAXED_LINES = ['SalesItemLineDetail', 'ItemBasedExpenseLineDetail', 'AccountBasedExpenseLineDetail'];
const PARTY = { Payment: 'CustomerRef', BillPayment: 'VendorRef' }, CONTROL = { Payment: 'ARAccountRef', BillPayment: 'APAccountRef' };
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function cents(value) { if (typeof value !== 'number' || !Number.isFinite(value)) return null; const n = Math.round(value * 100); return Number.isSafeInteger(n) && Math.abs(value * 100 - n) < 0.00001 ? n : null; }
const linkType = type => type === 'BillPaymentCheck' ? 'BillPayment' : type;
const allLinks = record => [...(record?.LinkedTxn || []), ...(Array.isArray(record?.Line) ? record.Line : []).flatMap(line => line?.LinkedTxn || [])].map(link => ({ ...link, TxnType: linkType(link?.TxnType) }));
const isRefObject = value => plain(value) && value.$ref !== undefined;
// Walk every *Ref in a payload: { path, key, ref } (ref is the {value,...} object).
function refsIn(value, path = '', out = []) {
  if (Array.isArray(value)) value.forEach((entry, index) => refsIn(entry, path + '[' + index + ']', out));
  else if (plain(value)) for (const [key, entry] of Object.entries(value)) {
    if (/Ref$/.test(key) && plain(entry)) out.push({ path: path ? path + '.' + key : key, key, ref: entry });
    else refsIn(entry, path ? path + '.' + key : key, out);
  }
  return out;
}
function linksIn(record) {
  const header = (record?.LinkedTxn || []).map(link => ({ level: 'header', link }));
  const lines = (Array.isArray(record?.Line) ? record.Line : []).flatMap((line, index) => (line?.LinkedTxn || []).map(link => ({ level: 'line', index, line, link })));
  return [...header, ...lines];
}
// The record a sparse update leaves behind: QuickBooks replaces each top-level field sent
// (a sent Line list replaces all lines).
function effectiveRecord(op, existing, payload) {
  if (op === 'create') return payload;
  if (op === 'update') return { ...existing, ...payload };
  return null; // void and delete leave no posting record behind
}
// Net of the record's lines (journal: debits; Payment/BillPayment/Transfer: their amount).
function netCents(entity, record) {
  if (!record) return 0;
  if (entity === 'Transfer') return cents(record.Amount) || 0;
  if (['Payment', 'BillPayment'].includes(entity)) return cents(record.TotalAmt) || 0;
  const lines = Array.isArray(record.Line) ? record.Line : [];
  if (entity === 'JournalEntry') return lines.filter(line => line?.JournalEntryLineDetail?.PostingType === 'Debit').reduce((sum, line) => sum + (cents(line.Amount) || 0), 0);
  return lines.filter(line => line?.DetailType !== 'SubTotalLineDetail').reduce((sum, line) => sum + (cents(line?.Amount) || 0), 0);
}
// Gross including tax. QuickBooks computes the tax; the bound uses the published dated
// rates (context.taxPercent: code id -> total percent) on each taxed line, or the
// record's own saved tax when it has one.
function grossCents(entity, record, context, { saved = false } = {}) {
  if (!record) return 0;
  const net = netCents(entity, record);
  // A saved record's (or unchanged lines') tax is QuickBooks' own.
  if (saved && cents(record.TxnTaxDetail?.TotalTax) !== null) return net + cents(record.TxnTaxDetail.TotalTax);
  const tax = (Array.isArray(record.Line) ? record.Line : []).filter(line => TAXED_LINES.includes(line?.DetailType)).reduce((sum, line) => {
    const code = String(line[line.DetailType]?.TaxCodeRef?.value ?? ''), percent = Number(context.taxPercent?.[code]) || 0;
    return sum + Math.round((cents(line.Amount) || 0) * percent / 100);
  }, 0);
  return net + tax;
}
// Inventory the record moves: inventory item lines, inventory-type items, lines or
// journal lines on the inventory asset account (general-write-v1 gates all of these off).
function inventoryTouch(entity, record, local, byRef = new Map()) {
  if (!record) return null;
  const lookup = (kind, ref) => {
    const name = ref?.$ref ?? ref?.value?.$ref;
    return name ? byRef.get(name)?.after : local.get(kind, String(ref?.value));
  };
  for (const key of ['FromAccountRef', 'ToAccountRef', 'AccountRef', 'DepositToAccountRef', 'AssetAccountRef']) {
    const accountId = record[key]?.value;
    if (record[key] && lookup('Account', record[key])?.AccountSubType === 'Inventory') return 'the inventory asset account';
  }
  if (entity === 'Item' && (record.Type === 'Inventory' || record.TrackQtyOnHand === true || record.QtyOnHand !== undefined)) return 'an inventory item';
  let stockItem = null;
  for (const line of Array.isArray(record.Line) ? record.Line : []) {
    const detail = line?.[line?.DetailType], itemId = detail?.ItemRef?.value, accountId = detail?.AccountRef?.value;
    if (detail?.ItemRef && lookup('Item', detail.ItemRef)?.Type === 'Inventory') stockItem = 'inventory item ' + (itemId ?? 'from an earlier operation');
    if (detail?.AccountRef && lookup('Account', detail.AccountRef)?.AccountSubType === 'Inventory') return 'the inventory asset account';
  }
  return stockItem;
}
function checkGeneralWrite({ proposal, local, context }) {
  const problems = [], caps = { ...DEFAULT_CAPS, ...(context?.caps || {}) };
  const say = (ref, message) => problems.push({ ref: ref ?? null, message });
  if (!plain(proposal) || !Array.isArray(proposal.operations)) return { ok: false, problems: [{ ref: null, message: 'Send { decisionKey, purpose, operations: [...] }.' }], plan: null };
  if (!DAY.test(context?.day || '')) throw new TypeError('The guard context needs the current open business day.');
  const ops = proposal.operations;
  if (!ops.length || ops.length > caps.operations) say(null, 'Send 1 to ' + caps.operations + ' operations.');
  const byRef = new Map(), applied = new Map(), deposited = new Set(), reverify = new Set(), external = [], touched = new Map();
  let exposure = 0;
  // dirty: the date's postings change (the record's own old and new dates). A linked
  // source keeps its postings; its balance and backlinks change, so it is protected only.
  const protectDate = (ref, date, what, dirty = true) => {
    if (!DAY.test(date || '')) return;
    if (context.protectedThrough && date <= context.protectedThrough) say(ref, what + ' dated ' + date + ' is inside the closed or reconciled period through ' + context.protectedThrough + '; it cannot be changed.');
    else if (dirty && context.verifiedThrough && date <= context.verifiedThrough) {
      reverify.add(date);
      say(ref, what + ' changes verified history. General history edits are held until downstream periods and the opening baseline can be re-proved.');
    }
  };
  ops.forEach((op, order) => {
    const ref = op?.ref;
    if (!plain(op) || typeof ref !== 'string' || !REF.test(ref)) return say(typeof ref === 'string' ? ref : null, 'Each operation needs a ref: lowercase letters, digits and dashes, up to 40.');
    if (byRef.has(ref)) return say(ref, 'Use each ref once.');
    const keys = Object.keys(op).filter(key => !['ref', 'op', 'entity', 'id', 'payload', 'reason'].includes(key));
    if (keys.length) say(ref, 'Unsupported operation fields: ' + keys.join(', ') + '.');
    const spec = ENTITIES[op.entity];
    if (!spec) return say(ref, 'Entity ' + op.entity + ' is not available to the governed write tool.');
    if (!spec.ops.includes(op.op)) return say(ref, op.entity + ' allows ' + spec.ops.join(', ') + ', not ' + op.op + '.');
    const entry = { ref, op: op.op, entity: op.entity, order, dependsOn: new Set() };
    byRef.set(ref, entry);
    const payload = op.payload === undefined && ['void', 'delete'].includes(op.op) ? {} : op.payload;
    if (!plain(payload)) return say(ref, 'Send the record fields as a payload object.');
    if (['void', 'delete'].includes(op.op) && Object.keys(payload).length) say(ref, 'A ' + op.op + ' sends no fields.');
    if (Buffer.byteLength(JSON.stringify(payload)) > caps.bytes) say(ref, 'The payload is larger than ' + caps.bytes + ' bytes.');
    entry.payload = payload;
    // Existing record: create sends no id; every other operation names its target.
    let existing = null;
    if (op.op === 'create') { if (op.id !== undefined) say(ref, 'A create names no id.'); }
    else {
      if (!QBO_ID.test(op.id || '')) return say(ref, 'Name the QuickBooks id of the record to ' + op.op + '.');
      existing = local.get(op.entity, op.id);
      if (!existing) return say(ref, op.entity + ' ' + op.id + ' is not in the synced company copy.');
      const key = op.entity + ':' + op.id;
      if (touched.has(key)) say(ref, op.entity + ' ' + op.id + ' is already changed by ' + touched.get(key) + ' in this operation; combine the changes.'); touched.set(key, ref);
      entry.id = op.id; entry.before = existing; entry.targetVersion = existing.SyncToken ?? null;
      if (!local.owned(op.entity, op.id)) {
        if (typeof op.reason !== 'string' || op.reason.trim().length < 10 || op.reason.length > 1000) say(ref, op.entity + ' ' + op.id + ' was not created by the accountant: state a reason (10 to 1,000 characters). Its before and after images are audited.');
        external.push({ ref, entity: op.entity, id: op.id, op: op.op });
      }
    }
    if (typeof op.reason === 'string') entry.reason = op.reason.trim();
    const after = effectiveRecord(op.op, existing, payload);
    entry.after = after;
    // 1. Shape of what is sent.
    for (const key of readOnlyFields(op.entity)) if (payload[key] !== undefined) say(ref, key + ' is set by QuickBooks; leave it out.');
    if (op.op === 'create') for (const key of spec.required) if (payload[key] === undefined) say(ref, op.entity + ' needs ' + key + '.');
    const allowed = new Set([...spec.required, ...(spec.optional || []), 'Line', 'TxnDate', 'PrivateNote', 'CurrencyRef', 'Active']);
    for (const key of Object.keys(payload)) if (!allowed.has(key) && !readOnlyFields(op.entity).includes(key)) say(ref, key + ' is not a supported ' + op.entity + ' field (see getQboEntitySchema).');
    if (spec.safe && op.op === 'update') for (const [group, fields] of Object.entries(payload)) for (const field of Object.keys(plain(fields) ? fields : {})) if (!spec.safe.includes(group + '.' + field)) say(ref, 'Preferences ' + group + '.' + field + ' cannot be changed by the accountant.');
    if (after?.CurrencyRef !== undefined && after.CurrencyRef?.value !== 'CAD') say(ref, 'Only CAD records are supported.');
    if (payload.Line !== undefined && !Array.isArray(payload.Line)) say(ref, 'Line must be a list.');
    if (Array.isArray(payload.Line) && payload.Line.length > caps.lines) say(ref, 'Use at most ' + caps.lines + ' lines.');
    for (const line of Array.isArray(payload.Line) ? payload.Line : []) {
      const type = line?.DetailType, linked = Array.isArray(line?.LinkedTxn) && line.LinkedTxn.length;
      if (!(spec.lines || []).includes(type) && !((spec.lines || []).includes('LinkedOnly') && linked && type === undefined)) say(ref, 'Line DetailType ' + type + ' is not used on ' + op.entity + '.');
      if (type === 'DiscountLineDetail') say(ref, 'Discount lines are not in general-write-v1 yet; reduce the line price instead.');
      const amount = line?.Amount === undefined ? 0 : cents(line.Amount);
      if (amount === null || amount < 0) say(ref, 'Line amounts are non-negative exact cents.');
      const qty = line?.[type]?.Qty;
      if (qty !== undefined && (typeof qty !== 'number' || !Number.isFinite(qty) || qty < 0 || qty > caps.quantity)) say(ref, 'Line quantities are from 0 to ' + caps.quantity + '.');
      if (type === 'JournalEntryLineDetail' && amount > caps.journalLine) say(ref, 'Each journal line is at most $' + caps.journalLine / 100 + '.');
      // QuickBooks computes tax from the published codes; no tax overrides.
      if (line?.[type]?.TaxInclusiveAmt !== undefined || line?.[type]?.TaxAmount !== undefined) say(ref, 'Leave tax amounts out; QuickBooks computes tax from the TaxCodeRef.');
    }
    // Inventory is gated off in general-write-v1 (before or after the change).
    const stock = inventoryTouch(op.entity, existing, local, byRef) || inventoryTouch(op.entity, after, local, byRef);
    if (stock) {
      entry.stock = true;
      if (context.inventory?.enabled !== true) say(ref, 'This touches ' + stock + '. Inventory is not in general-write-v1 unless GENERAL_WRITE_INVENTORY_ENABLED is enabled.');
      else if (context.inventory.entities?.[op.entity] !== true) say(ref, op.entity + ' inventory is disabled by its entity allow-list flag.');
      else if (!['create'].includes(op.op)) say(ref, 'Inventory changes and removals need downstream FIFO revaluation and are held; create a supported current-day record.');
      else if (op.entity === 'Item' || op.entity === 'InventoryAdjustment' || stock === 'the inventory asset account') say(ref, 'Direct inventory adjustments and asset-account postings are held pending independently dated valuation proof.');
    }
    // 2. Dates: new work on the open business day; history edits outside protected periods.
    if (spec.kind === 'transaction') {
      if (op.op === 'create' && payload.TxnDate !== context.day) say(ref, 'Date new records ' + context.day + ', the open business day.');
      if (op.op === 'update' && payload.TxnDate !== undefined && (!DAY.test(payload.TxnDate) || payload.TxnDate > context.day)) say(ref, 'Records cannot be dated after ' + context.day + '.');
      if (existing) protectDate(ref, existing.TxnDate, op.entity + ' ' + op.id);
      if (op.op === 'update' && payload.TxnDate !== undefined) protectDate(ref, payload.TxnDate, 'The new date');
      // Affected sources of a change or removal: records linked before or after it. (A new
      // settlement may link historical sources; they stay read-only prerequisites.)
      if (op.op !== 'create') for (const { link } of [...linksIn(existing), ...linksIn(after)]) {
        if (isRefObject(link?.TxnId) || link?.$ref !== undefined || !QBO_ID.test(String(link?.TxnId ?? ''))) continue;
        const source = local.get(linkType(link.TxnType), String(link.TxnId));
        if (source?.TxnDate) protectDate(ref, source.TxnDate, 'Linked ' + linkType(link.TxnType) + ' ' + link.TxnId, false);
      }
    }
    // 3. Amounts: gross including tax, per record and as absolute plan exposure.
    const beforeGross = grossCents(op.entity, existing, context, { saved: true }), afterGross = grossCents(op.entity, after, context, { saved: op.op === 'update' && payload.Line === undefined });
    if (Math.max(beforeGross, afterGross) > caps.record) say(ref, 'One record moves at most $' + caps.record / 100 + ' including tax.');
    exposure += op.op === 'create' ? afterGross : op.op === 'update' ? Math.abs(afterGross - beforeGross) : beforeGross;
    if (op.entity === 'JournalEntry' && Array.isArray(after?.Line)) {
      const side = posting => after.Line.filter(line => line?.JournalEntryLineDetail?.PostingType === posting).reduce((sum, line) => sum + (cents(line.Amount) || 0), 0);
      if (side('Debit') !== side('Credit') || !side('Debit')) say(ref, 'A journal entry must balance: total debits equal total credits.');
    }
    // 4. References in what is sent: in the company copy (or an earlier create), right type.
    for (const { path, key, ref: target } of refsIn(payload)) {
      if (key === 'CurrencyRef') continue;
      const kinds = REF_TARGETS[key];
      if (!kinds) { say(ref, path + ' is not a supported reference.'); continue; }
      // An attachment's EntityRef names the record it is attached to, of any allowed type.
      const wanted = key === 'EntityRef' && path.startsWith('AttachableRef') ? (ENTITIES[target.type] ? [target.type] : []) : kinds.map(kind => kind === 'self' ? op.entity : kind);
      if (!wanted.length) { say(ref, path + ' names an unsupported record type.'); continue; }
      if (isRefObject(target) || isRefObject(target.value)) {
        const name = target.$ref ?? target.value.$ref, earlier = byRef.get(name);
        if (!earlier || earlier.order >= order || earlier.op !== 'create') { say(ref, path + ' names $ref ' + name + ', which is not an earlier create in this operation.'); continue; }
        if (!wanted.includes(earlier.entity)) say(ref, path + ' must reference a ' + wanted.join(' or ') + ', not ' + earlier.entity + '.');
        entry.dependsOn.add(name); continue;
      }
      if (!QBO_ID.test(String(target.value || ''))) { say(ref, path + ' needs a QuickBooks id.'); continue; }
      const hits = wanted.map(kind => [kind, local.get(kind, String(target.value))]).filter(([, record]) => record);
      if (key === 'EntityRef' && target.type && !hits.some(([kind]) => kind === target.type)) { say(ref, path + ' ' + target.value + ' is not a ' + target.type + '.'); continue; }
      if (!hits.length) { say(ref, path + ' ' + target.value + ' is not a ' + wanted.join(' or ') + ' in the synced company copy.'); continue; }
      const [kind, record] = hits[0];
      if (record.Active === false) say(ref, path + ' ' + target.value + ' is inactive.');
      if (['Customer', 'Vendor'].includes(kind) && record.CurrencyRef?.value && record.CurrencyRef.value !== 'CAD') say(ref, path + ' ' + target.value + ' is not a CAD party.');
      if (kind === 'Account' && ACCOUNT_TYPES[key] && !ACCOUNT_TYPES[key].includes(record.AccountType)) say(ref, path + ' ' + target.value + ' is a ' + record.AccountType + ' account; ' + key + ' needs ' + ACCOUNT_TYPES[key].join(' or ') + '.');
      if (kind === 'TaxCode' && spec.direction && !(context.taxCodes?.[spec.direction] || []).includes(String(target.value))) say(ref, path + ' tax code ' + target.value + ' is not in the published ' + spec.direction + ' tax policy (' + (context.taxCodes?.[spec.direction] || []).join(', ') + ').');
    }
    // 6. Tax: QuickBooks computes it from published codes on tax-excluded lines.
    if (spec.direction && after && Array.isArray(after.Line) && (op.op === 'create' || payload.Line !== undefined || payload.GlobalTaxCalculation !== undefined)) {
      if (after.GlobalTaxCalculation !== 'TaxExcluded') say(ref, 'Set GlobalTaxCalculation "TaxExcluded".');
      for (const line of after.Line) if (TAXED_LINES.includes(line?.DetailType) && !line[line.DetailType]?.TaxCodeRef) say(ref, 'Every ' + line.DetailType + ' line needs a TaxCodeRef from the published tax policy.');
    }
    // 5. Applications: same party, control account and currency as the target; never
    // more than its open balance (an update first gives back what it applied before).
    const rules = spec.links || {}, party = PARTY[op.entity], control = CONTROL[op.entity];
    const previously = new Map();
    for (const { level, line, link } of linksIn(existing)) if (level === 'line') { const key = linkType(link.TxnType) + ':' + link.TxnId; previously.set(key, (previously.get(key) || 0) + (cents(line.Amount) || 0)); }
    for (const { level, line, link } of linksIn(after)) {
      const type = linkType(link?.TxnType), target = String(link?.TxnId ?? '');
      if (!(rules[level] || []).includes(type)) { say(ref, op.entity + ' cannot link ' + type + ' at ' + level + ' level.'); continue; }
      if (isRefObject(link.TxnId) || link.$ref !== undefined) { const name = link.TxnId?.$ref ?? link.$ref, earlier = byRef.get(name); if (!earlier || earlier.order >= order || earlier.entity !== type) say(ref, 'A link $ref must name an earlier create of a ' + type + '.'); else entry.dependsOn.add(name); continue; }
      const record = QBO_ID.test(target) && local.get(type, target);
      if (!record) { say(ref, type + ' ' + target + ' is not in the synced company copy.'); continue; }
      if (party && after[party]?.value != null && record[party]?.value != null && String(record[party].value) !== String(after[party].value)) say(ref, type + ' ' + target + ' belongs to another ' + (party === 'CustomerRef' ? 'customer' : 'supplier') + '.');
      if (control && after[control]?.value != null && record[control]?.value != null && String(record[control].value) !== String(after[control].value)) say(ref, type + ' ' + target + ' posted to another ' + (control === 'ARAccountRef' ? 'receivables' : 'payables') + ' account.');
      if (record.CurrencyRef?.value && record.CurrencyRef.value !== 'CAD') say(ref, type + ' ' + target + ' is not in CAD.');
      const amount = level === 'line' ? cents(line.Amount) || 0 : 0, key = type + ':' + target, back = previously.get(key) || 0;
      const openOf = { Invoice: 'Balance', Bill: 'Balance', CreditMemo: 'RemainingCredit', VendorCredit: 'Balance' }[type];
      if (openOf) {
        const open = (cents(record[openOf]) || 0) + back; applied.set(key, (applied.get(key) || 0) + amount);
        if (applied.get(key) > open) say(ref, type + ' ' + target + ' has $' + open / 100 + ' open; this plan applies $' + applied.get(key) / 100 + '.');
      } else if (['Payment', 'SalesReceipt'].includes(type)) {
        const holding = record.DepositToAccountRef?.value, account = holding && local.get('Account', String(holding));
        const elsewhere = allLinks(record).some(row => row.TxnType === 'Deposit' && !(op.id && String(row.TxnId) === op.id));
        if (deposited.has(key) || elsewhere || (holding && account?.AccountSubType !== 'UndepositedFunds')) say(ref, type + ' ' + target + ' is not waiting in Undeposited Funds or is already deposited.');
        else if (amount !== cents(record.TotalAmt)) say(ref, 'Deposit ' + type + ' ' + target + ' for its full amount, $' + (cents(record.TotalAmt) || 0) / 100 + '.');
        deposited.add(key);
      } else if (type === 'Estimate') { if (!['Pending', 'Accepted'].includes(record.TxnStatus) || allLinks(record).some(row => row.TxnType === 'Invoice' && !(op.id && String(row.TxnId) === op.id))) say(ref, 'Estimate ' + target + ' is no longer open.'); }
      else if (type === 'TimeActivity') { if (record.BillableStatus !== 'Billable' && !previously.has(key)) say(ref, 'Time entry ' + target + ' is not billable or was already billed.'); }
      else if (type === 'PurchaseOrder') { if (record.POStatus !== 'Open') say(ref, 'Purchase order ' + target + ' is closed.'); }
    }
    if (party && after && Array.isArray(after.Line) && (op.op === 'create' || payload.Line !== undefined || payload.TotalAmt !== undefined)) {
      const credit = op.entity === 'Payment' ? 'CreditMemo' : 'VendorCredit', sum = after.Line.reduce((total, line) => total + (linkType(line?.LinkedTxn?.[0]?.TxnType) === credit ? -1 : 1) * (cents(line?.Amount) || 0), 0);
      if (after.Line.some(line => line?.LinkedTxn?.length !== 1)) say(ref, 'Each ' + op.entity + ' line links exactly one record.');
      if (cents(after.TotalAmt) !== sum) say(ref, 'TotalAmt must equal the applied lines minus applied credits ($' + sum / 100 + '); unapplied prepayments are not supported yet.');
    }
  });
  if (!problems.length && [...byRef.values()].some(entry => entry.stock && !['Estimate', 'PurchaseOrder'].includes(entry.entity))) {
    try { require('./business-stock-general').checkStockPlan([...byRef.values()], local, context.stock); }
    catch (error) { say(error.ref || [...byRef.values()].find(entry => entry.stock)?.ref, error.message); }
  }
  if (exposure > caps.operation) say(null, 'One operation moves at most $' + caps.operation / 100 + ' including tax (created, changed and removed amounts together).');
  // Batches: QuickBooks batch items are unordered and cannot reference each other, so
  // references and shared resources (records before and after, stock items) decide order.
  let layers = [];
  const entries = [...byRef.values()].sort((x, y) => x.order - y.order);
  if (!problems.length) layers = require('./general-write-scheduler').scheduleBatches(entries.map(entry => ({ ref: entry.ref, op: entry.op, entity: entry.entity, ...(entry.id ? { id: entry.id } : {}), payload: entry.payload, before: entry.before || null, dependsOn: [...entry.dependsOn] })), local).batches;
  const ok = problems.length === 0;
  return { ok, problems, plan: ok ? { contract: 'general-write-v1', operations: entries.map(({ ref, op, entity, id, payload, order, dependsOn, before, targetVersion, reason }) => ({ ref, op, entity, ...(id ? { id, targetVersion, before } : {}), payload, order, dependsOn: [...dependsOn].sort(), ...(reason ? { reason } : {}) })), layers, reverifyDates: [...reverify].sort(), externalEdits: external, exposureCents: exposure } : null };
}
module.exports = { checkGeneralWrite, refsIn, effectiveRecord, grossCents, DEFAULT_CAPS };
