'use strict';
const { hash, canonical } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
const { scoped } = require('./qbo-write-contract');
const { evaluateBooks, validDate } = require('./book-evidence');
const REPORTS = ['TrialBalance', 'BalanceSheet', 'ProfitAndLoss', 'AgedReceivables', 'AgedPayables'];
const ID = /^[a-f0-9]{24}$/, QID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_REPORT_UNVERIFIED' }); }
// Fixed read-only report/query surface. Raw bounded sources are retained for audit;
// totals agreeing never means that the company is realistic or bank-reconciled.
function createBusinessReportReader({ access, now = () => Date.now(), purpose = 'operation' }) {
  if (!['operation', 'baseline'].includes(purpose)) throw new TypeError('Choose an explicit report evidence purpose');
  const action = purpose === 'baseline' ? 'baseline.capture' : 'operations.verify';
  if ([access?.authorize, access?.resolveClient, now].some(fn => typeof fn !== 'function')) throw new TypeError('Report evidence needs scoped company access');
  return async function read(scope, period, { signal } = {}) {
    scope = scoped(scope);
    const { fromDate, throughDate } = period || {};
    if (![fromDate, throughDate].every(validDate) || fromDate > throughDate || throughDate > businessDate(new Date(now())) || Date.parse(throughDate) - Date.parse(fromDate) > 366 * 86400000) fail('Choose a current business period of at most one year.');
    const started = now(), controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 180000); timer.unref?.();
    const check = () => { if (controller.signal.aborted || !Number.isFinite(now()) || now() < started || now() - started > 180000) fail('Report observation was cancelled or exceeded three minutes.'); };
    const call = factory => new Promise((resolve, reject) => {
      const cancelled = () => { try { check(); } catch (error) { reject(error); } };
      if (controller.signal.aborted) return cancelled();
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
    });
    try {
      check(); const actor = await call(() => access.authorize(scope, action, { signal: controller.signal })); check();
      if (!ID.test(actor?.actorId || '') || !ID.test(actor?.ownerId || '')) fail('Current report authority is required.');
      const client = await call(() => access.resolveClient(scope, { signal: controller.signal })); check();
      const { QBOClient } = require('./qbo-client');
      const guard = () => {
        const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
        if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall || client.query !== QBOClient.prototype.query || client.apiBase !== base || client.realmId !== scope.realmId || String(client.connection?._id) !== scope.connectionId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active' || String(client.connection?.userId) !== actor.ownerId) fail('Report client changed company or owner.');
      };
      guard(); const reports = {}, accounts = [], seen = new Set(); let bytes = 0, declared = null;
      const retain = value => { const text = canonical(value); bytes += Buffer.byteLength(text); if (bytes > 6000000) fail('Report sources exceed the retained evidence budget.'); return JSON.parse(text); };
      const jobs = REPORTS.map(name => async () => {
        const params = new URLSearchParams({ accounting_method: 'Accrual', start_date: fromDate, end_date: throughDate });
        if (name.startsWith('Aged')) params.set('report_date', throughDate);
        check(); guard(); const report = await call(() => client.apiCall('GET', 'reports/' + name + '?' + params)); check(); guard();
        if (!report || Object.keys(report).some(key => !['Header', 'Columns', 'Rows'].includes(key))) fail('Report response is incomplete or contains unsupported warnings.');
        reports[name] = retain(report);
      });
      jobs.push(async () => {
        for (let start = 1; start <= 4001; start += 1000) {
          check(); guard(); const body = await call(() => client.query('SELECT * FROM Account WHERE Active IN (true, false) ORDERBY Id ASC STARTPOSITION ' + start + ' MAXRESULTS 1000')); check(); guard();
          if (!body || Object.keys(body).some(key => !['QueryResponse', 'time'].includes(key)) || !body.QueryResponse || Object.getPrototypeOf(body.QueryResponse) !== Object.prototype) fail('The complete account list is unavailable.');
          const page = body.QueryResponse, rows = page.Account === undefined ? [] : page.Account;
          if (Object.keys(page).some(key => !['Account', 'startPosition', 'maxResults', 'totalCount'].includes(key)) || !Array.isArray(rows) || rows.length > 1000 || (rows.length && page.startPosition !== start) || (page.startPosition !== undefined && page.startPosition !== start) || (page.maxResults !== undefined && page.maxResults !== rows.length)) fail('Account pagination is incomplete.');
          if (page.totalCount !== undefined) { if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.totalCount > 4000 || (declared !== null && declared !== page.totalCount)) fail('Account count changed or exceeds its budget.'); declared = page.totalCount; }
          for (const record of rows) {
            if (!record || typeof record.Id !== 'string' || !QID.test(record.Id) || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken) || typeof record.AccountType !== 'string' || !record.AccountType || (record.sparse !== undefined && record.sparse !== false) || seen.has(record.Id) || accounts.length >= 4000) fail('Account records are incomplete or repeated.');
            seen.add(record.Id); accounts.push(retain(record));
          }
          if (rows.length < 1000) { if (declared !== null && declared !== accounts.length) fail('Account query omitted rows.'); return; }
        }
        fail('Account observation exceeds its budget.');
      });
      let next = 0; await Promise.all(Array.from({ length: 2 }, async () => { while (next < jobs.length) { check(); await jobs[next++](); } }));
      check(); guard(); const current = await call(() => access.authorize(scope, action, { signal: controller.signal })); check(); guard();
      if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('Report authority changed during observation.');
      const evaluation = evaluateBooks(reports, { fromDate, throughDate }, {}, { records: accounts });
      const source = { version: 1, scope, period: { fromDate, throughDate }, startedAt: new Date(started).toISOString(), observedAt: new Date(now()).toISOString(), reports, accounts };
      return { ...source, sourceHash: hash(source), evaluation };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
module.exports = { createBusinessReportReader };
