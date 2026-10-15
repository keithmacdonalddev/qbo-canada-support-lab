'use strict';
const { hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
async function readCanadianCompany(client, scope, now = () => Date.now()) {
  scope = scoped(scope);
  const response = await client.query('SELECT * FROM CompanyInfo MAXRESULTS 1'), rows = response?.QueryResponse?.CompanyInfo;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Country !== 'CA' || typeof rows[0].Id !== 'string') throw Object.assign(new Error('The current company must explicitly report Canadian country settings before Canadian business policy is accepted.'), { status: 409, code: 'BUSINESS_COUNTRY_UNVERIFIED' });
  return { version: 1, scope, country: rows[0].Country, companyInfoId: rows[0].Id, recordHash: hash(rows[0]), observedAt: new Date(now()).toISOString() };
}
module.exports = { readCanadianCompany };
