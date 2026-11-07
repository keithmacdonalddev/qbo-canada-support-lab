'use strict';
// Daily books check and open-day cursor (owner decision 2026-11-06: monthly close
// replaces the daily verified close). Once per business day, after midnight in Halifax:
// - the open day moves forward: the calendar cursor becomes yesterday, so no activity
//   waits on a close;
// - one Trial Balance read is compared with the synced local copy of open invoices,
//   credits and bills. The result is recorded. It never blocks anything.
const { shift } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
const { runWithCaller } = require('./qbo-request-meter');

const money = value => { if (value === '' || value === undefined || value === null) return 0; const n = Number(String(value).replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const sum = (rows, pick) => rows.reduce((total, row) => total + (Number.isFinite(pick(row)) ? pick(row) : 0), 0);

// Debit/credit totals and per-account balances from a QuickBooks TrialBalance report.
function readTrialBalance(report) {
  const columns = report?.Columns?.Column || [], titles = columns.map(column => String(column.ColTitle || '').toLowerCase());
  const debit = titles.findIndex(title => title.includes('debit')), credit = titles.findIndex(title => title.includes('credit'));
  if (debit < 0 || credit < 0) return null;
  const accounts = new Map(); let total = null;
  const walk = rows => { for (const row of rows || []) {
    if (row.Rows?.Row) walk(row.Rows.Row);
    if (row.ColData && row.ColData[0]?.id) accounts.set(String(row.ColData[0].id), (money(row.ColData[debit]?.value) || 0) - (money(row.ColData[credit]?.value) || 0));
    if (row.group === 'GrandTotal' && row.Summary?.ColData) total = { debit: money(row.Summary.ColData[debit]?.value), credit: money(row.Summary.ColData[credit]?.value) };
  } };
  walk(report?.Rows?.Row);
  return { accounts, total };
}

// Open items from the synced local copy, in home currency, by currency, with the records that
// most often explain a difference (unapplied payments, open credits, journal lines on control accounts).
async function localOpenItems(Records, scope, accounts = { receivables: [], payables: [] }) {
  const base = { environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, deleted: false };
  const open = await Records.find({ ...base, entity: { $in: ['Invoice', 'CreditMemo', 'Bill', 'VendorCredit'] }, 'summary.balanceCents': { $ne: 0 } }).select('entity qboId summary.balanceCents summary.homeBalanceCents summary.currency summary.txnDate').limit(20000).maxTimeMS(5000).lean();
  const unapplied = await Records.find({ ...base, entity: 'Payment', 'record.UnappliedAmt': { $gt: 0 } }).select('qboId record.UnappliedAmt record.ExchangeRate record.TxnDate record.CurrencyRef').limit(20000).maxTimeMS(5000).lean();
  const ids = [...accounts.receivables, ...accounts.payables];
  const journals = ids.length ? await Records.find({ ...base, entity: 'JournalEntry', 'record.Line.JournalEntryLineDetail.AccountRef.value': { $in: ids } }).select('qboId record.Line record.ExchangeRate record.TxnDate').limit(5000).maxTimeMS(5000).lean() : [];
  const home = row => row.summary?.homeBalanceCents ?? row.summary?.balanceCents ?? 0;
  const of = entity => sum(open.filter(row => row.entity === entity), home);
  const paid = row => Math.round(row.record.UnappliedAmt * (Number(row.record.ExchangeRate) || 1) * 100);
  const lines = journals.flatMap(row => (row.record.Line || []).filter(line => ids.includes(String(line.JournalEntryLineDetail?.AccountRef?.value))).map(line => ({ id: row.qboId, date: row.record.TxnDate, account: String(line.JournalEntryLineDetail.AccountRef.value), cents: Math.round(line.Amount * (Number(row.record.ExchangeRate) || 1) * 100) * (line.JournalEntryLineDetail.PostingType === 'Debit' ? 1 : -1) })));
  const journalTo = list => sum(lines.filter(line => list.includes(line.account)), line => line.cents);
  const byCurrency = {};
  for (const row of open) { const c = row.summary?.currency || 'CAD', sign = ['Invoice', 'Bill'].includes(row.entity) ? 1 : -1, key = ['Invoice', 'CreditMemo'].includes(row.entity) ? 'receivables' : 'payables'; byCurrency[key + ':' + c] = (byCurrency[key + ':' + c] || 0) + sign * home(row); }
  for (const row of unapplied) { const c = row.record.CurrencyRef?.value || 'CAD'; byCurrency['receivables:' + c] = (byCurrency['receivables:' + c] || 0) - paid(row); }
  const candidates = [
    ...unapplied.map(row => ({ entity: 'Payment', id: row.qboId, date: row.record.TxnDate, cents: -paid(row), why: 'unapplied payment' })),
    ...open.filter(row => ['CreditMemo', 'VendorCredit'].includes(row.entity)).map(row => ({ entity: row.entity, id: row.qboId, date: row.summary?.txnDate || null, cents: -home(row), why: 'open credit' })),
    ...lines.map(line => ({ entity: 'JournalEntry', id: line.id, date: line.date, cents: line.cents, why: 'journal line on a receivable or payable account' })),
    ...open.filter(row => row.summary?.currency && row.summary.currency !== 'CAD').map(row => ({ entity: row.entity, id: row.qboId, date: row.summary?.txnDate || null, cents: home(row), why: 'foreign-currency balance (' + row.summary.currency + ')' })),
  ].slice(0, 40);
  return { receivables: of('Invoice') - of('CreditMemo') - sum(unapplied, paid) + journalTo(accounts.receivables), payables: of('Bill') - of('VendorCredit') - journalTo(accounts.payables), byCurrency, candidates };
}

async function controlAccounts(Records, scope) {
  const rows = await Records.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, deleted: false, entity: 'Account', 'record.AccountType': { $in: ['Accounts Receivable', 'Accounts Payable'] } }).select('qboId record.AccountType').limit(200).maxTimeMS(3000).lean();
  return { receivables: rows.filter(row => row.record.AccountType === 'Accounts Receivable').map(row => String(row.qboId)), payables: rows.filter(row => row.record.AccountType === 'Accounts Payable').map(row => String(row.qboId)) };
}

