'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBusinessObservationStore}=require('../src/modules/business-observation-store');
const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)};
const chain=value=>({maxTimeMS(){return this;},lean:async()=>structuredClone(value)});
const values=(row,parts)=>!parts.length?[row]:Array.isArray(row)?row.flatMap(value=>values(value,parts)):values(row?.[parts[0]],parts.slice(1));
const matches=(row,filter)=>Object.entries(filter).every(([key,want])=>key==='$or'?want.some(part=>matches(row,part)):values(row,key.split('.')).some(got=>want&&typeof want==='object'&&!(want instanceof Date)?'$gte'in want?new Date(got)>=want.$gte:'$in'in want?want.$in.includes(got):'$elemMatch'in want?Array.isArray(got)&&got.some(value=>matches(value,want.$elemMatch)):false:String(got)===String(want)));

test('general period proofs invalidate historical parent balances for the shared transaction reader',async()=>{
  const clock=Date.parse('2026-12-02T15:00:00Z'),receipts=[];
  const source={entity:'Invoice',status:'current',phase:'incremental',generation:'g',mode:'cdc',since:'2026-12-02T14:59:00Z',lastSuccessAt:'2026-12-02T15:00:00Z',everyMs:60000};
  const record={Id:'100',SyncToken:'0',Balance:100};
  const store=createBusinessObservationStore({now:()=>clock,Agents:{findOne:()=>chain({...scope,sync:{sources:{Invoice:source}}})},Records:{findOne:()=>chain({...scope,entity:'Invoice',qboId:'100',deleted:false,generation:'g',record})},Receipts:{findOne:filter=>chain(receipts.find(row=>matches(row,filter))||null)},Writers:{},Audits:{}});
  assert.equal((await store.read(scope,'Invoice','100',{transactions:true})).record.Balance,100);
  receipts.push({...scope,entity:'batch',state:'saved',sentAt:new Date(clock),periodProof:{proofs:[{evidence:{records:[{entity:'Invoice',id:'100'}]}}]}});
  assert.equal(await store.read(scope,'Invoice','100',{transactions:true}),null,'the old parent mirror must not be returned after a general payment');
});

test('transactional admission uses hardened reconciliation refusals and session-scoped reads',async()=>{
  const clock=Date.parse('2026-12-02T15:00:00Z'),session={},seen=[];
  const q=value=>({session(value){seen.push(value);return this;},maxTimeMS(){return this;},lean:async()=>structuredClone(value)});
  const source={entity:'Item',status:'current',phase:'incremental',generation:'g',mode:'cdc',since:'2026-12-02T14:59:00Z',lastSuccessAt:'2026-12-02T15:00:00Z',everyMs:60000};
  let status='attention';const models={Agents:{findOne:()=>q({...scope,sync:{sources:{Item:source},amountReconciliation:{status}}})},Records:{findOne:()=>q({...scope,entity:'Item',qboId:'40',deleted:false,generation:'g',record:{Id:'40',SyncToken:'0',Type:'Service'}})},Receipts:{findOne:()=>q(null)},Writers:{},Audits:{}};
  const store=createBusinessObservationStore({...models,session,now:()=>clock});
  assert.equal(await store.read(scope,'Item','40',{transactions:true}),null);
  status='current';assert.ok(await store.read(scope,'Item','40',{transactions:true}));
  assert.ok(seen.length>1);assert.ok(seen.every(value=>value===session));
});
