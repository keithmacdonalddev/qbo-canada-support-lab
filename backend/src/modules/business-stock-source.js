'use strict';
const { runWithCaller } = require('./qbo-request-meter');
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const ID = /^[a-f0-9]{24}$/, QID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const MAX_SOURCE_BYTES = 1500000, MAX_CALLS = 100;
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_STOCK_COST_UNVERIFIED' }); }
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
function projectStockRecord(entity, value) {
  if (!plain(value) || typeof value.Id !== 'string' || !QID.test(value.Id) || typeof value.SyncToken !== 'string' || !VERSION.test(value.SyncToken) || (value.sparse !== undefined && value.sparse !== false) || Buffer.byteLength(canonical(value)) > 1000000) fail('An exact complete stock source is required.');
  // Settlement balances/links and current PurchaseCost do not determine FIFO cost.
  const keys = entity === 'Item' ? ['Id','SyncToken','Type','Active','TrackQtyOnHand','QtyOnHand','InvStartDate','AssetAccountRef','ExpenseAccountRef']
    : ['Id','SyncToken','TxnDate','CurrencyRef','VendorRef','APAccountRef','GlobalTaxCalculation','Line','TxnTaxDetail','TotalAmt','ClassRef','DepartmentRef','ProjectRef'];
  return JSON.parse(canonical(Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))));
}
function validateStockSource(value, scope, items, billIds) {
  const { sourceHash, ...source } = value || {};
  if (source.version !== 1 || canonical(source.scope) !== canonical(scoped(scope)) || hash(source) !== sourceHash || Buffer.byteLength(canonical(value)) > MAX_SOURCE_BYTES || !Number.isInteger(source.fiscalYearStartMonth) || source.fiscalYearStartMonth < 1 || source.fiscalYearStartMonth > 12 || !/^[a-f0-9]{64}$/.test(source.companyRecordHash || '') || !Array.isArray(source.items) || !Array.isArray(source.bills)) fail('The scoped stock observation is unavailable or changed.');
  const started = Date.parse(source.startedAt), ended = Date.parse(source.observedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started || ended - started > 180000) fail('The stock observation has invalid time bounds.');
  for (const [entity, rows, expected] of [['Item',source.items,items.map(row => row.itemId)],['Bill',source.bills,billIds]]) {
    if (rows.length !== expected.length || new Set(expected).size !== expected.length || new Set(rows.map(row => row?.Id)).size !== rows.length || canonical(rows.map(row => row.Id).sort()) !== canonical([...expected].sort())) fail('The stock observation lacks an exact complete record set.');
    for (const row of rows) if (canonical(projectStockRecord(entity,row)) !== canonical(row)) fail('The retained stock projection changed.');
  }
  return value;
}
function stockBillIds(state) { return [...new Set(state.items.flatMap(item => item.lots.map(lot => lot.source.qboId)))].sort(); }
// Keep independent live quantities and original purchase lots: stock close proof
// must follow the final graph observations, which an older mirror cannot prove.
// Fixed exact-ID GETs through the original client, with per-attempt authority.
function createBusinessStockReader({ access, now = () => Date.now(), purpose = 'operations.verify' }) {
  if (!['operations.preview','operations.verify'].includes(purpose) || [access?.authorize,access?.resolveClient,now].some(fn => typeof fn !== 'function')) throw new TypeError('Stock reads need current scoped business access');
  return async function read(scope, state, { signal } = {}) {
    scope = scoped(scope); require('./business-stock-cost').validateStockState(state,scope);
    const billIds = stockBillIds(state), jobs = [...state.items.map(row => ['Item',row.itemId]),...billIds.map(id => ['Bill',id])];
    if (jobs.length + 1 > MAX_CALLS) fail('Remaining stock sources exceed the bounded read budget.');
    const started = now(), controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(abort,180000); timer.unref?.();
    let attempts = 0, failure = null;
    const stop = error => { failure ||= error; abort(); };
    const check = () => { if (controller.signal.aborted || !Number.isFinite(now()) || now() < started || now() - started > 180000) fail('Stock observation was cancelled or exceeded three minutes.'); };
    try {
      check(); const actor = await access.authorize(scope,purpose,{signal:controller.signal}); check();
      if (!ID.test(actor?.actorId || '') || !ID.test(actor?.ownerId || '')) fail('Current stock observation authority is required.');
      const client = await access.resolveClient(scope,{signal:controller.signal}); check();
      const { QBOClient } = require('./qbo-client');
      const guard = () => {
        const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
        if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall || client.query !== QBOClient.prototype.query || client.apiBase !== base || client.realmId !== scope.realmId || String(client.connection?._id) !== scope.connectionId || client.connection?.realmId !== scope.realmId || client.connection?.status !== 'active' || String(client.connection?.userId) !== actor.ownerId) fail('Stock source client changed company or owner.');
      };
      const authorize = async () => {
        check(); guard(); const current = await access.authorize(scope,purpose,{signal:controller.signal}); check(); guard();
        if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('Stock observation authority changed.');
      };
      const control = { signal:controller.signal,onFailure:stop,beforeAttempt:async () => { await authorize(); if (attempts++ >= MAX_CALLS) fail('Stock observation exceeded its request budget.'); } };
      const items = [], bills = [];
      for (const [entity,id] of jobs) {
        await authorize(); const body = await runWithCaller('business-stock',()=>client.apiCall('GET',entity.toLowerCase() + '/' + id,undefined,0,0,control)); await authorize();
        if (!plain(body) || Object.keys(body).some(key => ![entity,'time'].includes(key)) || body[entity]?.Id !== id) fail('The exact stock record response is incomplete.');
        (entity === 'Item' ? items : bills).push(projectStockRecord(entity,body[entity]));
        if (Buffer.byteLength(canonical({items,bills})) > MAX_SOURCE_BYTES - 4096) fail('Stock source content exceeds its evidence budget.');
      }
      await authorize(); const company = await runWithCaller('business-stock',()=>client.query('SELECT * FROM CompanyInfo MAXRESULTS 1',control)); await authorize();
      const rows = company?.QueryResponse?.CompanyInfo, months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      if (!plain(company) || Object.keys(company).some(key => !['QueryResponse','time'].includes(key)) || !plain(company.QueryResponse) || Object.keys(company.QueryResponse).some(key => !['CompanyInfo','startPosition','maxResults','totalCount'].includes(key)) || !Array.isArray(rows) || rows.length !== 1 || !plain(rows[0]) || rows[0].Country !== 'CA' || typeof rows[0].Id !== 'string' || !QID.test(rows[0].Id) || (company.QueryResponse.startPosition !== undefined && company.QueryResponse.startPosition !== 1) || (company.QueryResponse.maxResults !== undefined && company.QueryResponse.maxResults !== 1) || (company.QueryResponse.totalCount !== undefined && company.QueryResponse.totalCount !== 1)) fail('Current Canadian fiscal settings are unavailable.');
      const fiscalYearStartMonth = months.indexOf(rows[0].FiscalYearStartMonth) + 1;
      if (!fiscalYearStartMonth) fail('The actual company fiscal calendar is unavailable.');
      const source = {version:1,scope,startedAt:new Date(started).toISOString(),observedAt:new Date(now()).toISOString(),fiscalYearStartMonth,companyRecordHash:hash(rows[0]),items,bills};
      return validateStockSource({...source,sourceHash:hash(source)},scope,state.items,billIds);
    } catch (error) { stop(error); throw failure || error; }
    // Every SDK promise above has settled, including any normal token persistence.
    finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); abort(); }
  };
}
module.exports = { MAX_SOURCE_BYTES, MAX_CALLS, projectStockRecord, validateStockSource, stockBillIds, createBusinessStockReader };
