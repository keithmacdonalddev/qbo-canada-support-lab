'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),mongoose=require('mongoose');
const {fixture,scope,bound}=require('./helpers/bank-origin-fixture');
const {createBankingWorkspaceService}=require('../src/modules/banking-workspace-service');
const {createDefaultBankOriginService}=require('../src/modules/bank-origin-service');
const {ACTIONS}=require('../src/modules/business-runtime-access');
const chain=value=>({maxTimeMS(){return this;},limit(){return this;},lean:async()=>value});
test('production default origin factory reads BSON ledger and full history without coercing command scopes',async t=>{
 const h=fixture();await h.configure();await h.process();const bson=()=>new mongoose.Types.ObjectId(scope.connectionId),ledger=h.ledgers.get('123'),stored=h.events;
 h.store.getLedger=async()=>({...ledger,connectionId:bson()});h.store.listOriginRows=async()=>stored.filter(r=>r.kind==='revision').map(r=>({...r,connectionId:bson()}));
 const Records=require('../src/models/CompanySyncRecord'),Agents=require('../src/models/BusinessAgent'),Receipts=require('../src/models/QboWriteReceipt'),at=h.date+'T12:00:00.000Z',record={Id:'600',SyncToken:'0',Active:true,AccountType:'Expense',Name:'Observed fee expense'},row={...scope,connectionId:bson(),entity:'Account',qboId:'600',record,generation:'g1',deleted:false};
 t.mock.method(Records,'find',filter=>chain(filter.entity==='Account'?[row]:[]));t.mock.method(Records,'findOne',()=>chain(row));t.mock.method(Agents,'findOne',()=>chain({...scope,connectionId:bson(),sync:{sources:{Account:{entity:'Account',status:'current',phase:'incremental',generation:'g1',mode:'query',lastSuccessAt:at,startedAt:h.date+'T11:59:00.000Z',since:h.date+'T11:59:00.000Z'}}}}));t.mock.method(Receipts,'findOne',()=>chain(null));
 const workspace=createBankingWorkspaceService({store:h.store,now:()=>new Date(at),resolveContext:async()=>({environment:scope.environment,connection:{connected:true,realmId:scope.realmId,connectionId:scope.connectionId}}),authorize:async({action})=>assert.ok(ACTIONS[action],'Unsupported internal action: '+action)}),view=await workspace.originPolicy({id:bound.ownerId},'123');assert.equal(view.policy.feeMinor,500);assert.equal(view.obligations.total,1);assert.equal(view.obligations.items[0].bookkeeping.status,'needed');assert.equal(view.choices.accounts[0].id,'600');assert.equal(view.choices.accounts[0].name,'Observed fee expense');assert.equal(view.qboCalls,0);assert.ok(ACTIONS['operations.preview'].includes('qbo_data.read'));
 // Public/domain commands remain strict. Only actual Mongo ObjectId rows normalize.
 const service=createDefaultBankOriginService({store:h.store,authorize:async()=>{},now:()=>Date.parse(at)});await assert.rejects(service.accountState({...bound,scope:{...scope,connectionId:bson()}},'123'),/complete company scope/);h.store.getLedger=async()=>({...ledger,connectionId:{toString:()=>scope.connectionId,toHexString:()=>scope.connectionId}});await assert.rejects(service.accountState(bound,'123'),/persisted company connection/);h.store.getLedger=async()=>({...ledger,connectionId:new mongoose.Types.ObjectId('e'.repeat(24))});await assert.rejects(service.accountState(bound,'123'),/Adopt an evidenced/);
});

test('actual default book model composition adds its existing Agent store and preserves hermetic injected stores',async t=>{
 const h=fixture();await h.configure();await h.process();const event=(await h.service.accountState(bound,'123')).activity.events[0],runtime=require('../src/modules/business-runtime'),Records=require('../src/models/CompanySyncRecord'),Agents=require('../src/models/BusinessAgent');let defaultReads=0,injectedReads=0,loads=0;
 // The real runtime model bundle omits Agents. Default bookkeeping must merge
 // the existing banking Agent store before entering the real sync-evidence gate.
 t.mock.method(runtime,'loadModels',()=>{loads++;return{Records};});t.mock.method(Agents,'findOne',()=>{defaultReads++;return chain(null);});
 const standard=createDefaultBankOriginService({store:h.store,authorize:async()=>{},now:()=>Date.parse(h.date+'T12:00:00Z')});await assert.rejects(standard.book(bound,{accountId:'123',eventId:event.eventId}),{code:'BANKING_OPERATOR_BLOCKED'});assert.equal(defaultReads,1);assert.equal(loads,1);assert.equal(h.events.some(r=>r.eventId.startsWith('@origin-booking:')),false);
 const injected=createDefaultBankOriginService({store:h.store,models:{Records,Agents:{findOne(){injectedReads++;return chain(null);}}},authorize:async()=>{},now:()=>Date.parse(h.date+'T12:00:00Z')});await assert.rejects(injected.book(bound,{accountId:'123',eventId:event.eventId}),{code:'BANKING_OPERATOR_BLOCKED'});assert.equal(injectedReads,1);assert.equal(defaultReads,1);assert.equal(loads,1);assert.equal(h.events.some(r=>r.eventId.startsWith('@origin-booking:')),false);
});
