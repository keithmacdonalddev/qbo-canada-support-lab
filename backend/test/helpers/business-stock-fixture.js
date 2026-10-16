'use strict';
const assert = require('node:assert/strict');
const {fixture:masterFixture,scope,ownerId} = require('./master-service-fixture');
const {fixture:governanceFixture} = require('./business-governance-fixture');
const {masterProgressHash} = require('../../src/modules/business-master-receipt');
const {clone} = require('./master-transport-fixture');
const {createBusinessInventoryReader} = require('../../src/modules/business-record-inventory');
const policy = {version:1,method:'FIFO',methodEvidence:{kind:'owner-observation',reference:'Fixture owner inspected the company inventory method',observedOn:'2026-10-15'},purchaseTax:{treatment:'fully-recoverable',evidenceReference:'Fixture owner confirmed fully recoverable HST purchases',confirmedOn:'2026-10-15'}};
async function fixture(t,options={}) {
  const master = masterFixture(t,{lifecycleVersion:2,stockCosting:policy,openingDate:options.openingDate || '2026-10-01'});
  t.after(async () => { master.service.close?.(); await master.service.idle(); });
  await master.proposal(); await master.approval(); const runId = String(master.run()._id);
  await master.service.execute(master.user,runId,{planHash:master.run().planHash,reviewHash:masterProgressHash(master.run()),resume:false}); await master.service.idle();
  assert.equal(master.run().state,'complete');
  const ordinals = master.run().records.map(row => row.ordinal), review = await master.service.applyReview(master.user,runId,{ordinals});
  const applied = await master.service.apply(master.user,runId,{ordinals,reviewHash:review.review.reviewHash,requestKey:'30000000-0000-4000-8000-000000000088'}), draft = clone(master.data.Versions.find(row => String(row._id) === applied.draft.id));
  const h = governanceFixture({scope,ownerId,savedDraft:draft,openingCash:0,copyOnWriteTransactions:true,originalSdkTransport:true,...options});
  h.records.clear();
  for (const [entity,rows] of Object.entries(master.remote)) if (!['Preferences','CompanyInfo'].includes(entity)) for (const record of rows) h.records.set(entity.toLowerCase()+':'+record.Id,{entity,record:clone(record)});
  for (const {entity,record} of h.records.values()) if (entity === 'TaxCode') for (const key of ['SalesTaxRateList','PurchaseTaxRateList']) for (const detail of record[key]?.TaxRateDetail || []) detail.TaxTypeApplicable = 'TaxOnAmount';
  for (const id of ['5','6']) h.records.set('taxrate:'+id,{entity:'TaxRate',record:{Id:id,SyncToken:'0',Active:true,RateValue:13,EffectiveTaxRate:[{EffectiveDate:'2020-01-01T00:00:00-04:00',RateValue:13}]}});
  for (const [id,AccountType] of [['970','Other Current Liability'],['971','Income'],['972','Equity'],['979','Equity']]) if (!h.records.has('account:'+id)) h.records.set('account:'+id,{entity:'Account',record:{Id:id,SyncToken:'0',Active:true,Name:'Independent fixture '+id,AccountType,CurrencyRef:{value:'CAD'},CurrentBalance:0}});
  // Preserve real in-memory workflow/transport/audit results, normalizing BSON IDs
  // to the string representation used by this independent fixture's query model.
  for (const key of ['MasterRuns','Receipts','Audits']) h.data[key].push(...JSON.parse(JSON.stringify(master.data[key])));
  const access = h.accessFor({actorId:ownerId,ownerId});
  h.stockInventory = () => createBusinessInventoryReader({access,now:()=>h.clock,stockMetadata:true})(scope);
  h.master = master; h.policy = policy; h.scope = scope; h.ownerId = ownerId;
  return h;
}
module.exports = {fixture,policy,scope,ownerId};
