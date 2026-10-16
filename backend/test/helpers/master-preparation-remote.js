'use strict';
const { clone } = require('./master-transport-fixture');
// Independent simulated external state, deliberately outside Mongo transaction rollback.
function remoteMasters(h) {
  const initial = h.source.setup.options, remote = { Account: initial.accounts.map(row => ({ Id: row.id, Name: row.name, Active: row.active, AccountType: row.type, AccountSubType: row.subtype, CurrencyRef: { value: row.currency }, SyncToken: '0' })),
    TaxCode: initial.taxCodes.map(row => ({ Id: row.id, Name: row.name, Active: row.active, Taxable: true, SyncToken: '0', SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '5' } }] }, PurchaseTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '6' } }] } })),
    Preferences: [{ Id: '1', AccountingInfoPrefs: {}, ProductAndServicesPrefs: { QuantityOnHand: true }, CurrencyPrefs: { HomeCurrency: { value: 'CAD' } } }], CompanyInfo: [{ Id: '1', Country: 'CA' }], Customer: [], Vendor: [], Employee: [], Item: [] };
  const entities = Object.fromEntries(Object.keys(remote).map(entity => [entity.toLowerCase(), entity])); let nextId = 100;
  h.remote = remote; h.exactReads = [];
  h.onGET = async opts => {
    const url = new URL(opts.url), query = url.searchParams.get('query');
    if (query) { const entity = /FROM (\w+)/.exec(query)?.[1]; if (!remote[entity]) throw new Error('Unmodeled fixture query'); return { status: 200, json: { QueryResponse: { [entity]: clone(remote[entity]) } } }; }
    const match = /\/(account|customer|vendor|employee|item)\/(\d+)$/.exec(url.pathname);
    if (!match) throw new Error('Unmodeled fixture read'); const entity = entities[match[1]], record = remote[entity].find(row => row.Id === match[2]); h.exactReads.push({ entity, id: match[2] });
    return { status: 200, json: { [entity]: h.changeRead ? h.changeRead(clone(record)) : clone(record) } };
  };
  h.onSDK = async opts => {
    const entity = entities[new URL(opts.url).pathname.split('/').at(-1)], record = { ...JSON.parse(opts.body), Id: String(nextId++), SyncToken: '0', ...(h.source.view.draft.business.stockCosting ? {MetaData:{CreateTime:new Date(h.clock).toISOString(),LastUpdatedTime:new Date(h.clock).toISOString()}}:{}) };
    if (!remote[entity]) throw new Error('Unmodeled fixture write'); remote[entity].push(clone(record));
    if (h.afterCreate) await h.afterCreate(record, entity);
    return { status: 200, json: { [entity]: clone(record) } };
  };
  return remote;
}
module.exports = { remoteMasters };
