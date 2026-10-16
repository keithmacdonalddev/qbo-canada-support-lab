'use strict';
const {fixture:businessFixture,scope,ownerId,actorId}=require('./business-governance-fixture');
const {hash}=require('../../src/modules/business-calendar');
const {createDefinitionsService}=require('../../src/modules/rebuild-definitions');
const {createReportEvidenceService}=require('../../src/modules/report-evidence-service');
const {createPeriodCloseService}=require('../../src/modules/period-close-service');
const {assertionDefinitions}=require('../../src/modules/report-evidence-contract');
function fixture(){
  const h=businessFixture({originalSdkTransport:true,copyOnWriteTransactions:true});
  h.clock=Date.parse('2026-10-15T20:00:00Z');h.connected=true;h.period={fromDate:'2026-09-01',throughDate:'2026-09-30'};
  h.data.Memberships[0]._id='d'.repeat(24);h.data.Memberships[1]._id='e'.repeat(24);
  for(const model of Object.values(h.models)){const find=model.find;model.find=(...args)=>{const q=find(...args);q.hint=()=>q;return q;};}
  h.records.set('account:999',{entity:'Account',record:{Id:'999',SyncToken:'0',Active:false,Name:'Fixture card',AccountType:'Credit Card',CurrencyRef:{value:'CAD'},CurrentBalance:999999999}});
  const definitionService=createDefinitionsService(),summary=definitionService.getSummary();
  h.reportDefinitions=structuredClone(definitionService.listReports({offset:0,limit:1000}).items);
  h.definitions={getSummary:()=>summary,listReports:()=>({items:structuredClone(h.reportDefinitions)})};
  const deps={models:h.models,connection:{db:h.db},transaction:h.transaction,assertReady:h.assertReady,now:()=>h.clock,accessFor:h.accessFor,definitions:h.definitions,resolveContext:async()=>({environment:scope.environment,connection:{connected:h.connected,...scope,companyName:'Fixture Harbour Business'}})};
  h.governance=h.service;h.service=createPeriodCloseService(deps);h.manual=createReportEvidenceService(deps);
  h.seedReports=async()=>{
    h.reportInputs=[];
    for(const[index,report]of h.reportDefinitions.filter(row=>row.tier==='critical').entries()){
      const body={requestKey:String(index+101).padStart(8,'0')+'-1111-4111-8111-111111111111',scopeHash:hash(scope),catalogHash:summary.hashes.catalog,reportKey:report.key,period:h.period,basis:'Accrual',filters:'No additional filters',observedOn:'2026-10-15',checks:Object.fromEntries(['availability','population','plausibility','reconciliation'].map(key=>[key,{status:'passed',note:'Fixture owner reviewed the exact company source and independently compared the required figures.'}])),assertions:assertionDefinitions(report).map(row=>({key:row.key,status:'passed',note:'Fixture owner checked this exact assertion against the retained full-company report.'})),source:{reference:'Fixture September '+report.name+' export',procedure:'Fixture owner opened the full-company Accrual report for September and checked its required comparisons.',finding:'Fixture source results passed the stated report assertions; this is synthetic manual evidence, never a live accounting claim.'},confirmManual:true};
      h.reportInputs.push(body);await h.manual.save(h.user,body);
    }
  };
  h.make=async(mode='close',key='aaaaaaaa-1111-4111-8111-111111111111')=>{
    if(!h.reportInputs)await h.seedReports();
    const accounts=await h.service.accounts(h.user),sources=await h.service.sources(h.user,h.period);h.accountView=accounts;
    return {version:1,requestKey:key,scopeHash:hash(scope),mode,period:structuredClone(h.period),accountInventoryHash:accounts.accountInventoryHash,bankChecks:accounts.accounts.map(row=>({accountId:row.id,status:'checked',statementBalance:row.type==='Credit Card'?'225.00':'1000.00',bookBalance:row.type==='Credit Card'?'225.00':'1000.00',statementReference:'Fixture September statement for '+row.id,bookReference:'Fixture dated September 30 book register for '+row.id,observedOn:'2026-10-15',items:[],note:'Fixture owner matched dated transactions and independently checked the complete statement.',confirmMatched:true,confirmPosted:true})),reportChecks:sources.items.map(row=>({key:row.key,id:row.candidate.id,evidenceHash:row.candidate.evidenceHash})),checklist:{opening:'Fixture opening balances and previous period sources were reviewed.',transactions:'Fixture fees, errors and required corrections are already posted and sourced.',taxes:'Fixture Canadian tax controls and period source detail were reviewed.',exceptions:'Fixture owner reviewed the full evidence and there are no unexplained exceptions.'},advanceReconciled:mode==='close',reason:'Fixture owner reviewed all current account coverage, dated statements and reports before this exact decision.',confirmManual:true};
  };
  h.reviewInput=async request=>({request,reviewHash:(await h.service.review(h.user,request)).reviewHash});
  h.reopen=(key='bbbbbbbb-1111-4111-8111-111111111111')=>({version:1,requestKey:key,scopeHash:hash(scope),mode:'reopen',previousControlHash:h.data.Policies[0].periodControl.contentHash,closedThrough:'2026-08-31',reconciledThrough:'2026-08-31',reason:'Fixture owner reopens both app cutoffs to investigate the dated September correction.',evidenceReference:'Fixture correction review reference',correctionPlan:'Review the exact correction separately, preserve original sources and recheck the period before closing again.',confirmReopen:true});
  h.calendar=()=>{const value={_id:scope.environment+':'+scope.realmId,contractVersion:1,...scope,revision:4,writerRevision:2,authorityRevision:3,authorityHash:hash('fixture-published-business'),openingDate:'2026-01-01',verifiedThrough:'2026-09-30',currentOperationId:null,pendingCommit:null,stopRequested:true,baseline:{status:'verified',evidenceHash:hash('fixture-opening'),observedAt:new Date(h.clock)}};h.data.Calendars.push(value);return value;};
  return h;
}
module.exports={fixture,scope,ownerId,actorId};
