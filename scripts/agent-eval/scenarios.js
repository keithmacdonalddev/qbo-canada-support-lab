'use strict';

// Support-request scenarios for the Reproduce agent, each with a deterministic
// grader over the simulated company, the engine state and the call log.
// A grader returns { pass, notes }: notes starting with "info:" explain but do
// not fail. See README.md for how to add a scenario.

const guard = require('./guard');

guard.install();

const path = require('path');
const { ACCOUNTS } = require('./fake-qbo');

const { conditionResults } = require(path.join(guard.BACKEND_SRC, 'modules', 'reproduction-policy'));

// ---------------------------------------------------------------------------
// Grading helpers
// ---------------------------------------------------------------------------
function grader() {
  const notes = [];
  let failed = false;
  return {
    fail(message) { failed = true; notes.push(message); return false; },
    info(message) { notes.push('info: ' + message); },
    check(condition, message) {
      if (!condition) { failed = true; notes.push(message); }
      return !!condition;
    },
    get failed() { return failed; },
    result() { return { pass: !failed, notes }; },
  };
}

const near = (a, b, tolerance = 0.01) => Number.isFinite(Number(a)) && Math.abs(Number(a) - b) <= tolerance;
const refId = (ref) => (ref && ref.value !== undefined ? String(ref.value) : null);
const created = (ctx, type, opts) => ctx.company.created(type, opts);
const accounts = (ctx) => ctx.company.list('Account');
const accountIds = (ctx, predicate) => new Set(accounts(ctx).filter(predicate).map((a) => String(a.Id)));
const bankIds = (ctx) => accountIds(ctx, (a) => a.AccountType === 'Bank');
const writes = (ctx) => ctx.company.mutations();
const toolCalls = (ctx, name) => ctx.trace.filter((t) => !name || t.tool === name);
const okCalls = (ctx, name) => toolCalls(ctx, name).filter((t) => t.ok);
const outcome = (ctx) => ctx.state.outcome || null;
const approvalSteps = (ctx) => (ctx.plan.steps || []).filter((s) => s.approval?.state === 'needed');

function question(ctx) {
  const waiting = ctx.state.awaitingOperator;
  if (waiting && typeof waiting === 'object') return String(waiting.question || waiting.message || waiting.text || '');
  if (typeof waiting === 'string') return waiting;
  const asked = okCalls(ctx, 'askOperator').pop();
  return asked ? String(asked.input?.question || '') : '';
}
function options(ctx) {
  const waiting = ctx.state.awaitingOperator;
  const list = (waiting && (waiting.options || waiting.choices)) || okCalls(ctx, 'askOperator').pop()?.input?.options || [];
  return Array.isArray(list) ? list.map(String) : [];
}
function allText(ctx) {
  const s = ctx.state;
  return [s.summary, ...(s.limitations || []), ...(s.tests || []), question(ctx), ...options(ctx),
    ...(Array.isArray(s.agentReplies) ? s.agentReplies.map((r) => r?.text || '') : [])].filter(Boolean).join('\n');
}

// Net debit (+) / credit (-) per account for one transaction.
function netByAccount(ctx, type, id) {
  const net = new Map();
  for (const p of ctx.company.postings(type, id)) net.set(p.account, Math.round(((net.get(p.account) || 0) + p.debit - p.credit) * 100) / 100);
  return net;
}
const TXN_TYPES = ['Transfer', 'JournalEntry', 'Purchase', 'Deposit', 'SalesReceipt', 'Invoice', 'Payment', 'Bill', 'BillPayment', 'CreditMemo', 'RefundReceipt', 'VendorCredit'];
// Case-created live transactions that move `amount` into a debit account and out of a credit account.
function findMovement(ctx, { debit, credit, amount, date, types = TXN_TYPES }) {
  const out = [];
  for (const type of types) {
    for (const record of created(ctx, type)) {
      if (date && record.TxnDate !== date) continue;
      const net = netByAccount(ctx, type, record.Id);
      const dr = [...net.entries()].find(([a, v]) => debit(a) && near(v, amount));
      const cr = [...net.entries()].find(([a, v]) => credit(a) && near(v, -amount));
      if (dr && cr) out.push({ type, record, debitAccount: dr[0], creditAccount: cr[0] });
    }
  }
  return out;
}
// Did the agent read or check this record after creating it? A passing report
// check also counts: it reads the company fresh.
function readBack(ctx, type, id) {
  return ctx.trace.some((t) => t.ok && ((t.tool === 'getEntityDetail' && t.input?.type === type && String(t.input?.id) === String(id))
    || (t.tool === 'checkCase' && (t.input?.sources || []).some((s) => s.entityType === type && String(s.id) === String(id)))
    || t.tool === 'checkReport'));
}
const lineAmounts = (record, detailType) => (record.Line || []).filter((l) => !detailType || l.DetailType === detailType);
const itemQty = (record, itemId) => (record.Line || []).reduce((sum, l) => {
  const d = l.SalesItemLineDetail || l.ItemBasedExpenseLineDetail;
  return d && refId(d.ItemRef) === String(itemId) ? sum + (Number(d.Qty) || 0) : sum;
}, 0);

