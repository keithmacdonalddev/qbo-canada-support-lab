'use strict';
const {hash,canonical,date}=require('./business-calendar');
const {fail,equal,fresh}=require('./business-link-repair-contract');
const {unpackReport}=require('./business-report-source');
const {rowsOf,inspectReport}=require('./book-evidence');
const endpointFor=(id,throughDate)=>'reports/GeneralLedger?start_date=1900-01-01&end_date='+throughDate+'&account='+id+'&accounting_method=Accrual';
function coverage(source){
 const report=unpackReport('TrialBalance',source.reports.TrialBalance,source.version),columns=report.Columns?.Column,indexes=columns?.flatMap((x,i)=>['','account'].includes(x.ColTitle?.trim().toLowerCase())&&[undefined,'Account'].includes(x.ColType)?[i]:[])||[],index=indexes[0];
 if(indexes.length!==1)fail('The exact trial balance account column is unavailable.');
 const present=new Set(rowsOf(report).filter(x=>x.ColData&&!x.Header&&!x.Summary).map(x=>x.ColData[index]?.id)),parents=new Set(source.accounts.filter(x=>source.accounts.some(c=>c.ParentRef?.value===x.Id)).map(x=>x.Id)),omitted=source.accounts.filter(x=>parents.has(x.Id)&&!present.has(x.Id));
 const selected=source.accounts.filter(x=>!omitted.some(p=>p.Id===x.Id)).map(x=>({key:x.Id,id:x.Id}));
 // The shared validator still proves all reported balances, omitted leaf zeros,
 // unique complete detail, exact totals and absence of ambiguous parent summaries.
 const directBalances=require('./business-financial-movements').balances(report,source.accounts,selected,source.period);
 return {directBalances,omitted,basis:source.accounts.map(x=>({id:x.Id,basis:omitted.some(p=>p.Id===x.Id)?'exact-parent-ledger-no-data':present.has(x.Id)?'trial-balance-direct':'omitted-leaf-native'})).sort((a,b)=>a.id.localeCompare(b.id))};
}
function validateEmptyParent(proof,source,account,throughDate,clock){
 const {evidenceHash,...raw}=proof||{},report=proof?.report,header=report?.Header,columns=report?.Columns?.Column;
 if(!proof||proof.version!==1||proof.kind!=='exact-parent-ledger-no-data'||!equal(proof.scope,source.scope)||proof.accountId!==account.Id||proof.accountDefinitionHash!==hash(account)||proof.endpoint!==endpointFor(account.Id,throughDate)||proof.reportHash!==hash(report)||hash(raw)!==evidenceHash||!fresh(proof.observedAt,clock)||Buffer.byteLength(canonical(report))>1000000)fail('A fresh exact omitted-parent ledger source is required.');
 const allowedHeader=['Time','ReportName','ReportBasis','StartPeriod','EndPeriod','Currency','Option'];
 const titles=['Date','Transaction Type','#','Name','Memo/Description','Split','Amount','Balance'];
 const types=['tx_date','txn_type','doc_num','name','memo','split_acc','subt_nat_amount_home_nt','rbal_nat_amount_home_nt'];
 if(Object.getPrototypeOf(report)!==Object.prototype||Object.keys(report).sort().join(',')!=='Columns,Header,Rows'||!header||Object.getPrototypeOf(header)!==Object.prototype||Object.keys(header).some(k=>!allowedHeader.includes(k))||header.ReportName!=='GeneralLedger'||header.ReportBasis!=='Accrual'||header.Currency!=='CAD'||header.StartPeriod!=='1900-01-01'||header.EndPeriod!==throughDate||!equal(header.Option,[{Name:'NoReportData',Value:'true'}])||Object.getPrototypeOf(report.Columns||{})!==Object.prototype||Object.keys(report.Columns||{}).sort().join(',')!=='Column'||!Array.isArray(columns)||columns.length!==types.length||columns.some((c,i)=>!c||Object.keys(c).sort().join(',')!=='ColTitle,ColType'||c.ColType!==types[i]||c.ColTitle!==titles[i])||!report.Rows||Object.getPrototypeOf(report.Rows)!==Object.prototype||Object.keys(report.Rows).length!==0)fail('Only a complete explicitly empty exact CAD accrual parent ledger can establish no direct postings.');
 // Shared report parsing is also required; an alternate source layout never
 // becomes an invented zero just because a provider no-data flag is present.
 inspectReport('GeneralLedger',report,{fromDate:'1900-01-01',throughDate},undefined,true);
 return {accountId:account.Id,basis:'exact-parent-ledger-no-data',queriedFromDate:'1900-01-01',queriedThroughDate:throughDate,noDirectPostings:true,evidenceHash};
}
function accountCoverage(source,proofs,throughDate,clock){
 const value=coverage(source);
 if(!Array.isArray(proofs)||proofs.length!==value.omitted.length||new Set(proofs.map(x=>x.accountId)).size!==proofs.length)fail('Every omitted parent requires one exact unique ledger proof, with no extras.');
 const omittedParents=value.omitted.map(account=>validateEmptyParent(proofs.find(x=>x.accountId===account.Id),source,account,throughDate,clock));
 return {...value,omittedParents};
}
function createOmittedParentLedgerReader({access,readFence,now=()=>Date.now()}){
 if([access?.authorize,access?.resolveClient,readFence,now].some(x=>typeof x!=='function'))throw new TypeError('Parent ledger evidence requires native scoped read adapters');
 return async(source,throughDate)=>{
  date(throughDate);if(throughDate<source.period.throughDate||throughDate>require('./business-activity-preview').businessDate(new Date(now())))fail('The parent ledger query must cover this elapsed comparison date.');
  const {omitted}=coverage(source);if(omitted.length>20)fail('Omitted-parent evidence exceeds its twenty-account budget.');
  const scope=source.scope,before=await readFence(scope),actor=await access.authorize(scope,'operations.read'),client=await access.resolveClient(scope),{QBOClient}=require('./qbo-client'),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);timer.unref?.();let attempts=0,failure=null;
  const guard=async()=>{if(failure)throw failure;if(controller.signal.aborted)fail('Omitted-parent observation exceeded its budget.');const current=await access.authorize(scope,'operations.read',{signal:controller.signal}),base='https://'+(scope.environment==='production'?'quickbooks.api.intuit.com':'sandbox-quickbooks.api.intuit.com')+'/v3/company/'+scope.realmId;if(!(client instanceof QBOClient)||client.apiCall!==QBOClient.prototype.apiCall||client.apiBase!==base||client.realmId!==scope.realmId||String(client.connection?._id)!==scope.connectionId||String(client.connection?.userId)!==actor.ownerId||String(client.connection?.realmId)!==scope.realmId||client.connection?.status!=='active'||current.actorId!==actor.actorId||current.ownerId!==actor.ownerId)fail('The exact parent ledger reader changed company or owner.');};
  try{const proofs=[];for(const account of omitted){await guard();const endpoint=endpointFor(account.Id,throughDate),observedAt=new Date(now()).toISOString(),report=await client.apiCall('GET',endpoint,undefined,0,0,{signal:controller.signal,onFailure:error=>{failure||=error;controller.abort();},beforeAttempt:async()=>{await guard();if(++attempts>20)fail('Omitted-parent read attempts exceeded their budget.');}});await guard();const raw={version:1,kind:'exact-parent-ledger-no-data',scope,accountId:account.Id,accountDefinitionHash:hash(account),endpoint,reportHash:hash(report),observedAt,report},proof={...raw,evidenceHash:hash(raw)};validateEmptyParent(proof,source,account,throughDate,now());proofs.push(proof);}
   if(!equal(before,await readFence(scope)))fail('Company activity changed during parent ledger observation.');return proofs;
  }finally{clearTimeout(timer);controller.abort();}
 };
}
module.exports={coverage,accountCoverage,validateEmptyParent,createOmittedParentLedgerReader,endpointFor};
