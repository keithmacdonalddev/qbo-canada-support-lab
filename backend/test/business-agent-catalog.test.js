'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { agentToolCatalog, TOOLS } = require('../src/modules/business-agent-catalog');
const { READ_NAMES, EXTRA_TOOLS } = require('../src/modules/business-agent-tools');
const disabled={generalWriteDispatch:false,generalWriteInventory:false,generalWriteInventoryEntities:{}};
const catalogWith=features=>agentToolCatalog(undefined,null,features);

test('every live accountant tool has an owner-facing summary and its exact instructions', () => {
  const catalog = catalogWith(disabled), live = [...READ_NAMES, ...EXTRA_TOOLS.map(tool => tool.name)];
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), [...live].sort());
  assert.deepEqual(Object.keys(TOOLS).sort(), [...live].sort(), 'no description is left for a removed tool');
  for (const tool of catalog.tools) { assert.ok(tool.summary.length > 10); assert.ok(tool.instructions.length > 10); }
  assert.equal(catalog.tools.find(tool => tool.name === 'getEntityDetail').changesQuickBooks, false);
  assert.equal(catalog.tools.find(tool => tool.name === 'executeBusinessPeriod').changesQuickBooks, true);
});

test('the catalog shows the core/deferred split, the discovery tools and the skills', () => {
  const catalog = catalogWith(disabled);
  assert.equal(catalog.tools.find(tool => tool.name === 'getBusinessState').disclosure, 'core');
  assert.equal(catalog.tools.find(tool => tool.name === 'resumeBusinessOperation').disclosure, 'deferred');
  assert.equal(catalog.counts.core + catalog.counts.deferred, catalog.counts.tools);
  assert.deepEqual(catalog.discovery.map(tool => tool.name), ['searchTools', 'useTool', 'listSkills', 'loadSkill', 'readSkillReference']);
  for (const tool of catalog.discovery) { assert.ok(tool.summary.length > 10); assert.ok(tool.instructions.length > 10); }
  assert.equal(catalog.counts.skills, catalog.skills.length);
  assert.ok(catalog.skills.find(skill => skill.name === 'qbo-api-records').references >= 5);
});

test('coverage counts what the accountant can and cannot create', () => {
  const { coverage, counts } = catalogWith(disabled);
  assert.equal(counts.recordTypes, coverage.length);
  assert.equal(coverage.find(row => row.entity === 'JournalEntry').create, 'limited');
  assert.equal(coverage.find(row => row.entity === 'Customer').create, 'limited');
  assert.equal(coverage.find(row => row.entity === 'Employee').create, 'no');
  assert.equal(coverage.find(row => row.entity === 'Invoice').create, 'limited');
  assert.equal(coverage.find(row => row.entity === 'Invoice').read, true);
  assert.equal(coverage.find(row => row.entity === 'BankReconciliation').read, false);
});

