'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {readPopulationDeposits}=require('../src/modules/business-population-proof');
const row=id=>({Id:String(id),SyncToken:'0',Line:[{Amount:1,LinkedTxn:[{TxnType:'Payment',TxnId:String(10000+id)}]}]});
function client(mutate){const calls=[];return{calls,query:async query=>{calls.push(query);const start=Number(/STARTPOSITION (\d+)/.exec(query)[1]),rows=Array.from({length:start===1?1000:3},(_,i)=>row(start+i)),page={Deposit:rows,startPosition:start,maxResults:rows.length,totalCount:rows.length};if(mutate)mutate(page,start);return{QueryResponse:page};}};}
test('Deposit scans accept QBO per-page totalCount across1000plus3 records',async()=>{const source=client(),proof=await readPopulationDeposits(source);assert.equal(source.calls.length,2);assert.equal(proof.payments.size,1003);assert.match(source.calls[1],/STARTPOSITION 1001/);});
for(const mode of ['start','count','duplicate','link'])test('Deposit pagination still rejects '+mode+' corruption',async()=>{const source=client((page,start)=>{if(start!==1001)return;if(mode==='start')page.startPosition=999;if(mode==='count')page.totalCount=2;if(mode==='duplicate')page.Deposit[0].Id='1';if(mode==='link')page.Deposit[0].Line[0].LinkedTxn[0].TxnId='bad';});await assert.rejects(readPopulationDeposits(source));});
