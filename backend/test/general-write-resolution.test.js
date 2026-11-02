'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recoverRetiredRuns}=require('../src/modules/general-write-resolution');
function fixture(){
 const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24),ownerId:'b'.repeat(24),actorId:'b'.repeat(24),agentAuthority:{agentId:'c'.repeat(24)}};
 const payload={TxnDate:'2026-11-01',DepositToAccountRef:{value:'50'},Line:[{Amount:40,LinkedTxn:[{TxnId:'501',TxnType:'Payment',TxnLineId:'0'}]},{Amount:60,LinkedTxn:[{TxnId:'502',TxnType:'Payment',TxnLineId:'0'}]}]};
 const original={_id:'old',...scope,status:'needs-correction',createdAt:'2026-11-01T10:00:00Z',retirement:{version:1,at:'2026-11-01T10:01:00Z',auditId:'audit',requestId:'request',batchNoDispatch:true,batchNoReceipts:true,retainedSavedEffects:true},errorDetail:{message:'Original failure retained'},plan:{operations:[{ref:'first',op:'create',entity:'Payment'},{ref:'second',op:'create',entity:'Payment'},{ref:'deposit',op:'create',entity:'Deposit',payload:{...structuredClone(payload),PrivateNote:'Original note',Line:payload.Line.map((l,i)=>({...l,LinkedTxn:[{...l.LinkedTxn[0],TxnId:{$ref:i?'second':'first'}}]}))}}]},items:{first:{outcome:'saved',entity:'Payment',qboId:'501'},second:{outcome:'saved',entity:'Payment',qboId:'502'}}};
 const successor={_id:'new',...scope,status:'complete',createdAt:'2026-11-01T10:02:00Z',updatedAt:'2026-11-01T10:02:01Z',plan:{operations:[{ref:'replacement',op:'create',entity:'Deposit',payload:structuredClone(payload)}]},items:{replacement:{outcome:'saved',entity:'Deposit',qboId:'600',request:structuredClone(payload),record:{...structuredClone(payload),Id:'600',SyncToken:'0'}}}};
 return {original,successor};
}
test('exact saved deposit posting discharges retired remainder without changing original history or notes',()=>{
 const h=fixture(),before=structuredClone(h.original);const result=recoverRetiredRuns([h.original],[h.successor]);
 assert.equal(result.pending.length,0);assert.equal(result.recovered[0].replacements[0].qboId,'600');assert.match(result.recovered[0].note,/original plan and note remain/);assert.deepEqual(h.original,before);assert.equal(h.original.status,'needs-correction');
});
for(const mode of ['account','date','amount','payment','extra-field','extra-line','currency','foreign-company','foreign-owner','foreign-actor','foreign-agent','old-successor','unknown','mismatch','missing-record','wrong-record-link','wrong-request','ambiguous','truncated','unproven-retirement','unresolved-original','uncovered-ref'])test('recovery remains actionable: '+mode,()=>{
 const h=fixture(),op=h.successor.plan.operations[0],item=h.successor.items.replacement;let candidates=[h.successor];
 if(mode==='account')op.payload.DepositToAccountRef.value='51';if(mode==='date')op.payload.TxnDate='2026-11-02';if(mode==='amount')op.payload.Line[0].Amount=41;if(mode==='payment')op.payload.Line[0].LinkedTxn[0].TxnId='999';if(mode==='extra-field')op.payload.DocNumber='different-purpose';if(mode==='extra-line')op.payload.Line.push({Amount:5});if(mode==='currency')op.payload.CurrencyRef={value:'USD'};
 if(mode==='foreign-company')h.successor.connectionId='other';if(mode==='foreign-owner')h.successor.ownerId='other';if(mode==='foreign-actor')h.successor.actorId='other';if(mode==='foreign-agent')h.successor.agentAuthority={agentId:'other'};if(mode==='old-successor')h.successor.createdAt='2026-11-01T10:00:30Z';if(mode==='unknown')h.successor.status='unknown';if(mode==='mismatch')item.outcome='mismatch';if(mode==='missing-record')delete item.record;if(mode==='wrong-record-link')item.record.Line[0].LinkedTxn[0].TxnId='999';if(mode==='wrong-request')item.request.Line[0].Amount=41;if(mode==='ambiguous')candidates.push({...structuredClone(h.successor),_id:'other'});if(mode==='unproven-retirement')delete h.original.retirement.batchNoReceipts;if(mode==='unresolved-original')h.original.items.first.outcome='unknown';if(mode==='uncovered-ref')h.original.plan.operations.push({ref:'another',op:'create',entity:'Invoice',payload:{TxnDate:'2026-11-01'}});
 const result=recoverRetiredRuns([h.original],candidates,{truncated:mode==='truncated'});assert.equal(result.recovered.length,0);assert.equal(result.pending.length,1);
});

test('identical unrelated invoice creates cannot prove replacement lineage',()=>{
 const h=fixture(),payload={TxnDate:'2026-11-01',CustomerRef:{value:'1'},Line:[{Amount:100}]};
 h.original.plan.operations=h.original.plan.operations.slice(0,2).concat({ref:'invoice',op:'create',entity:'Invoice',payload});
 h.successor.plan.operations=[{ref:'invoice',op:'create',entity:'Invoice',payload}];h.successor.items={invoice:{outcome:'saved',entity:'Invoice',qboId:'600',request:payload,record:{...payload,Id:'600'}}};
 assert.equal(recoverRetiredRuns([h.original],[h.successor]).recovered.length,0);
});
for(const mode of ['duplicate-source','invalid-retirement-time','invalid-successor-time','missing-save-time'])test('incomplete settlement recovery proof: '+mode,()=>{
 const h=fixture();if(mode==='duplicate-source'){h.original.plan.operations[2].payload.Line[1].LinkedTxn[0].TxnId={$ref:'first'};h.successor.plan.operations[0].payload.Line[1].LinkedTxn[0].TxnId='501';h.successor.items.replacement.request=h.successor.plan.operations[0].payload;h.successor.items.replacement.record={...h.successor.items.replacement.request,Id:'600'};}
 if(mode==='invalid-retirement-time')h.original.retirement.at='invalid';if(mode==='invalid-successor-time')h.successor.createdAt='invalid';if(mode==='missing-save-time')delete h.successor.updatedAt;
 assert.equal(recoverRetiredRuns([h.original],[h.successor]).recovered.length,0);
});

test('partial-write feedback distinguishes saved payments from the unsent deposit and preserves the original failure',()=>{
 const {generalAttention}=require('../src/modules/business-error-detail'),h=fixture(),before=structuredClone(h.original);
 const result=generalAttention(h.original);assert.match(result.summary,/2 customer payments are already saved/);assert.match(result.summary,/remaining bank deposit was not sent/);assert.deepEqual(result.recovery.saved.map(r=>r.qboId),['501','502']);assert.equal(result.recovery.state,'replan-remaining');assert.deepEqual(h.original,before);
});
test('saved mismatch feedback names requested mismatches without blaming provider-added metadata',()=>{
 const {generalAttention}=require('../src/modules/business-error-detail');
 const result=generalAttention({_id:'run',items:{pay:{entity:'BillPayment',outcome:'mismatch',qboId:'600',request:{APAccountRef:{value:'10'},TotalAmt:100},record:{Id:'600',TotalAmt:100,MetaData:{provider:'extra'}}}}});
 assert.match(result.summary,/records were saved/);assert.deepEqual(result.recovery.differences.map(d=>d.field),['APAccountRef']);assert.equal(result.recovery.state,'check-saved');
});
