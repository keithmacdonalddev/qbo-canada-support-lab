'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const C = require('./period-close-contract');
const { QBOClient } = require('./qbo-client');
const MAX_RECORDS = 1000, MAX_ATTEMPTS = 8, MAX_MS = 180000;
function compact(record) {
  if (!record || !C.QID.test(record.Id || '') || typeof record.SyncToken !== 'string' || !/^(0|[1-9]\d{0,63})$/.test(record.SyncToken) || typeof record.Active !== 'boolean' || !C.text(record.AccountType, 1, 100) || !C.text(record.Name, 1, 500) || (record.sparse !== undefined && record.sparse !== false)) C.fail('Current account metadata is incomplete.');
  const currency = record.CurrencyRef?.value ?? null;
  if (currency !== null && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) C.fail('An account currency is unsupported.');
  return { id: record.Id, syncToken: record.SyncToken, active: record.Active, type: record.AccountType, name: record.Name, currency };
}
function eligible(accounts) { return accounts.filter(row => ['Bank','Credit Card'].includes(row.type)); }
function createPeriodCloseReader({ access, now = () => Date.now() }) {
  if (![access?.authorize, access?.resolveClient, now].every(value => typeof value === 'function')) throw new TypeError('Period review requires current scoped access');
  return async (suppliedScope, { signal, preferencesOnly = false } = {}) => {
    const scope = scoped(suppliedScope), started = now(), controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, MAX_MS); timer.unref?.();
    let attempts = 0, admitted = 0, failure = null;
    const check = () => { if (failure) throw failure; if (controller.signal.aborted || !Number.isFinite(now()) || now() < started || now() - started > MAX_MS) C.fail('The accounting-period review was cancelled or exceeded three minutes.'); };
    const stop = error => { failure ||= error; controller.abort(); };
    const call = factory => new Promise((resolve, reject) => {
      const cancelled = () => { try { check(); } catch (error) { reject(error); } };
      if (controller.signal.aborted) return cancelled();
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
    });
    async function authority() {
      check(); const actor = await call(() => access.authorize(scope, 'periods.manage', { signal: controller.signal })); check();
      if (!C.ID.test(actor?.actorId || '') || actor.actorId !== actor.ownerId) C.fail('Only the current connected owner can review company protection.', 403);
      return actor;
    }
    async function query(sql) {
      const actor = await authority(), client = await call(() => access.resolveClient(scope, { signal: controller.signal }));
      const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
      const guard = () => {
        check();
        if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall || client.query !== QBOClient.prototype.query || client.realmId !== scope.realmId || client.apiBase !== base || String(client.connection?._id) !== scope.connectionId || String(client.connection?.userId) !== actor.ownerId || client.connection?.realmId !== scope.realmId || client.connection?.status !== 'active') C.fail('The original QuickBooks read client changed company.');
      };
      guard();
      const control = { signal: controller.signal, onFailure: stop, beforeAttempt: async () => {
        guard(); const current = await authority(); guard();
        if (current.ownerId !== actor.ownerId || admitted >= MAX_ATTEMPTS) C.fail('This review exceeds its eight-request budget.');
        admitted++;
      }, onSdkAttempt: () => { attempts++; } };
      const result = await call(() => client.query(sql, control)); guard(); await authority();
      if (!result || Object.getPrototypeOf(result) !== Object.prototype || Object.keys(result).some(key => !['QueryResponse','time'].includes(key)) || !result.QueryResponse || Object.getPrototypeOf(result.QueryResponse) !== Object.prototype) C.fail('A complete current account/preferences query response is required.');
      C.bounded(result, 3000000); return result.QueryResponse;
    }
    async function preferences() {
      const body = await query('SELECT * FROM Preferences MAXRESULTS 1'), values = body.Preferences;
      if (Object.keys(body).some(key => !['Preferences','startPosition','maxResults','totalCount'].includes(key)) || !Array.isArray(values) || values.length !== 1 || (body.maxResults !== undefined && body.maxResults !== 1) || !values[0] || Object.getPrototypeOf(values[0]) !== Object.prototype || !values[0].AccountingInfoPrefs || Object.getPrototypeOf(values[0].AccountingInfoPrefs) !== Object.prototype) C.fail('Current QuickBooks closing preferences are unavailable.');
      const raw = values[0].AccountingInfoPrefs.BookCloseDate, closedThrough = raw === undefined || raw === null || raw === '' ? null : raw;
      if (closedThrough !== null) try { date(closedThrough); } catch { C.fail('The QuickBooks closing date is invalid.'); }
      return { closedThrough, contentHash: hash(values[0]) };
    }
    async function scan() {
      const accounts = [], seen = new Set(); let declared = null;
      for (let start = 1; start <= MAX_RECORDS + 1; start += 1000) {
        const body = await query('SELECT * FROM Account WHERE Active IN (true, false) ORDERBY Id ASC STARTPOSITION ' + start + ' MAXRESULTS 1000'), rows = body.Account ?? [];
        if (Object.keys(body).some(key => !['Account','startPosition','maxResults','totalCount'].includes(key)) || !Array.isArray(rows) || rows.length > 1000 || (rows.length && body.startPosition !== start) || (body.startPosition !== undefined && body.startPosition !== start) || (body.maxResults !== undefined && body.maxResults !== rows.length)) C.fail('The current account inventory page is incomplete.');
        if (body.totalCount !== undefined) { if (!Number.isSafeInteger(body.totalCount) || body.totalCount < 0 || body.totalCount > MAX_RECORDS || (declared !== null && declared !== body.totalCount)) C.fail('The account count changed or exceeds this review budget.'); declared = body.totalCount; }
        for (const record of rows) {
          const row = compact(record);
          if (seen.has(row.id) || accounts.length >= MAX_RECORDS) C.fail('Current accounts were repeated or exceeded the bounded inventory.');
          seen.add(row.id); accounts.push(row);
        }
        if (rows.length < 1000) {
          if (declared !== null && declared !== accounts.length) C.fail('The account query omitted records.');
          accounts.sort((a,b) => a.id.localeCompare(b.id));
          C.bounded(accounts, 256000);
          if (eligible(accounts).length > 64) C.fail('The bank/card account set exceeds this manual review budget.');
          return accounts;
        }
      }
      C.fail('The complete account inventory exceeds this review budget.');
    }
    try {
      const firstPreferences = await preferences(), accounts = preferencesOnly ? null : await scan(), second = preferencesOnly ? null : await scan(), lastPreferences = await preferences();
      if (!C.same(firstPreferences, lastPreferences) || !C.same(accounts, second)) C.fail('Accounts or closing preferences changed during review. Read them again.');
      await authority(); check();
      const source = { version: 1, scope, startedAt: new Date(started).toISOString(), observedAt: new Date(now()).toISOString(), accounts, accountInventoryHash: accounts ? hash(accounts) : null, preferences: lastPreferences, qboReadAttempts: attempts, matchingScans: !preferencesOnly };
      C.bounded(source, 260000);
      return { ...source, sourceHash: hash(source) };
    } catch (error) { error.periodReadAttempts = attempts; throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
function validateObservation(source, scope) {
  const { sourceHash, ...value } = source || {};
  if (value.version !== 1 || !C.same(value.scope, scope) || !C.HASH.test(sourceHash || '') || hash(value) !== sourceHash || !value.preferences || !C.HASH.test(value.preferences.contentHash || '') || !Number.isSafeInteger(value.qboReadAttempts) || value.qboReadAttempts < 2 || value.qboReadAttempts > MAX_ATTEMPTS || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) < Date.parse(value.startedAt) || Date.parse(value.observedAt) - Date.parse(value.startedAt) > MAX_MS) C.fail('The retained account/preferences review changed.');
  if (value.preferences.closedThrough !== null) try { date(value.preferences.closedThrough); } catch { C.fail('The retained QuickBooks closing date changed.'); }
  if (value.accounts !== null) {
    if (!Array.isArray(value.accounts) || value.accounts.length > MAX_RECORDS || hash(value.accounts) !== value.accountInventoryHash || value.matchingScans !== true || new Set(value.accounts.map(row => row.id)).size !== value.accounts.length) C.fail('The retained complete account inventory changed.');
    for (const row of value.accounts) {
      if (!C.exact(row, ['id','syncToken','active','type','name','currency'])) C.fail('The retained account fields changed.');
      const original = compact({ Id: row.id, SyncToken: row.syncToken, Active: row.active, AccountType: row.type, Name: row.name, CurrencyRef: row.currency === null ? undefined : { value: row.currency } });
      if (!C.same(original, row)) C.fail('The retained account metadata changed.');
    }
  }
  if (value.accounts === null && (value.accountInventoryHash !== null || value.matchingScans !== false)) C.fail('The preferences-only review contains contradictory account evidence.');
  C.bounded(source, 260000); return source;
}
module.exports = { createPeriodCloseReader, validateObservation, eligible, MAX_ATTEMPTS, MAX_MS };
