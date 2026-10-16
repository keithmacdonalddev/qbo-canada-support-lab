'use strict';
const { hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
async function readCanadianCompany(client, scope, now = () => Date.now(), { fiscalCalendar = false } = {}) {
  if (typeof fiscalCalendar !== 'boolean') throw new TypeError('Fiscal calendar observation must be explicit');
  scope = scoped(scope);
  const response = await client.query('SELECT * FROM CompanyInfo MAXRESULTS 1'), rows = response?.QueryResponse?.CompanyInfo;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Country !== 'CA' || typeof rows[0].Id !== 'string') throw Object.assign(new Error('The current company must explicitly report Canadian country settings before Canadian business policy is accepted.'), { status: 409, code: 'BUSINESS_COUNTRY_UNVERIFIED' });
  if (fiscalCalendar) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const fiscalYearStartMonth = months.indexOf(rows[0].FiscalYearStartMonth) + 1;
    if (!fiscalYearStartMonth) throw Object.assign(Error('The actual company fiscal-year starting month must be readable for stock-cost proof.'), { status: 409, code: 'BUSINESS_STOCK_COST_UNVERIFIED' });
    return { version: 2, scope, country: 'CA', companyInfoId: rows[0].Id, fiscalYearStartMonth, recordHash: hash(rows[0]), observedAt: new Date(now()).toISOString() };
  }
  return { version: 1, scope, country: rows[0].Country, companyInfoId: rows[0].Id, recordHash: hash(rows[0]), observedAt: new Date(now()).toISOString() };
}
module.exports = { readCanadianCompany };
