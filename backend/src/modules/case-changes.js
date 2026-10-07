'use strict';

// A case's changes to QuickBooks as a person reads them: one row per record the
// assistant proposed or made, across every proposal in the case, with names in
// place of QuickBooks Ids (customer "Alex Blakey", account "Chequing", invoice
// "111057"). Rows come from the plan steps; names come from read-only lookups.

const PLACEHOLDER = /^\{\{\s*step\s*(\d+)\.(\w+)\s*\}\}$/;

// Reference fields and the QuickBooks list they point into.
const REF_TYPES = {
  CustomerRef: 'Customer', VendorRef: 'Vendor', EmployeeRef: 'Employee', ItemRef: 'Item',
  TaxCodeRef: 'TaxCode', SalesTermRef: 'Term', ClassRef: 'Class', DepartmentRef: 'Department',
  AccountRef: 'Account', DepositToAccountRef: 'Account', FromAccountRef: 'Account', ToAccountRef: 'Account',
  BankAccountRef: 'Account', CCAccountRef: 'Account', APAccountRef: 'Account', ARAccountRef: 'Account',
};
const LOOKUP_TYPES = ['Customer', 'Vendor', 'Employee', 'Item', 'TaxCode', 'Term', 'Class', 'Department', 'Account',
  'Invoice', 'Bill', 'Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Estimate', 'PurchaseOrder', 'SalesReceipt'];
const TXN_TYPES = new Set(['Invoice', 'Bill', 'Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Estimate', 'PurchaseOrder', 'SalesReceipt']);
const BALANCE_TYPES = new Set(['Invoice', 'Bill']);

// Older write tools and the record each one makes.
const LEGACY_TOOLS = {
  createInvoice: { action: 'create', entityType: 'Invoice' },
  createBill: { action: 'create', entityType: 'Bill' },
  applyPayment: { action: 'create', entityType: 'Payment' },
  applyBillPayment: { action: 'create', entityType: 'BillPayment' },
};
const WRITE_TOOLS = { createRecord: 'create', updateRecord: 'update', voidTransaction: 'void', deleteRecord: 'delete' };

const isId = (v) => /^\d+$/.test(String(v ?? ''));

// The older tools take their own lowercase shape; read them as QuickBooks bodies.
function legacyRecord(toolName, input) {
  const ref = (r) => (r && (r.id ?? r.value) !== undefined ? { value: String(r.id ?? r.value), name: r.name } : undefined);
  const lines = (input.lines || []).map((l) => (toolName === 'createInvoice'
    ? { Amount: l.amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: ref(l.itemRef) } }
    : { Amount: l.amount, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: ref(l.accountRef) } }));
  switch (toolName) {
    case 'createInvoice': return { CustomerRef: ref(input.customerRef), TxnDate: input.txnDate, DueDate: input.dueDate, Line: lines };
    case 'createBill': return { VendorRef: ref(input.vendorRef), TxnDate: input.txnDate, DueDate: input.dueDate, Line: lines };
    case 'applyPayment': return { CustomerRef: ref(input.customerRef), TxnDate: input.txnDate, TotalAmt: input.amount,
      Line: [{ Amount: input.amount, LinkedTxn: [{ TxnId: input.invoiceId, TxnType: 'Invoice' }] }] };
    case 'applyBillPayment': return { VendorRef: ref(input.vendorRef), TxnDate: input.txnDate, TotalAmt: input.amount,
      Line: [{ Amount: input.amount, LinkedTxn: [{ TxnId: input.billId, TxnType: 'Bill' }] }] };
    default: return {};
  }
}