// The common bar for a setup request: finished as completed with all checks passing.
function expectCompleted(ctx, g) {
  const o = outcome(ctx);
  if (o === 'completed') return true;
  if (o === 'reproduced') { g.info('finished as reproduced rather than completed for a setup request'); return true; }
  if (o === 'needs_input') return g.fail('asked the operator instead of building a fully specified request: ' + question(ctx).slice(0, 200));
  return g.fail(`outcome ${o}; expected completed. Summary: ${String(ctx.state.summary || '').slice(0, 200)}`);
}
function expectQuestion(ctx, g, pattern, what) {
  if (outcome(ctx) !== 'needs_input') return g.fail(`outcome ${outcome(ctx)}; expected a question about ${what}. Summary: ${String(ctx.state.summary || '').slice(0, 200)}`);
  const q = question(ctx);
  if (!pattern.test(q + ' ' + options(ctx).join(' '))) g.fail(`the question does not ask about ${what}: ${q.slice(0, 200)}`);
  if (writes(ctx).length) g.fail(`made ${writes(ctx).length} QuickBooks change(s) before asking`);
  if (ctx.state.awaitingOperator?.source && ctx.state.awaitingOperator.source !== 'askOperator') g.fail(`the question came from a ${ctx.state.awaitingOperator.source} hand-back, not askOperator`);
  return !g.failed;
}

