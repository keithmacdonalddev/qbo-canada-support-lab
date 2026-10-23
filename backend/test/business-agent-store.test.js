'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBusinessAgentStore}=require('../src/modules/business-agent-store');
test('older unanswered owner decisions precede newer answered history and responses use the exact lookup variable',async()=>{
 const agentId='a'.repeat(24),at=new Date('2026-10-23T10:00:00Z');
 const decisions=Array.from({length:25},(_,i)=>({_id:String(i+1).padStart(24,'0'),agentId,kind:'decision',role:'accountant',title:'Decision '+i,detail:'Retained evidence',at:new Date(at.getTime()+i*1000),data:{}}));
 const responses=decisions.slice(1).map((d,i)=>({_id:String(100+i).padStart(24,'0'),agentId,kind:'decision-response',role:'owner',title:'Owner accepted',detail:'Accepted by owner',at:d.at,data:{decisionId:d._id,choice:'accept'}}));
 const Events={collection:{name:'fixture_events'},aggregate(pipeline){return{option:async()=>{
  const lookup=pipeline.find(p=>p.$lookup).$lookup;assert.equal(lookup.let.decisionId,'$_id');
  const operands=lookup.pipeline[0].$match.$expr.$eq;
  const result=decisions.map(d=>{const resolve=(term,r)=>term==='$$decisionId'?d._id:term.split('.').reduce((v,k)=>v?.[k],{$data:r.data,$decisionId:r.decisionId});const joined=responses.filter(r=>resolve(operands[0],r)===resolve(operands[1],r));return{...d,responses:joined,answered:joined.length>0};});
  result.sort((a,b)=>Number(a.answered)-Number(b.answered)||b.at-a.at);return result.slice(0,20);
 }}}};
 const store=createBusinessAgentStore({models:{Agents:{},Events},connection:{},transaction:async work=>work({})});
 const result=await store.decisions({_id:agentId});assert.equal(result[0].id,decisions[0]._id);assert.equal(result[0].status,'pending');assert.equal(result[1].status,'accept');assert.equal(result[1].response.detail,'Accepted by owner');
});
