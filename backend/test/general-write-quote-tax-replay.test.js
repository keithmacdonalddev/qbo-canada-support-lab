'use strict';
// Sanitized stored quote shape. The exact private proposal is replayed separately
// through this same default composition; fixtures make no provider/database calls.
const test=require('node:test'),assert=require('node:assert/strict');
const f=require('./fixtures/job-q-quotes.json');
const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)};
const now=Date.parse('2026-11-01T02:17:04.125Z');
const q=value=>({select(){return this},sort(){return this},limit(){return this},maxTimeMS(){return this},session(){return this},lean:async()=>structuredClone(value)});
const values=(r,p)=>!p.length?[r]:Array.isArray(r)?r.flatMap(x=>values(x,p)):values(r?.[p[0]],p.slice(1));
const matches=(r,f)=>Object.entries(f).every(([k,w])=>k==='$or'?w.some(x=>matches(r,x)):k==='$and'?w.every(x=>matches(r,x)):values(r,k.split('.')).some(v=>w&&typeof w==='object'&&!Array.isArray(w)&&!(w instanceof Date)?('$gte'in w?new Date(v)>=new Date(w.$gte):'$ne'in w?String(v)!==String(w.$ne):'$in'in w?w.$in.includes(v):'$elemMatch'in w?Array.isArray(v)&&v.some(x=>matches(x,w.$elemMatch)):matches(v,w)):String(v)===String(w)));
function setup(t){
 const records=f.taxes.map(r=>({...scope,entity:r.entity,qboId:r.record.Id,generation:'g',deleted:false,record:structuredClone(r.record)}));
 for(const id of ['150','151'])records.push({...scope,entity:'Customer',qboId:id,generation:'g',deleted:false,record:{Id:id,SyncToken:'0',Active:true,CurrencyRef:{value:'CAD'}}});
 records.push({...scope,entity:'Item',qboId:'53',generation:'g',deleted:false,record:{Id:'53',SyncToken:'0',Active:true,Type:'Service'}});
 const source=entity=>({entity,mode:['TaxCode','TaxRate'].includes(entity)?'snapshot':'cdc',phase:'incremental',status:'current',generation:'g',startedAt:'2026-10-31T20:59:15.848Z',since:'2026-11-01T02:16:00Z',lastSuccessAt:['TaxCode','TaxRate'].includes(entity)?'2026-10-31T20:59:16.663Z':'2026-11-01T02:17:03.125Z',everyMs:['TaxCode','TaxRate'].includes(entity)?21600000:300000});
 const agent={...scope,sync:{sources:Object.fromEntries(['TaxCode','TaxRate','Customer','Item'].map(e=>[e,source(e)]))}};
 const receipts=[{...scope,entity:'batch',state:'unknown',sentAt:new Date('2026-11-01T02:07:07.116Z')}],saved=[];
 const models={Calendars:{findOne:()=>q({verifiedThrough:'2026-10-30',baseline:{evidenceHash:'fixture'},openingDate:'2023-09-01'})},Policies:{findOne:()=>q({periodControl:{}})},GeneralWriteRuns:{findOne:()=>q(null),create:async rows=>saved.push(...rows)},Steps:{findOne:()=>q(null)},Records:{findOne:filter=>q(records.find(r=>matches(r,filter))||null),find:filter=>q(records.filter(r=>matches(r,filter)))},Agents:{findOne:()=>q(agent)},Receipts:{findOne:filter=>q(receipts.find(r=>matches(r,filter))||null)},Writers:{},Audits:{}};
 const mod=p=>require('../src/modules/'+p);
 t.mock.method(mod('business-runtime'),'loadModels',()=>models);
 t.mock.method(mod('business-authority'),'readPublishedBusiness',async()=>({view:{mappings:{salesTax:'12',purchaseTax:'12'},business:{openingDate:'2023-09-01',activityTemplateVersion:2,datedTax:{version:1,regime:'CA-NS-2025-postpaid',salesTax:'16',purchaseTax:'16'}}}}));
 const store=mod('business-observation-store'),original=store.createBusinessObservationStore;
 t.mock.method(store,'createBusinessObservationStore',opts=>original({...models,...opts}));
 for(const [name,methods]of [['GeneralWriteRun',models.GeneralWriteRuns],['CompanySyncRecord',models.Records],['BusinessAgent',models.Agents],['BusinessBaseline',{findOne:()=>q(null)}]])for(const [key,fn]of Object.entries(methods))t.mock.method(require('../src/models/'+name),key,fn);
 const api=mod('general-write-service').createDefaultGeneralWrite({now:()=>now});
 return {api,models,records,agent,receipts,saved,store:original({...models,now:()=>now}),bound:{scope,ownerId:'b'.repeat(24),actorId:'b'.repeat(24)}};
}
test('stored two-quote production composition survives unrelated unknown batch; all sales entities accept native dated GST/HST/zero/exempt',async t=>{
 const x=setup(t);
 for(const entity of ['Estimate','Invoice','SalesReceipt','CreditMemo','RefundReceipt'])for(const code of ['16','2','3','4','11','13']){
  const input=structuredClone(f.input);
  for(const op of input.operations){op.entity=entity;op.payload.Line[0].SalesItemLineDetail.TaxCodeRef.value=code;if(entity!=='Estimate'){delete op.payload.ExpirationDate;delete op.payload.TxnStatus;}if(['SalesReceipt','RefundReceipt'].includes(entity)){op.payload.DepositToAccountRef={value:'50'};}}
  if(!x.records.some(r=>r.entity==='Account'))x.records.push({...scope,entity:'Account',qboId:'50',generation:'g',deleted:false,record:{Id:'50',SyncToken:'0',Active:true,AccountType:'Bank'}});
  x.agent.sync.sources.Account={...x.agent.sync.sources.Item,entity:'Account'};
  const result=await x.api.prepare(x.bound,input);assert.equal(result.status,'prepared',entity+' '+code+' '+JSON.stringify(result));
 }
 assert.equal(x.saved.length,30);
});
test('tax-only exception preserves session reads, explicit writes, stale sources, generation and reconciliation guards',async t=>{
 const x=setup(t),session={},store=require('../src/modules/business-observation-store').createBusinessObservationStore({...x.models,session,now:()=>now});
 assert.ok(await store.read(scope,'TaxCode','16',{transactions:true}));assert.ok(await store.read(scope,'TaxRate','34',{transactions:true}));
 x.receipts.push({...scope,entity:'taxcode',state:'unknown',sentAt:new Date(now)});assert.equal(await store.read(scope,'TaxCode','16',{transactions:true}),null);x.receipts.pop();
 x.receipts.push({...scope,entity:'taxrate',state:'saved',observed:{qboId:'34'},sentAt:new Date(now)});assert.equal(await store.read(scope,'TaxRate','34',{transactions:true}),null);x.receipts.pop();
 const row=x.records.find(r=>r.entity==='TaxCode'&&r.qboId==='16');row.generation='old';assert.equal(await store.read(scope,'TaxCode','16',{transactions:true}),null);row.generation='g';
 x.agent.sync.sources.TaxCode.lastSuccessAt='2026-10-29T00:00:00Z';assert.equal(await store.read(scope,'TaxCode','16',{transactions:true}),null);x.agent.sync.sources.TaxCode.lastSuccessAt='2026-10-31T20:59:16.663Z';
 x.agent.sync.amountReconciliation={status:'attention'};assert.equal(await store.read(scope,'TaxCode','16',{transactions:true}),null);
});
test('current dated taxes prepare while inactive, incomplete, future and expired taxes stay refused',async t=>{
 const x=setup(t),rate=x.records.find(r=>r.entity==='TaxRate'&&r.qboId==='34').record,code=x.records.find(r=>r.entity==='TaxCode'&&r.qboId==='16').record;
 for(const edit of [()=>{rate.Active=false},()=>{code.Active=false},()=>{rate.EffectiveTaxRate=[]},()=>{rate.EffectiveTaxRate[0].EffectiveDate='2027-01-01'},()=>{rate.EffectiveTaxRate[0].EndDate='2026-10-31'}]){
  const a=structuredClone(rate),b=structuredClone(code);edit();const count=x.saved.length;assert.equal((await x.api.prepare(x.bound,f.input)).status,'refused',edit.toString());assert.equal(x.saved.length,count,'refused taxes never create a saved plan');for(const key of Object.keys(rate))delete rate[key];for(const key of Object.keys(code))delete code[key];Object.assign(rate,a);Object.assign(code,b);
 }
 const input=structuredClone(f.input);input.operations[0].payload.Line[0].SalesItemLineDetail.TaxCodeRef.value='12';assert.equal((await x.api.prepare(x.bound,input)).status,'prepared','Stage 1B accepts current code12 at its dated 15%, without pinning code IDs');
 const map=new Map(x.records.map(r=>[r.entity+':'+r.qboId,r.record])),local={map,get:(e,id)=>map.get(e+':'+id)};
 const contextFor=require('../src/modules/general-write-service').createGeneralWriteContext({models:x.models,now:()=>now});
 const context=await contextFor(scope,local,input);
 assert.equal(context.taxPercent['12'],15);assert.equal(context.taxPercent['16'],14);
 const historical=structuredClone(input);for(const op of historical.operations){op.payload.TxnDate='2025-03-31';op.payload.Line[0].SalesItemLineDetail.TaxCodeRef.value='12';}
 const dated=await contextFor(scope,local,historical);
 assert.deepEqual(dated.taxByDate['2025-03-31'].taxCodes.sales,['12']);assert.equal(dated.taxByDate['2025-03-31'].taxPercent['12'],15);
 rate.EffectiveTaxRate[0].RateValue=15;
 assert.equal((await x.api.prepare(x.bound,f.input)).status,'prepared');assert.equal((await contextFor(scope,local,f.input)).taxPercent['16'],15,'Current dated rate replaces the old published percentage');
 const wrong=structuredClone(f.input);wrong.operations[0].payload.Line[0].Amount=251;
 const count=x.saved.length;assert.equal((await x.api.prepare(x.bound,wrong)).status,'refused');assert.equal(x.saved.length,count,'a changed rate never waives line arithmetic');
});