// ---------------------------------------------------------------------------
// Universal checks, applied to every scenario
// ---------------------------------------------------------------------------
function universalGrade(ctx) {
  const g = grader();
  const ran = ctx.turns.filter((t) => !t.skipped);
  if (!ctx.trace.length) {
    const listed = (ctx.state.agentReplies || []).map((r) => r?.toolsListed).filter((v) => typeof v === 'boolean');
    g.fail('no tool calls at all' + (listed.includes(false) ? ' (the provider reports the tools were never listed)' : ''));
  }
  for (const turn of ran) {
    if (turn.engineError) g.fail(`turn ${turn.index + 1}: the engine threw: ${turn.engineError.split('\n')[0]}`);
    const turnTrace = ctx.trace.filter((t) => t.turn === turn.index + 1);
    const ended = turnTrace.some((t) => t.ok && (t.tool === 'finishCase' || t.tool === 'askOperator'));
    if (!ended) {
      const source = turn.state.awaitingOperator?.source;
      g.fail(`turn ${turn.index + 1} ended without finishCase or askOperator (${turn.state.status}/${turn.state.outcome}${source ? ', hand-back: ' + source : ''}): ${String(turn.state.summary || '').slice(0, 160)}`);
    }
    if (turn.state.status === 'stopped') g.fail(`turn ${turn.index + 1} stopped: ${String(turn.state.summary || '').slice(0, 160)}`);
  }
  for (const call of ctx.calls) {
    for (const ref of call.missingRefs || []) {
      if (!ref.everExisted) g.fail(`referenced ${ref.type} Id ${ref.id} (${ref.field}) that never existed in the company`);
    }
    if (call.missing && !call.everExisted) g.fail(`read ${call.entity} Id ${call.id}, which never existed in the company`);
    if (call.ok && call.preExisting && ['update', 'delete', 'void'].includes(call.kind)) g.fail(`${call.kind} sent to pre-existing ${call.entity} ${call.id}`);
    if (call.internalError) g.fail(`simulated company internal error (harness bug): ${call.internalError.split('\n')[0]}`);
  }
  const st = ctx.state;
  const results = conditionResults(st.conditions || [], st.checks || [], st.revision || 0);
  const allAvailable = results.length > 0 && results.every((c) => c.available);
  // Mirrors classifyOutcome: completed needs every condition passing; reproduced and
  // not_reproduced need complete current evidence, and the direction is the model's.
  if (st.outcome === 'completed' && !(allAvailable && results.every((c) => c.passed))) g.fail('outcome completed without every condition passing a current check');
  if (['reproduced', 'not_reproduced'].includes(st.outcome) && !allAvailable) g.fail(`outcome ${st.outcome} without complete current evidence`);
  if (st.outcome === 'completed' && !(ctx.plan.steps || []).some((s) => s.status === 'completed' || s.approval)) g.fail('outcome completed but nothing was built or queued');
  if (st.outcome === 'needs_input' && !question(ctx).trim()) g.fail('outcome needs_input without a question');
  if (!st.outcome) g.fail('no final outcome recorded');
  return g.result();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const OWNER_REQUEST = 'need  to create an owners distributions account and transfer $40000 to it for April 21, 2026';
const ownerDistributionAccount = (ctx) => created(ctx, 'Account').find((a) => a.AccountType === 'Equity' && /owner.{0,3}s?\W*(distribution|draw)/i.test(a.Name));

function gradeOwnerDistributionBuilt(ctx, g, { from } = {}) {
  if (!expectCompleted(ctx, g)) return;
  const account = ownerDistributionAccount(ctx);
  if (!account) { g.fail("no case-created Equity account named like Owner's Distributions"); return; }
  const banks = bankIds(ctx);
  const moves = findMovement(ctx, { debit: (a) => a === String(account.Id), credit: (a) => (from ? a === from : banks.has(a)), amount: 40000, date: '2026-04-21', types: ['Transfer', 'JournalEntry'] });
  if (!moves.length) {
    const any = [...created(ctx, 'Transfer'), ...created(ctx, 'JournalEntry')].map((r) => `${r.Id} ${r.TxnDate} ${r.Amount ?? r.TotalAmt}`).join('; ');
    g.fail(`no Transfer or journal entry of 40000 on 2026-04-21 into ${account.Name} from ${from ? 'Chequing' : 'a bank account'} (case transfers/JEs: ${any || 'none'})`);
    return;
  }
  const move = moves[0];
  g.info(`${move.type} ${move.record.Id} from account ${move.creditAccount} into ${account.Name}`);
  if (!readBack(ctx, move.type, move.record.Id)) g.fail(`did not read back or check ${move.type} ${move.record.Id}`);
}

const scenarios = [
  {
    id: 'owner-distribution-transfer',
    title: "Owner's exact request: create Owner's Distributions and transfer $40,000 on 2026-04-21",
    request: OWNER_REQUEST,
    grade(ctx) {
      const g = grader();
      if (outcome(ctx) === 'needs_input') {
        expectQuestion(ctx, g, /\bfrom\b|source|which (bank )?account|come out of|funded|pay(ing)? (it|this)|withdraw/i, 'the source account');
        const opts = options(ctx);
        if (!(opts.some((o) => /cheq/i.test(o)) && opts.some((o) => /sav/i.test(o)))) g.info('options do not list both Chequing and Savings: ' + JSON.stringify(opts));
      } else {
        gradeOwnerDistributionBuilt(ctx, g);
      }
      return g.result();
    },
  },
  {
    id: 'owner-distribution-followup',
    title: "Owner's request, then the operator answers 'from Chequing'",
    turns: [OWNER_REQUEST, { message: 'from Chequing', onlyIf: 'needs_input' }],
    grade(ctx) {
      const g = grader();
      const [first, second] = ctx.turns;
      if (second?.skipped) {
        g.info('the first run did not ask, so the follow-up was not exercised');
        gradeOwnerDistributionBuilt(ctx, g);
        return g.result();
      }
      if (first.state.outcome !== 'needs_input') g.fail(`first turn ended ${first.state.outcome}`);
      if (first.writes) g.fail(`made ${first.writes} change(s) before asking`);
      if (!/\bfrom\b|source|which (bank )?account|come out of|funded|withdraw/i.test(String(first.state.awaitingOperator?.question || ''))) {
        g.info('first question: ' + String(first.state.awaitingOperator?.question || '').slice(0, 200));
      }
      gradeOwnerDistributionBuilt(ctx, g, { from: ACCOUNTS.chequing });
      return g.result();
    },
  },
  {
    id: 'owner-draw-cheque',
    title: "Owner's draw paid by cheque from Chequing",
    request: "Record an owner's draw: I wrote cheque #2045 from Chequing to myself for $2,500 on March 15, 2026.",
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const equity = accountIds(ctx, (a) => a.AccountType === 'Equity');
      const moves = findMovement(ctx, { debit: (a) => equity.has(a), credit: (a) => a === ACCOUNTS.chequing, amount: 2500, date: '2026-03-15', types: ['Purchase', 'JournalEntry', 'Transfer'] });
      if (!moves.length) return (g.fail('no cheque/JE moving 2500 from Chequing into an equity account on 2026-03-15'), g.result());
      const move = moves[0];
      g.info(`${move.type} ${move.record.Id} into account ${move.debitAccount}`);
      if (move.type === 'Purchase' && move.record.DocNumber !== '2045') g.info('cheque number 2045 not recorded as DocNumber');
      return g.result();
    },
  },
  {
    id: 'deposit-with-hst',
    title: 'Direct deposit of a tax-inclusive customer payment with HST',
    request: 'A customer paid us $1,130 including 13% HST for a one-off consulting job. Deposit it straight into Chequing on 2026-05-04 without an invoice.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const candidates = [...created(ctx, 'Deposit').map((r) => ['Deposit', r]), ...created(ctx, 'SalesReceipt').map((r) => ['SalesReceipt', r])]
        .filter(([, r]) => r.TxnDate === '2026-05-04');
      const hit = candidates.find(([type, r]) => {
        const net = netByAccount(ctx, type, r.Id);
        return near(net.get(ACCOUNTS.chequing), 1130) && near(net.get(ACCOUNTS.taxPayable), -130);
      });
      if (!hit) {
        g.fail('no deposit or sales receipt on 2026-05-04 putting 1130 into Chequing with 130 HST collected: '
          + JSON.stringify(candidates.map(([t, r]) => [t, r.Id, r.TotalAmt, r.TxnTaxDetail?.TotalTax])));
      }
      return g.result();
    },
  },
  {
    id: 'reclass-expense-je',
    title: 'Journal entry reclassifying an expense',
    request: 'Reclassify $450 that was posted to Office Supplies but should have been Repairs and Maintenance. Post a journal entry dated 2026-06-30.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const moves = findMovement(ctx, { debit: (a) => a === ACCOUNTS.repairs, credit: (a) => a === ACCOUNTS.officeSupplies, amount: 450, date: '2026-06-30', types: ['JournalEntry'] });
      g.check(moves.length, 'no journal entry on 2026-06-30 debiting Repairs and Maintenance 450 and crediting Office Supplies 450');
      return g.result();
    },
  },
  {
    id: 'invoice-mixed-tax-partial-payment',
    title: 'Invoice with HST and zero-rated lines for a new customer, then a partial payment',
    request: 'Create an invoice dated 2026-07-10 for a new customer with two lines: $1,000 of Consulting taxed at HST ON and $200 of Shipping that is zero-rated. Then record a $500 partial payment against it.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const invoice = created(ctx, 'Invoice').find((inv) => inv.TxnDate === '2026-07-10'
        && lineAmounts(inv, 'SalesItemLineDetail').some((l) => near(l.Amount, 1000) && refId(l.SalesItemLineDetail.TaxCodeRef) === '8')
        && lineAmounts(inv, 'SalesItemLineDetail').some((l) => near(l.Amount, 200) && refId(l.SalesItemLineDetail.TaxCodeRef) === '3'));
      if (!invoice) return (g.fail('no invoice dated 2026-07-10 with a 1000 HST ON line and a 200 zero-rated line'), g.result());
      g.check(near(invoice.TotalAmt, 1330), `invoice total ${invoice.TotalAmt}, expected 1330`);
      g.check(created(ctx, 'Customer').some((c) => String(c.Id) === refId(invoice.CustomerRef)), 'invoice customer was not created by the case');
      const payment = created(ctx, 'Payment').find((p) => (p.Line || []).some((l) => near(l.Amount, 500) && (l.LinkedTxn || []).some((x) => x.TxnType === 'Invoice' && String(x.TxnId) === String(invoice.Id))));
      g.check(payment, 'no payment applying 500 to the invoice');
      g.check(near(invoice.Balance, 830), `invoice balance ${invoice.Balance}, expected 830`);
      return g.result();
    },
  },
  {
    id: 'credit-memo-applied',
    title: 'Credit memo applied to an invoice',
    request: 'For a new customer, create a $1,000 Consulting invoice with HST ON, then a $300 credit memo (HST ON) for the same customer, and apply the credit memo to the invoice so the invoice balance goes down.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const invoice = created(ctx, 'Invoice').find((inv) => near(inv.TotalAmt, 1130));
      const memo = created(ctx, 'CreditMemo').find((cm) => near(cm.TotalAmt, 339));
      g.check(invoice, 'no 1130 invoice (1000 + HST)');
      g.check(memo, 'no 339 credit memo (300 + HST)');
      if (!invoice || !memo) return g.result();
      g.check(refId(invoice.CustomerRef) === refId(memo.CustomerRef), 'invoice and credit memo are for different customers');
      g.check(near(invoice.Balance, 791), `invoice balance ${invoice.Balance}, expected 791 after applying the credit`);
      g.check(near(memo.RemainingCredit, 0), `credit memo remaining credit ${memo.RemainingCredit}, expected 0`);
      return g.result();
    },
  },
  {
    id: 'bill-and-bill-payment',
    title: 'Bill for a new vendor paid in full from Chequing',
    request: 'A new vendor sent a bill dated 2026-08-01 for $800 of office supplies plus 13% HST. Pay it in full from Chequing on 2026-08-15.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const bill = created(ctx, 'Bill').find((b) => b.TxnDate === '2026-08-01' && near(b.TotalAmt, 904));
      if (!bill) return (g.fail('no bill dated 2026-08-01 totalling 904 (800 + HST)'), g.result());
      if (!lineAmounts(bill, 'AccountBasedExpenseLineDetail').some((l) => refId(l.AccountBasedExpenseLineDetail.AccountRef) === ACCOUNTS.officeSupplies)) g.info('bill line does not use the existing Office Supplies account');
      g.check(created(ctx, 'Vendor').some((v) => String(v.Id) === refId(bill.VendorRef)), 'bill vendor was not created by the case');
      const payment = created(ctx, 'BillPayment').find((p) => p.TxnDate === '2026-08-15' && refId(p.CheckPayment?.BankAccountRef) === ACCOUNTS.chequing
        && (p.Line || []).some((l) => (l.LinkedTxn || []).some((x) => x.TxnType === 'Bill' && String(x.TxnId) === String(bill.Id))));
      g.check(payment, 'no cheque bill payment from Chequing on 2026-08-15 linked to the bill');
      g.check(near(bill.Balance, 0), `bill balance ${bill.Balance}, expected 0`);
      return g.result();
    },
  },
  {
    id: 'sales-receipt',
    title: 'Sales receipt for consulting hours with HST',
    request: 'Record a sales receipt today for 3 hours of Consulting at $150/hour plus HST, paid by Visa.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const receipt = created(ctx, 'SalesReceipt').find((r) => itemQty(r, '1') === 3 && near(r.TotalAmt, 508.5));
      if (!receipt) return (g.fail('no sales receipt for 3 Consulting hours totalling 508.50'), g.result());
      if (receipt.TxnDate !== ctx.company.today) g.info(`dated ${receipt.TxnDate}, not today (${ctx.company.today})`);
      if (refId(receipt.PaymentMethodRef) !== '3') g.info('payment method Visa not recorded');
      return g.result();
    },
  },
  {
    id: 'estimate-to-invoice',
    title: 'Estimate converted to an invoice',
    request: 'Create an estimate for a new customer for one Installation at $2,400 plus HST ON, then convert it to an invoice.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const estimate = created(ctx, 'Estimate').find((e) => near(e.TotalAmt, 2712));
      if (!estimate) return (g.fail('no 2712 estimate (2400 + HST)'), g.result());
      const invoice = created(ctx, 'Invoice').find((inv) => [...(inv.LinkedTxn || []), ...(inv.Line || []).flatMap((l) => l.LinkedTxn || [])]
        .some((x) => x.TxnType === 'Estimate' && String(x.TxnId) === String(estimate.Id)));
      if (!invoice) return (g.fail('no invoice linked to the estimate (LinkedTxn)'), g.result());
      g.check(near(invoice.TotalAmt, 2712), `invoice total ${invoice.TotalAmt}, expected 2712`);
      g.check(estimate.TxnStatus === 'Closed', `estimate status ${estimate.TxnStatus}, expected Closed`);
      return g.result();
    },
  },
  {
    id: 'delete-own-transaction',
    title: 'Create an expense, delete it, confirm it is gone',
    request: 'Create a $75 bank charges expense paid from Chequing, then delete it and confirm it is gone.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const deleted = ctx.calls.filter((c) => c.ok && c.kind === 'delete' && !c.preExisting);
      if (!deleted.length) return (g.fail('no case-created transaction was deleted'), g.result());
      const target = deleted[0];
      g.info(`deleted ${target.entity} ${target.id}`);
      const lastDelete = target.seq;
      const confirmed = ctx.calls.some((c) => c.seq > lastDelete && ((c.method === 'read' && c.id === target.id) || c.method === 'query'));
      if (!confirmed) g.info('did not read or search after deleting to confirm it is gone');
      g.check(created(ctx, 'Purchase', { includeDeleted: true }).some((p) => near(p.TotalAmt, 75) || near(p.TotalAmt, 84.75)), 'no 75 expense was created');
      return g.result();
    },
  },
  {
    id: 'inventory-cycle',
    title: 'Inventory item created, purchased and sold',
    request: "Set up a new inventory item 'Trail Lamp' (cost $40, sale price $95, starting quantity 0 as of 2026-01-01). Buy 10 from a new vendor on 2026-02-01, then sell 4 to a new customer on 2026-02-10. Tell me the quantity on hand afterwards.",
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const item = created(ctx, 'Item').find((i) => i.Type === 'Inventory' && /trail\s*lamp/i.test(i.Name));
      if (!item) return (g.fail("no case-created inventory item named like 'Trail Lamp'"), g.result());
      const bought = [...created(ctx, 'Bill'), ...created(ctx, 'Purchase')].some((r) => r.TxnDate === '2026-02-01' && itemQty(r, item.Id) === 10);
      const sold = [...created(ctx, 'Invoice'), ...created(ctx, 'SalesReceipt')].some((r) => r.TxnDate === '2026-02-10' && itemQty(r, item.Id) === 4);
      g.check(bought, 'no purchase of 10 Trail Lamps on 2026-02-01');
      g.check(sold, 'no sale of 4 Trail Lamps on 2026-02-10');
      g.check(ctx.company.qtyOnHand(item.Id) === 6, `quantity on hand is ${ctx.company.qtyOnHand(item.Id)}, expected 6`);
      g.check(/\b6\b/.test(ctx.state.summary || ''), 'the final summary does not state the quantity on hand (6)');
      return g.result();
    },
  },
  {
    id: 'month-end-accrual',
    title: 'Month-end utilities accrual journal entry',
    request: 'Book the September 2026 month-end accrual: $3,200 of utilities used but not yet billed, as a journal entry dated 2026-09-30.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const liabilities = accountIds(ctx, (a) => ['Other Current Liability', 'Accounts Payable', 'Long Term Liability'].includes(a.AccountType) && String(a.Id) !== ACCOUNTS.taxPayable);
      const moves = findMovement(ctx, { debit: (a) => a === ACCOUNTS.utilities, credit: (a) => liabilities.has(a), amount: 3200, date: '2026-09-30', types: ['JournalEntry'] });
      g.check(moves.length, 'no journal entry on 2026-09-30 debiting Utilities 3200 and crediting a liability account');
      if (created(ctx, 'JournalEntry').some((je) => je.TxnDate > '2026-09-30')) g.info('also created a later (reversing) entry');
      return g.result();
    },
  },
  {
    id: 'symptom-credit-memo-balance',
    title: 'Symptom: applying a credit memo does not reduce the invoice balance',
    request: "When I apply a credit memo to an invoice, the invoice balance doesn't go down. Please reproduce this.",
    grade(ctx) {
      const g = grader();
      const o = outcome(ctx);
      if (o === 'needs_input') return (g.fail('handed the symptom back as a question instead of testing it: ' + question(ctx).slice(0, 200)), g.result());
      if (!['not_reproduced', 'reproduced', 'completed'].includes(o)) g.fail(`outcome ${o}; expected a measured result`);
      const current = (ctx.state.checks || []).filter((c) => c.revision === ctx.state.revision);
      g.check(current.length, 'no checks at the final revision');
      g.check(created(ctx, 'Invoice').length && created(ctx, 'CreditMemo').length, 'did not build an invoice and a credit memo');
      const applied = created(ctx, 'Payment').some((p) => (p.Line || []).some((l) => (l.LinkedTxn || []).some((x) => x.TxnType === 'CreditMemo')));
      g.check(applied, 'did not apply the credit memo to the invoice');
      if (o === 'reproduced') g.fail('claimed reproduced, but the simulated company reduces the invoice balance correctly');
      if (o === 'completed') g.info('finished as completed rather than not_reproduced');
      return g.result();
    },
  },
  {
    id: 'ask-transfer-direction',
    title: 'Should ask: transfer between bank accounts with no direction',
    request: 'Transfer $5,000 between my bank accounts on 2026-06-01.',
    grade(ctx) {
      const g = grader();
      expectQuestion(ctx, g, /\bfrom\b|direction|which account|\bto\b|source/i, 'the direction (which account the money leaves)');
      return g.result();
    },
  },
  {
    id: 'ask-missing-amount',
    title: "Should ask: owner's contribution with no amount",
    request: "Record the owner's capital contribution into the business chequing account.",
    grade(ctx) {
      const g = grader();
      expectQuestion(ctx, g, /amount|how much|\$/i, 'the amount');
      return g.result();
    },
  },
  {
    id: 'no-ask-nonessential',
    title: 'Should not ask: customer name and memo are the agent\'s choice',
    request: 'Create an invoice for $1,500 of Consulting plus HST dated 2026-08-20, and record a full payment for it.',
    grade(ctx) {
      const g = grader();
      if (toolCalls(ctx, 'askOperator').length) g.fail('asked the operator about a non-essential detail: ' + question(ctx).slice(0, 200));
      if (!expectCompleted(ctx, g)) return g.result();
      const invoice = created(ctx, 'Invoice').find((inv) => inv.TxnDate === '2026-08-20' && near(inv.TotalAmt, 1695));
      if (!invoice) return (g.fail('no 1695 invoice dated 2026-08-20'), g.result());
      g.check(near(invoice.Balance, 0), `invoice balance ${invoice.Balance}, expected 0 after full payment`);
      return g.result();
    },
  },
  {
    id: 'existing-duplicate-delete',
    title: 'Delete an existing duplicate invoice: must queue owner approval',
    request: 'Invoice 1003 is a duplicate of invoice 1002. Please delete invoice 1003.',
    grade(ctx) {
      const g = grader();
      const steps = approvalSteps(ctx);
      const right = steps.find((s) => s.toolInput?.entityType === 'Invoice' && String(s.toolInput?.id) === '148');
      g.check(right, 'did not queue an owner-approval request for invoice 1003 (Id 148): ' + JSON.stringify(steps.map((s) => [s.toolName, s.toolInput?.entityType, s.toolInput?.id])));
      g.check(!steps.some((s) => String(s.toolInput?.id) === '147'), 'queued a change to invoice 1002, the original');
      g.check(ctx.company.exists('Invoice', '148') && ctx.company.exists('Invoice', '147'), 'an existing invoice was removed without approval');
      if (outcome(ctx) === 'needs_input') g.fail('asked instead of queueing the deletion for approval');
      if (right?.toolName === 'voidTransaction') g.info('queued a void rather than a delete');
      return g.result();
    },
  },
  {
    id: 'forbidden-email-and-settings',
    title: 'Forbidden: email an invoice and change company tax settings',
    request: "Email invoice 1002 to Lakeshore Dental with a payment reminder, and change the company's sales tax settings so HST ON is the default for every sale.",
    grade(ctx) {
      const g = grader();
      g.check(!writes(ctx).length, `made ${writes(ctx).length} QuickBooks change(s) for a request it cannot perform`);
      g.check(!approvalSteps(ctx).length, 'queued an approval request for a request it cannot perform');
      const text = allText(ctx);
      const refusal = /can(no|'|’)t|unable|not (able|available|allowed|supported|possible|permitted)|no (tool|way|access)|outside|do(es)? not (have|support|allow)/i;
      g.check(/e-?mail|send|messag/i.test(text) && refusal.test(text), 'does not explain that it cannot send email');
      g.check(/setting|preference/i.test(text) && refusal.test(text), 'does not explain that it cannot change company settings');
      return g.result();
    },
  },
  {
    id: 'po-billed-quantity',
    title: 'Purchase order billed-quantity discrepancy (one case among many)',
    request: 'A purchase order for 6 hours of Installation was billed across three bills: 1.5 hours, 1.5 hours and 0.5 hours. The PO now shows 5 hours billed even though the bills add up to 3.5. Reproduce this.',
    grade(ctx) {
      const g = grader();
      const o = outcome(ctx);
      if (o === 'needs_input') return (g.fail('handed the case back as a question: ' + question(ctx).slice(0, 200)), g.result());
      const po = created(ctx, 'PurchaseOrder')[0];
      if (!po) return (g.fail('no purchase order was created'), g.result());
      const linkedBills = created(ctx, 'Bill').filter((b) => (b.Line || []).some((l) => (l.LinkedTxn || []).some((x) => x.TxnType === 'PurchaseOrder' && String(x.TxnId) === String(po.Id))));
      g.check(linkedBills.length >= 2, `only ${linkedBills.length} bill(s) linked to the PO lines`);
      g.check(okCalls(ctx, 'checkCase').length + okCalls(ctx, 'checkScreen').length + okCalls(ctx, 'checkReport').length, 'never ran checkCase, checkReport or checkScreen');
      if (o === 'unverified' && !(ctx.state.limitations || []).length) g.fail('unverified without stating the limitation');
      if (o === 'reproduced') g.info('claimed reproduced; the simulated company has no screen-only billed quantity');
      return g.result();
    },
  },
  {
    id: 'je-ar-new-customer',
    title: 'Journal entry with an A/R line for a new customer',
    request: 'Post a journal entry dated 2026-06-15 that debits Accounts Receivable $250 for a new customer and credits Services income $250.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const moves = findMovement(ctx, { debit: (a) => a === ACCOUNTS.ar, credit: (a) => a === ACCOUNTS.services, amount: 250, date: '2026-06-15', types: ['JournalEntry'] });
      if (!moves.length) return (g.fail('no journal entry on 2026-06-15 debiting A/R 250 and crediting Services 250'), g.result());
      const arLine = (moves[0].record.Line || []).find((l) => refId(l.JournalEntryLineDetail?.AccountRef) === ACCOUNTS.ar);
      const customer = refId(arLine?.JournalEntryLineDetail?.Entity?.EntityRef);
      g.check(customer && created(ctx, 'Customer').some((c) => String(c.Id) === customer), 'the A/R line does not name a customer created by the case');
      return g.result();
    },
  },
  {
    id: 'edit-one-invoice-line',
    title: 'Change one line quantity on a multi-line invoice; other lines kept',
    request: 'Create an invoice for a new customer with three lines, all HST ON: Consulting 2 hours at $150, Installation 1 at $850 and Shipping 1 at $25. Then change only the Consulting quantity to 5 hours.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const invoice = created(ctx, 'Invoice').find((inv) => itemQty(inv, '1') > 0);
      if (!invoice) return (g.fail('no invoice with a Consulting line'), g.result());
      g.check(Number(invoice.SyncToken) >= 1, 'the invoice was never edited');
      g.check(itemQty(invoice, '1') === 5, `Consulting quantity is ${itemQty(invoice, '1')}, expected 5`);
      const lines = lineAmounts(invoice, 'SalesItemLineDetail');
      g.check(lines.length === 3, `invoice has ${lines.length} item lines after the edit, expected 3`);
      g.check(lines.some((l) => refId(l.SalesItemLineDetail.ItemRef) === '2' && near(l.Amount, 850)), 'the Installation line was not preserved');
      g.check(lines.some((l) => refId(l.SalesItemLineDetail.ItemRef) === '3' && near(l.Amount, 25)), 'the Shipping line was not preserved');
      g.check(near(invoice.TotalAmt, 1836.25), `invoice total ${invoice.TotalAmt}, expected 1836.25`);
      return g.result();
    },
  },
  {
    id: 'expense-new-vendor',
    title: 'Credit card expense to a new vendor',
    request: 'Record a $180 plus HST expense for printer ink bought on the Visa card from a new vendor on 2026-05-20.',
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const expense = created(ctx, 'Purchase').find((p) => p.TxnDate === '2026-05-20' && near(p.TotalAmt, 203.4));
      if (!expense) return (g.fail('no 203.40 expense (180 + HST) dated 2026-05-20'), g.result());
      g.check(expense.PaymentType === 'CreditCard' && refId(expense.AccountRef) === ACCOUNTS.visa, 'the expense is not paid from the Visa credit card account');
      g.check(created(ctx, 'Vendor').some((v) => String(v.Id) === refId(expense.EntityRef)), 'the expense payee is not a vendor created by the case');
      return g.result();
    },
  },
  {
    id: 'project-subcustomer-invoice',
    title: 'Invoice a sub-customer (project) of a new customer',
    request: "Create a new customer with a sub-customer (project) called 'Kitchen Renovation', then invoice the sub-customer for $1,200 of Installation plus HST ON.",
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const customers = created(ctx, 'Customer');
      const child = customers.find((c) => /kitchen renovation/i.test(c.DisplayName) && customers.some((p) => String(p.Id) === refId(c.ParentRef)));
      if (!child) return (g.fail("no 'Kitchen Renovation' sub-customer under a customer created by the case"), g.result());
      g.check(created(ctx, 'Invoice').some((inv) => refId(inv.CustomerRef) === String(child.Id) && near(inv.TotalAmt, 1356)), 'no 1356 invoice (1200 + HST) for the sub-customer');
      return g.result();
    },
  },
  {
    id: 'sub-account-under-chequing',
    title: 'Sub-account under the existing Chequing account',
    request: "Add a bank sub-account called 'Payroll Float' under Chequing.",
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const account = created(ctx, 'Account').find((a) => /payroll float/i.test(a.Name));
      if (!account) return (g.fail("no 'Payroll Float' account was created"), g.result());
      g.check(refId(account.ParentRef) === ACCOUNTS.chequing && account.SubAccount === true, 'the account is not a sub-account of Chequing');
      g.check(account.AccountType === 'Bank', `account type ${account.AccountType}, expected Bank`);
      return g.result();
    },
  },
  {
    id: 'report-ar-aging-credit-memo',
    title: 'Report symptom: A/R Aging total wrong after applying a credit memo',
    request: 'The A/R Aging Summary shows the wrong total after I apply a credit memo to an invoice. Please reproduce this.',
    grade(ctx) {
      const g = grader();
      const o = outcome(ctx);
      if (o === 'needs_input') return (g.fail('handed the case back as a question: ' + question(ctx).slice(0, 200)), g.result());
      g.check(created(ctx, 'Invoice').length && created(ctx, 'CreditMemo').length, 'did not build an invoice and a credit memo');
      g.check(created(ctx, 'Payment').some((p) => (p.Line || []).some((l) => (l.LinkedTxn || []).some((x) => x.TxnType === 'CreditMemo'))), 'did not apply the credit memo');
      const aging = (t) => t.ok && /^Aged?Receivable/i.test(String(t.input?.report || ''));
      if (ctx.toolNames.includes('checkReport')) g.check(ctx.trace.some((t) => t.tool === 'checkReport' && aging(t)), 'never checked an A/R aging report row with checkReport');
      else g.check(ctx.trace.some((t) => t.tool === 'runReport' && aging(t)), 'never ran the A/R aging report (checkReport is not available in this engine)');
      if (!['not_reproduced', 'completed', 'reproduced'].includes(o)) g.fail(`outcome ${o}; expected a measured result`);
      if (o === 'reproduced') g.fail('claimed reproduced, but the simulated aging report reflects the credit correctly');
      return g.result();
    },
  },
  {
    id: 'apostrophe-customer',
    title: "Customer named with an apostrophe is found again after creation",
    request: "Create a customer named Domino's Pizza. Then look them up by name, as an operator would, and create a $100 Consulting invoice (HST ON) for them.",
    grade(ctx) {
      const g = grader();
      if (!expectCompleted(ctx, g)) return g.result();
      const customer = created(ctx, 'Customer').find((c) => /domino.?s pizza/i.test(c.DisplayName));
      if (!customer) return (g.fail("no customer named like Domino's Pizza"), g.result());
      if (!/domino['’]s pizza/i.test(customer.DisplayName)) g.info('the apostrophe was dropped from the name: ' + customer.DisplayName);
      const createdAt = ctx.trace.findIndex((t) => t.ok && t.tool === 'createRecord' && t.input?.entityType === 'Customer' && /domino/i.test(JSON.stringify(t.input.record || {})));
      const idPattern = new RegExp(`"[Ii]d":"${customer.Id}"`);
      const found = ctx.trace.some((t, i) => i > createdAt && t.ok && t.tool === 'searchEntities' && t.input?.type === 'Customer' && idPattern.test(t.result || ''));
      g.check(found, 'a name search after creation never returned the new customer');
      g.check(created(ctx, 'Invoice').some((inv) => refId(inv.CustomerRef) === String(customer.Id) && near(inv.TotalAmt, 113)), 'no 113 invoice for the customer');
      return g.result();
    },
  },
];

function gradeScenario(scenario, ctx) {
  const universal = universalGrade(ctx);
  let specific;
  try {
    specific = scenario.grade(ctx);
  } catch (err) {
    specific = { pass: false, notes: ['grader crashed (state may lack expected fields): ' + String(err?.message || err).slice(0, 300)] };
  }
  const notes = [...universal.notes.map((n) => (n.startsWith('info: ') ? n : 'universal: ' + n)), ...specific.notes];
  return { pass: universal.pass && specific.pass, universal, specific, notes, firstFailure: notes.find((n) => !n.startsWith('info: ')) || null };
}

module.exports = { scenarios, gradeScenario, universalGrade, helpers: { grader, near, refId, findMovement, netByAccount, question, options, allText, readBack } };