test('general coverage is the intersection of the public write tool and enforced entity operations when sending is enabled',()=>{
 const flags={generalWriteDispatch:true,generalWriteInventory:false,generalWriteInventoryEntities:{}},catalog=catalogWith(flags),schema=require('../src/modules/qbo-entity-schema'),tool=EXTRA_TOOLS.find(t=>t.name==='manageQboRecord').input_schema.properties.operations.items.properties,entities=new Set(tool.entity.enum),ops=new Set(tool.op.enum);
 for(const row of catalog.coverage){const expected=entities.has(row.entity)?(schema.ENTITIES[row.entity]?.ops||[]).filter(op=>ops.has(op)):[];assert.deepEqual(row.operations,expected,row.entity);assert.equal(row.change==='yes',expected.some(op=>['update','void'].includes(op)),row.entity);if(expected.includes('create')){assert.equal(row.create,'yes',row.entity);assert.ok(row.via.includes('General governed writes'));}}
 for(const entity of ['Employee','Account','Class','Department','Term','PaymentMethod','Attachable'])assert.equal(catalog.coverage.find(r=>r.entity===entity).create,'yes',entity);
 assert.equal(catalog.coverage.find(r=>r.entity==='CompanyInfo').change,'manual');assert.equal(catalog.coverage.find(r=>r.entity==='TaxCode').change,'manual');assert.equal(catalog.coverage.find(r=>r.entity==='BankReconciliation').create,'manual');
 const settings=catalog.coverage.find(r=>r.entity==='Preferences');assert.deepEqual(settings.operations,['update']);assert.match(settings.note,/selected preference fields/);assert.match(settings.note,/Multicurrency.*tax settings remain held/);
 if(!entities.has('CreditCardPayment')){const card=catalog.coverage.find(r=>r.entity==='CreditCardPayment');assert.equal(card.create,'no');assert.deepEqual(card.operations,[]);assert.match(card.note,/not exposed by the accountant/);}
 assert.equal(catalog.counts.canChange,catalog.coverage.filter(r=>r.change==='yes').length);assert.equal(catalog.counts.canVoid,catalog.coverage.filter(r=>r.operations.includes('void')).length);assert.match(catalog.tools.find(t=>t.name==='manageQboRecord').summary,/writes are enabled/);assert.doesNotMatch(catalog.tools.find(t=>t.name==='manageQboRecord').summary,/sending is switched off/);
 const purchase=catalog.coverage.find(r=>r.entity==='Purchase');assert.match(purchase.note,/PaymentType Cash or Check/);assert.match(purchase.note,/CreditCard requires a Credit Card account/);assert.doesNotMatch(purchase.note,/no cheques or card/);
});
test('disabled sending remains distinct from fixed workflows, native-only conversion and inventory switches',()=>{
 const off=catalogWith(disabled);assert.equal(off.generalWrite.dispatchEnabled,false);assert.match(off.generalWrite.note,/sending is disabled/);assert.equal(off.coverage.find(r=>r.entity==='Employee').create,'no');assert.equal(off.coverage.find(r=>r.entity==='Invoice').create,'limited');assert.equal(off.counts.canChange,0);for(const row of off.coverage)assert.deepEqual(row.operations,[]);
 const flags={generalWriteDispatch:true,generalWriteInventory:true,generalWriteInventoryEntities:{Invoice:false,SalesReceipt:true,Item:true}},before=structuredClone(flags),catalog=catalogWith(flags);assert.deepEqual(flags,before);assert.equal(catalog.coverage.find(r=>r.entity==='Invoice').inventory.enabled,false);assert.deepEqual(catalog.coverage.find(r=>r.entity==='Invoice').inventory.operations,[]);assert.equal(catalog.coverage.find(r=>r.entity==='SalesReceipt').inventory.enabled,true);assert.match(catalog.coverage.find(r=>r.entity==='SalesReceipt').note,/valuation proof/);assert.match(catalog.coverage.find(r=>r.entity==='Item').note,/inventory quantity and start-date edits remain held/);assert.equal(catalog.coverage.some(r=>r.entity==='InventoryAdjustment'),false);
 assert.deepEqual(catalog.generalWrite.estimateConversion,require('../src/modules/estimate-conversion-policy').SUPPORT);for(const entity of ['Invoice','Estimate']){const note=catalog.coverage.find(r=>r.entity===entity).note;assert.match(note,/Progress Invoicing is on or its setting is unverified/);assert.match(note,/does not create a new native Invoice/);}
 const stockOff=catalogWith({...flags,generalWriteInventory:false});assert.equal(stockOff.coverage.find(r=>r.entity==='SalesReceipt').inventory.enabled,false);
});
test('default catalog reads the current process switches and describes independent bank and native tools accurately',()=>{
 const current=agentToolCatalog(),features=require('../src/config').features;assert.equal(current.generalWrite.dispatchEnabled,features.generalWriteDispatch===true);for(const name of ['getBankingActivity','retryBankInstructions','settleBankInstructions'])assert.equal(current.tools.find(t=>t.name===name).changesQuickBooks,false,name);const repair=current.tools.find(t=>t.name==='repairEstimateConversion');assert.equal(repair.changesQuickBooks,true);assert.match(repair.summary,/existing Invoice/);assert.match(repair.summary,/no replacement Invoice/);
});
