'use strict';
// Monthly close (owner decision 2026-11-06): one close per month, after the month's bank
// reconciliation and HST. It records the month's checklist status (open items are listed as
// exceptions, not waited on), reads one Trial Balance at month end, and moves "month closed
// through" forward. New or changed records dated in a closed month are then refused by the
// general write guard. QuickBooks' own closing-date setting is not changed here.
const { businessDate } = require('./business-activity-preview');
const { runWithCaller } = require('./qbo-request-meter');
const { readTrialBalance } = require('./business-daily-check');

function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_MONTH_CLOSE_REFUSED' }); }
const monthEnd = month => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const nextMonth = day => { const [y, m] = day.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };
// Checklist items that a close normally follows; anything not done is recorded as an exception.
const FOLLOWS = ['bank-reconciliation', 'sales-tax', 'tax-filing'];
const DONE = new Set(['manually-attested', 'report-supported', 'review-recorded']);

function checklistSummary(checklist) {
  const items = (checklist?.items || []).filter(item => FOLLOWS.includes(item.key));
  const rows = items.map(item => ({ key: item.key, account: item.accountId === 'company' ? null : item.accountName || item.accountId, status: item.status || 'open' }));
  return { items: rows, exceptions: rows.filter(row => !DONE.has(row.status)).map(row => row.key + (row.account ? ' (' + row.account + ')' : '') + ': ' + row.status) };
}

async function closeMonth({ Calendars, Records, GeneralWriteRuns = null, scope, month, reason, checklist, client, actor, now = () => Date.now() }) {
  if (typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) fail('Choose a month as YYYY-MM.', 400);
  if (typeof reason !== 'string' || reason.trim().length < 20 || reason.length > 2000) fail('Record the close reason in 20 to 2000 characters.', 400);
  const through = monthEnd(month), today = businessDate(new Date(now()));
  if (through >= today) fail('A month closes only after it has ended (' + month + ' ends ' + through + ').');
  const filter = { environment: scope.environment, realmId: scope.realmId };
  const calendar = await Calendars.findOne(filter).select('monthClose revision currentOperationId pendingCommit').maxTimeMS(3000).lean();
  if (!calendar) fail('The business calendar is unavailable.');
  // Unfinished writes may still need to land in the month: finish or settle them first.
  if (calendar.currentOperationId || calendar.pendingCommit) fail('An operation is still running; finish it before closing ' + month + '.');
  if (GeneralWriteRuns && await GeneralWriteRuns.exists({ ...filter, connectionId: scope.connectionId, status: { $in: ['prepared', 'sending', 'held', 'unknown'] } }).maxTimeMS(3000)) fail('Unsent or uncertain general writes are waiting; settle them before closing ' + month + '.');
  const closed = calendar.monthClose?.closedThrough || null;
  if (closed && through <= closed) return { closed: true, reused: true, month, closedThrough: closed };
  if (closed && nextMonth(closed) !== month) fail('Close months in order: ' + nextMonth(closed) + ' is next.');
  const params = new URLSearchParams({ start_date: month.slice(0, 4) + '-01-01', end_date: through, accounting_method: 'Accrual' });
  const tb = readTrialBalance(await runWithCaller('business-month-close', () => client.apiCall('GET', 'reports/TrialBalance?' + params)));
  if (!tb) fail('The month-end Trial Balance could not be read; nothing was closed. Try again.');
  const accounts = await Records.find({ ...filter, connectionId: scope.connectionId, deleted: false, entity: 'Account', 'record.AccountType': { $in: ['Accounts Receivable', 'Accounts Payable'] } }).select('qboId record.AccountType').limit(200).maxTimeMS(3000).lean();
  const ledger = type => accounts.filter(row => row.record.AccountType === type).reduce((sum, row) => sum + (tb.accounts.get(String(row.qboId)) || 0), 0);
  const summary = checklistSummary(checklist);
  const balanced = Boolean(tb.total && tb.total.debit !== null && tb.total.debit === tb.total.credit);
  const entry = { version: 1, month, fromDate: month + '-01', throughDate: through, closedAt: new Date(now()).toISOString(), actor, reason: reason.trim(),
    trialBalance: { balanced, debitCents: tb.total?.debit ?? null, creditCents: tb.total?.credit ?? null, receivablesCents: ledger('Accounts Receivable'), payablesCents: -ledger('Accounts Payable') },
    checklist: summary.items, exceptions: [...summary.exceptions, ...(balanced ? [] : ['trial balance out of balance at month end'])], qboCalls: 1 };
  const months = [...(calendar.monthClose?.months || []), entry].slice(-24);
  const saved = await Calendars.findOneAndUpdate({ _id: calendar._id, ...filter, 'monthClose.closedThrough': closed }, { $set: { monthClose: { version: 1, closedThrough: through, months } } }, { new: true }).lean();
  if (!saved) fail('Another close was recorded at the same time; read the state and try again.');
  return { closed: true, reused: false, ...entry, closedThrough: through };
}

// Reopens the latest closed month so a late item (for example a bank event dated in it) can be booked.
// Only the latest closed month; the history keeps both the close and the reopening.
async function reopenMonth({ Calendars, scope, month, reason, actor, now = () => Date.now() }) {
  if (typeof month !== 'string' || !/^20d{2}-(0[1-9]|1[0-2])$/.test(month)) fail('Choose a month as YYYY-MM.', 400);
  if (typeof reason !== 'string' || reason.trim().length < 20 || reason.length > 2000) fail('Record the reopening reason in 20 to 2000 characters.', 400);
  const filter = { environment: scope.environment, realmId: scope.realmId };
  const calendar = await Calendars.findOne(filter).select('monthClose').maxTimeMS(3000).lean();
  const closed = calendar?.monthClose?.closedThrough || null;
  if (!closed || closed.slice(0, 7) !== month) fail('Only the latest closed month' + (closed ? ' (' + closed.slice(0, 7) + ')' : '') + ' can be reopened.');
  const [y, m] = month.split('-').map(Number), previous = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  const prior = (calendar.monthClose.months || []).some(row => row.kind !== 'reopen' && row.throughDate === previous) ? previous : null;
  const entry = { version: 1, kind: 'reopen', month, reopenedAt: new Date(now()).toISOString(), actor, reason: reason.trim() };
  const saved = await Calendars.findOneAndUpdate({ _id: calendar._id, ...filter, 'monthClose.closedThrough': closed }, { $set: { 'monthClose.closedThrough': prior }, $push: { 'monthClose.months': { $each: [entry], $slice: -24 } } }, { new: true }).lean();
  if (!saved) fail('The month close changed at the same time; read the state and try again.');
  return { reopened: true, month, closedThrough: prior, ...entry };
}

module.exports = { closeMonth, reopenMonth, checklistSummary, monthEnd, nextMonth };