// The QuickBooks body a step sends (or would send).
function stepRecord(step) {
  const input = step.toolInput || {};
  if (LEGACY_TOOLS[step.toolName]) return legacyRecord(step.toolName, input);
  return input.record || input.changes || {};
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round2 = (v) => Math.round(v * 100) / 100;
const money = (v) => `$${Number(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Every { type, id } a set of plans refers to, for name lookups. */
function collectRefs(plans) {
  const refs = new Map();
  const add = (type, id) => {
    if (!type || !isId(id) || !LOOKUP_TYPES.includes(type)) return;
    if (!refs.has(type)) refs.set(type, new Set());
    refs.get(type).add(String(id));
  };
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (REF_TYPES[key] && value && typeof value === 'object') add(REF_TYPES[key], value.value);
      else if (key === 'EntityRef' && value && typeof value === 'object') add(value.type || 'Customer', value.value);
      else if (key === 'LinkedTxn' && Array.isArray(value)) value.forEach((l) => add(l?.TxnType, l?.TxnId));
      else walk(value);
    }
  };
  for (const plan of plans) {
    for (const step of plan.steps || []) {
      walk(stepRecord(step));
      const { entityType, id } = step.toolInput || {};
      if (entityType && isId(id)) add(entityType, id);
    }
  }
  return refs;
}

function nameOf(type, record) {
  if (!record) return null;
  if (TXN_TYPES.has(type)) return record.DocNumber || record.PaymentRefNum || null;
  return record.FullyQualifiedName || record.DisplayName || record.Name || null;
}

/**
 * Read-only QuickBooks lookups: Map "Type:Id" -> display name, with
 * names.complete false when any lookup failed or ran out of time. Queries run
 * a few at a time (QuickBooks rate-limits bursts) within a time budget, so a
 * slow company never holds up the page; missing names just show as Ids.
 */
async function loadNames(qbo, refs, { concurrency = 3, budgetMs = 8000 } = {}) {
  const names = new Map();
  names.complete = true;
  // What is still owed on invoices and bills, so a payment can say whether it settled one.
  names.balances = new Map();
  const queue = [...refs].map(([type, ids]) => [type, [...ids].filter(isId).slice(0, 100)]).filter(([, ids]) => ids.length);
  const worker = async () => {
    while (queue.length) {
      const [type, list] = queue.shift();
      try {
        const res = await qbo.query(`SELECT * FROM ${type} WHERE Id IN (${list.map((i) => `'${i}'`).join(', ')}) MAXRESULTS 100`);
        for (const record of res?.QueryResponse?.[type] || []) {
          const name = nameOf(type, record);
          if (name) names.set(`${type}:${record.Id}`, name);
          if (BALANCE_TYPES.has(type) && typeof record.Balance === 'number') names.balances.set(`${type}:${record.Id}`, num(record.Balance));
        }
      } catch {
        names.complete = false;
      }
    }
  };
  let timer;
  const outOfTime = new Promise((resolve) => {
    timer = setTimeout(() => { names.complete = false; queue.length = 0; resolve(); }, budgetMs);
  });
  await Promise.race([Promise.all(Array.from({ length: concurrency }, worker)), outOfTime]);
  clearTimeout(timer);
  return names;
}

function lineTotal(lines) {
  if (!Array.isArray(lines)) return null;
  let sum = 0; let any = false;
  for (const line of lines) {
    if (line?.DetailType === 'SubTotalLineDetail') continue;
    const amount = num(line?.Amount);
    if (amount !== null) { sum += amount; any = true; }
  }
  return any ? round2(sum) : null;
}

const STEP_STATUS = {
  completed: 'done', failed: 'failed', skipped: 'skipped', executing: 'running', rejected: 'rejected',
};

/**
 * The numbered or bulleted items of a case's opening request, as a checklist:
 * [{ number, title, detail }]. "3. Deposits: record 3 payments…" reads as title
 * "Deposits", detail "record 3 payments…". Empty when the request has no list.
 */
function parseAsks(text) {
  const items = [];
  let indent = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const depth = line.length - line.trimStart().length;
    // Only the first list counts, and only its top-level items: lines indented
    // deeper, sub-bullets included, carry on the item above; other text ends the list.
    const item = /^\s{0,3}(?:(\d{1,2})[.)]|[-*•])\s+(\S.*)$/.exec(line);
    if (item && (indent === null || depth === indent)) {
      indent = depth;
      items.push({ written: item[1] ? Number(item[1]) : null, text: item[2].trim() });
    } else if (items.length && depth > indent) {
      const sub = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(\S.*)$/.exec(line);
      const last = items[items.length - 1];
      last.text += sub ? `${/:$/.test(last.text) ? ' ' : '; '}${sub[1].trim()}` : ` ${line.trim()}`;
    } else if (items.length) {
      break;
    }
  }
  // Numbered lists keep their own numbers, which is what the assistant tags against.
  const numbered = items.length > 0 && items.every((it, i, all) => it.written !== null
    && all.findIndex((other) => other.written === it.written) === i);
  return items.slice(0, 30).map(({ written, text: full }, i) => {
    const colon = full.indexOf(':');
    let title = full;
    let detail = '';
    if (colon >= 3 && colon <= 60) {
      title = full.slice(0, colon).trim();
      detail = full.slice(colon + 1).trim().replace(/^[a-z]/, (c) => c.toUpperCase());
    } else if (full.length > 80) {
      title = `${full.slice(0, 81).replace(/\s+\S*$/, '')}…`;
      detail = full;
    }
    return { number: numbered ? written : i + 1, title, detail: detail.length > 200 ? `${detail.slice(0, 201).replace(/\s+\S*$/, '')}…` : detail };
  });
}

/**
 * Describe the changes in a case. `plans` are the case's AIPlan documents in
 * creation order; `names` is the Map from loadNames (may be empty); `request`
 * is the case's opening message, whose listed items become the checklist.
 */
function describeChanges(plans, names = new Map(), { request = '' } = {}) {
  const label = (type, id, fallback) => {
    if (id === undefined || id === null || id === '') return null;
    const ref = PLACEHOLDER.exec(String(id));
    if (ref) return `the ${fallback || 'record'} from change ${ref[1]}`;
    return names.get(`${type}:${id}`) || `${fallback || type} #${id}`;
  };
  const refName = (key, ref, fallback) => {
    if (ref?.value === undefined) return null;
    const type = REF_TYPES[key] || key;
    return names.get(`${type}:${ref.value}`) || ref.name || label(type, ref.value, fallback);
  };

  const live = plans.filter((p) => p.status !== 'rejected');
  const rows = [];

  live.forEach((plan, planIndex) => {
    for (const step of plan.steps || []) {
      const legacy = LEGACY_TOOLS[step.toolName];
      const action = legacy?.action || WRITE_TOOLS[step.toolName];
      if (!action) continue;
      const input = step.toolInput || {};
      const entityType = legacy?.entityType || input.entityType || 'Record';
      const record = stepRecord(step);
      const result = step.result?.data || {};

      let status = STEP_STATUS[step.status];
      // A change to a pre-existing record waiting for (or being decided by) the owner.
      if (step.approval?.state === 'needed' && step.status === 'pending') status = 'approval';
      if (step.approval?.state === 'deciding' && step.status === 'pending') status = 'running';
      if (step.approval?.state === 'declined') status = 'declined';
      if (!status) {
        if (['proposed', 'approved', 'partially_approved'].includes(plan.status)) status = 'waiting';
        else if (plan.status === 'executing') status = 'queued';
        else status = 'pending';
      }

      const facts = [];
      const fact = (text) => { if (text) facts.push(text); };
      let party = null;
      let amount = num(result.totalAmt);
      let amountNote = null;

      party = refName('CustomerRef', record.CustomerRef, 'customer')
        || refName('VendorRef', record.VendorRef, 'vendor')
        || refName('EmployeeRef', record.EmployeeRef, 'employee')
        || (record.EntityRef ? label(record.EntityRef.type || 'Customer', record.EntityRef.value, 'payee') : null)
        || record.DisplayName || record.Name || null;

      switch (entityType) {
        case 'Invoice': case 'SalesReceipt': case 'CreditMemo': case 'Estimate': case 'RefundReceipt': {
          const items = (record.Line || []).filter((l) => l?.SalesItemLineDetail).map((l) => {
            const d = l.SalesItemLineDetail;
            const item = refName('ItemRef', d.ItemRef, 'item');
            const qty = num(d.Qty); const price = num(d.UnitPrice);
            return qty !== null && price !== null ? `${qty} × ${item} at $${price.toFixed(2)}` : item;
          }).filter(Boolean);
          if (items.length) fact(items.slice(0, 2).join(', ') + (items.length > 2 ? ` and ${items.length - 2} more` : ''));
          const taxes = [...new Set((record.Line || []).map((l) => l?.SalesItemLineDetail?.TaxCodeRef?.value).filter(Boolean))];
          if (taxes.length) fact(`Tax ${taxes.map((t) => label('TaxCode', t, 'tax code')).join(', ')}`);
          if (record.SalesTermRef) fact(`Terms ${refName('SalesTermRef', record.SalesTermRef, 'term')}`);
          if (record.ProjectRef) fact('Project invoice');
          if (amount === null) { amount = lineTotal(record.Line); if (amount !== null) amountNote = 'before tax'; }
          break;
        }
        case 'Bill': case 'VendorCredit': case 'Purchase': case 'PurchaseOrder': {
          const accounts = [...new Set((record.Line || []).map((l) => l?.AccountBasedExpenseLineDetail?.AccountRef?.value
            || l?.ItemBasedExpenseLineDetail?.ItemRef?.value).filter(Boolean))];
          const expenseLines = (record.Line || []).filter((l) => l?.AccountBasedExpenseLineDetail);
          if (expenseLines.length) fact(accounts.map((a) => label('Account', a, 'account')).join(', '));
          if (entityType === 'Purchase' && record.AccountRef) fact(`Paid from ${refName('AccountRef', record.AccountRef, 'account')}`);
          if (record.SalesTermRef) fact(`Terms ${refName('SalesTermRef', record.SalesTermRef, 'term')}`);
          if (amount === null) { amount = lineTotal(record.Line); if (amount !== null) amountNote = 'before tax'; }
          break;
        }
        case 'Payment': case 'BillPayment': {
          const applied = (record.Line || []).flatMap((l) => (l?.LinkedTxn || []).map((t) => {
            const word = String(t.TxnType || 'record').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
            const ref = PLACEHOLDER.exec(String(t.TxnId));
            if (ref) return `the ${word} from change ${ref[1]}`;
            const doc = names.get(`${t.TxnType}:${t.TxnId}`);
            // Once the payment is made, say whether that left anything owing (as of now).
            const balance = status === 'done' ? names.balances?.get(`${t.TxnType}:${t.TxnId}`) : undefined;
            const left = balance === undefined ? '' : balance === 0 ? ', now paid in full' : `, ${money(balance)} still owing`;
            return `${doc ? `${word} ${doc}` : `${word} #${t.TxnId}`}${left}`;
          }));
          if (applied.length) fact(`${entityType === 'Payment' ? 'Applied to' : 'Pays'} ${applied.join(', ')}`);
          if (record.DepositToAccountRef) fact(`Into ${refName('DepositToAccountRef', record.DepositToAccountRef, 'account')}`);
          if (record.PayType === 'Check') fact(`Cheque from ${refName('BankAccountRef', record.CheckPayment?.BankAccountRef, 'account') || 'bank'}`);
          if (record.PayType === 'CreditCard') fact(`Paid with ${refName('CCAccountRef', record.CreditCardPayment?.CCAccountRef, 'account') || 'a credit card'}`);
          if (amount === null) amount = num(record.TotalAmt) ?? lineTotal(record.Line);
          break;
        }
        case 'Deposit': {
          const linked = (record.Line || []).filter((l) => l?.LinkedTxn?.length).length;
          if (linked) fact(`Combines ${linked} customer ${linked === 1 ? 'payment' : 'payments'}`);
          party = party || refName('DepositToAccountRef', record.DepositToAccountRef, 'account');
          if (amount === null) amount = lineTotal(record.Line);
          break;
        }
        case 'Transfer': {
          const from = refName('FromAccountRef', record.FromAccountRef, 'account');
          const to = refName('ToAccountRef', record.ToAccountRef, 'account');
          party = from && to ? `${from} → ${to}` : party;
          if (amount === null) amount = num(record.Amount);
          break;
        }
        case 'TimeActivity': {
          const hours = num(record.Hours) || 0; const minutes = num(record.Minutes) || 0;
          fact(`${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''} ${hours === 1 && !minutes ? 'hour' : 'hours'}`);
          if (record.CustomerRef) fact(`For ${refName('CustomerRef', record.CustomerRef, 'customer')}`);
          if (record.ItemRef) fact(refName('ItemRef', record.ItemRef, 'item'));
          fact(record.BillableStatus === 'Billable' ? 'Billable' : 'Not billable');
          party = refName('EmployeeRef', record.EmployeeRef, 'employee') || refName('VendorRef', record.VendorRef, 'vendor');
          break;
        }
        case 'JournalEntry': {
          const debits = (record.Line || []).filter((l) => l?.JournalEntryLineDetail?.PostingType === 'Debit');
          fact(`${(record.Line || []).length} lines`);
          if (amount === null) amount = lineTotal(debits);
          break;
        }
        default:
          break;
      }

      if (action !== 'create' && input.id !== undefined) {
        party = party || label(entityType, input.id, entityType.toLowerCase());
        if (action === 'update' && input.changes) fact(`Changes ${Object.keys(input.changes).join(', ')}`);
      }

      // An existing record the owner is asked about: show it as QuickBooks did when proposed.
      const shown = step.approval?.record;
      if (shown) {
        party = shown.party || party;
        if (amount === null && shown.total !== null && shown.total !== undefined) amount = num(shown.total);
      }
      rows.push({
        key: `${plan._id}:${step.stepNumber}`,
        planId: String(plan._id),
        planIndex,
        stepNumber: step.stepNumber,
        action,
        entityType,
        status,
        recordId: result.id || (action !== 'create' && isId(input.id) ? String(input.id) : null),
        docNumber: result.docNumber || shown?.docNumber || null,
        date: record.TxnDate || result.txnDate || shown?.txnDate || null,
        dueDate: record.DueDate || null,
        party,
        amount,
        amountNote: result.totalAmt !== undefined && result.totalAmt !== null ? null : amountNote,
        facts,
        // Which item of the opening request this change answers (the assistant's tag).
        goal: Number.isInteger(Number(input.goal)) && Number(input.goal) > 0 ? Number(input.goal) : null,
        // Customer payments a deposit combines: the change that made each one, or its QuickBooks Id.
        linked: entityType === 'Deposit'
          ? (record.Line || []).flatMap((l) => l?.LinkedTxn || []).filter((t) => t?.TxnType === 'Payment').map((t) => {
            const ref = PLACEHOLDER.exec(String(t.TxnId));
            return ref ? { key: `${plan._id}:${ref[1]}` } : { id: String(t.TxnId) };
          })
          : null,
        summary: input.summary ? String(input.summary).slice(0, 300) : null,
        approval: step.approval ? { state: step.approval.state, record: step.approval.record || null } : null,
        error: status === 'failed' ? plainError(step.error || step.result?.error) : null,
        // Same record, proposed again? Compared on what was asked for, not the result.
        matchKey: (() => {
          const asked = lineTotal(record.Line) ?? num(record.TotalAmt) ?? num(record.Amount);
          // Too little to tell two records apart: never treat them as the same one.
          if (!party || (asked === null && !record.TxnDate)) return null;
          return [entityType, party, record.TxnDate || '', asked ?? ''].join('|');
        })(),
      });
    }
  });

  // A change that failed or was skipped, then made by a later proposal, is
  // shown once: as the change that worked.
  for (const row of rows) {
    if (!['failed', 'skipped'].includes(row.status)) continue;
    if (!row.matchKey) continue;
    const redo = rows.find((r) => r.planIndex > row.planIndex && r.status === 'done' && r.matchKey === row.matchKey);
    if (redo) row.retriedBy = redo.key;
  }

  const shown = rows.filter((r) => !r.retriedBy);
  const asks = parseAsks(request);
  const visible = shown.map(({ matchKey, linked, ...row }) => {
    // A request with a single ask: everything in the case answers it.
    let goal = row.goal && asks.some((a) => a.number === row.goal) ? row.goal : null;
    if (!goal && asks.length === 1) goal = 1;
    // A deposit lists the payments it combines, so they can sit under it.
    const includes = linked
      ? linked.map((l) => l.key || shown.find((r) => r.entityType === 'Payment' && r.action === 'create' && r.recordId === l.id)?.key)
        .filter((key) => key && shown.some((r) => r.key === key))
      : undefined;
    return { ...row, goal, ...(includes?.length ? { includes } : {}) };
  });
  const counts = {
    done: visible.filter((r) => r.status === 'done').length,
    failed: visible.filter((r) => r.status === 'failed').length,
    waiting: visible.filter((r) => r.status === 'waiting').length,
    running: visible.filter((r) => ['running', 'queued'].includes(r.status)).length,
    notDone: visible.filter((r) => ['skipped', 'pending'].includes(r.status)).length,
    approval: visible.filter((r) => r.status === 'approval').length,
    retried: rows.filter((r) => r.retriedBy && r.status === 'failed').length,
  };
  return {
    asks,
    changes: visible,
    counts,
    proposals: live.length,
    discardedProposals: plans.length - live.length,
  };
}

// QuickBooks errors in words a person can act on; the raw text stays in History.
function plainError(error) {
  const text = String(error || '').trim();
  if (!text) return 'QuickBooks did not accept this change.';
  if (/Required param missing/i.test(text)) return 'QuickBooks rejected it: a required detail was missing.';
  if (/Duplicate Document Number/i.test(text)) return 'QuickBooks rejected it: that document number is already used.';
  if (/Stale Object|SyncToken/i.test(text)) return 'The record changed in QuickBooks before this could be saved.';
  if (/Invalid Reference Id|Object Not Found/i.test(text)) return 'QuickBooks rejected it: it refers to a record that does not exist.';
  return text.replace(/^QBO API error \(HTTP \d+\):\s*/i, 'QuickBooks rejected it: ').slice(0, 240);
}

module.exports = { collectRefs, loadNames, describeChanges, parseAsks, plainError };