// One report read. Ledger and local copy are both read "now", so the comparison is like for like.
async function checkBooks({ client, Records, scope, asOf }) {
  const params = new URLSearchParams({ start_date: asOf.slice(0, 4) + '-01-01', end_date: asOf, accounting_method: 'Accrual' });
  const report = await runWithCaller('business-daily-check', () => client.apiCall('GET', 'reports/TrialBalance?' + params));
  const tb = readTrialBalance(report);
  if (!tb) return { agrees: false, error: 'The Trial Balance could not be read in a known layout.' };
  const accounts = await controlAccounts(Records, scope), local = await localOpenItems(Records, scope, accounts);
  const ledger = { receivables: sum(accounts.receivables, id => tb.accounts.get(id) || 0), payables: -sum(accounts.payables, id => tb.accounts.get(id) || 0) };
  const balanced = Boolean(tb.total && tb.total.debit !== null && tb.total.debit === tb.total.credit);
  const row = key => ({ ledgerCents: ledger[key], openItemsCents: local[key], differenceCents: ledger[key] - local[key], agrees: ledger[key] === local[key] });
  const receivables = row('receivables'), payables = row('payables');
  // Per control account (each currency has its own account) so a difference points at where to look.
  const byAccount = [...accounts.receivables.map(id => ({ id, type: 'receivables' })), ...accounts.payables.map(id => ({ id, type: 'payables' }))].map(row => ({ ...row, ledgerCents: (row.type === 'payables' ? -1 : 1) * (tb.accounts.get(row.id) || 0) })).filter(row => row.ledgerCents !== 0);
  const agrees = balanced && receivables.agrees && payables.agrees;
  return { agrees, trialBalance: { debitCents: tb.total?.debit ?? null, creditCents: tb.total?.credit ?? null, balanced }, receivables, payables, byAccount, openItemsByCurrency: local.byCurrency, ...(agrees ? {} : { candidates: local.candidates }) };
}

function describe(result) {
  if (result.error) return 'Daily books check could not run: ' + result.error;
  const $ = cents => (cents < 0 ? '-$' : '$') + (Math.abs(cents) / 100).toFixed(2);
  const part = (name, row) => name + (row.agrees ? ' agree with open items' : ' differ from open items by ' + $(row.differenceCents) + ' (ledger ' + $(row.ledgerCents) + ', open items ' + $(row.openItemsCents) + ')');
  return [result.trialBalance.balanced ? 'Trial balance debits equal credits' : 'Trial balance is out of balance', part('receivables', result.receivables), part('payables', result.payables)].join('; ') + '.' + (result.agrees ? '' : ' Records to check first are listed with the check (getBusinessState → dailyCheck); correct the cause with your write tools.') + ' Nothing is held.';
}

// Moves the open day to today and records one books check per business day.
// Returns null when nothing was due. Errors are recorded on the calendar, never thrown to callers.
async function runDailyCheck({ Calendars, Records, scope, resolveClient, recordEvent = null, now = () => Date.now() }) {
  const today = businessDate(new Date(now())), yesterday = shift(today, -1);
  const filter = { environment: scope.environment, realmId: scope.realmId };
  const calendar = await Calendars.findOne(filter).select('verifiedThrough currentOperationId pendingCommit stopRequested dailyCheck revision').maxTimeMS(3000).lean();
  if (!calendar?.verifiedThrough) return null;
  let rolled = false;
  if (calendar.verifiedThrough < yesterday && !calendar.currentOperationId && !calendar.pendingCommit && !calendar.stopRequested) {
    const moved = await Calendars.findOneAndUpdate({ _id: calendar._id, ...filter, revision: calendar.revision, verifiedThrough: calendar.verifiedThrough, currentOperationId: null, pendingCommit: null, stopRequested: false }, { $set: { verifiedThrough: yesterday, cursorBasis: 'daily-check' }, $inc: { revision: 1 } }, { new: true }).lean();
    rolled = Boolean(moved);
  }
  if (calendar.dailyCheck?.day === yesterday && !calendar.dailyCheck.error) return rolled ? { rolled, day: yesterday } : null;
  // A failed check is retried at most hourly.
  if (calendar.dailyCheck?.day === yesterday && now() - Date.parse(calendar.dailyCheck.checkedAt || 0) < 3600000) return rolled ? { rolled, day: yesterday } : null;
  let result;
  try { result = await checkBooks({ client: await resolveClient(scope), Records, scope, asOf: today }); }
  catch (error) { result = { agrees: false, error: String(error?.message || 'The report read failed.').slice(0, 300) }; }
  const dailyCheck = { version: 1, day: yesterday, checkedAt: new Date(now()).toISOString(), qboCalls: result.error ? null : 1, summary: describe(result), ...result };
  await Calendars.updateOne({ _id: calendar._id, ...filter }, { $set: { dailyCheck } });
  if (recordEvent) { try { await recordEvent(dailyCheck); } catch { /* The calendar keeps the result. */ } }
  return { rolled, ...dailyCheck };
}

module.exports = { runDailyCheck, checkBooks, readTrialBalance, describe };
