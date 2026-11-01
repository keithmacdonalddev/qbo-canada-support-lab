'use strict';
const {hash}=require('./business-calendar');
const STATES=['open','in-progress','resolved','reopened'];
function fold(events=[]){
  const entries=new Map();
  for(const row of [...events].sort((a,b)=>String(a.at||'').localeCompare(String(b.at||''))||String(a.id||'').localeCompare(String(b.id||'')))){
    if(!row.key)continue;
    if(row.kind==='capability-request')entries.set(row.key,{...entries.get(row.key),...row,status:row.status||'open',history:entries.get(row.key)?.history||[]});
    if(row.kind==='capability-review'&&entries.has(row.key)&&STATES.includes(row.status)){
      const prior=entries.get(row.key);entries.set(row.key,{...prior,...row,id:prior.id,kind:'capability-request',history:[...prior.history,{id:row.id,at:row.at,status:row.status,evidence:row.evidence,remainingGap:row.remainingGap}].slice(-12)});
    }
  }
  return [...entries.values()];
}
function reviewEvent(input,prior,{verified=false}={}){
  if(!prior||!STATES.includes(input.status))throw new Error('Choose an existing build request and a supported status.');
  const evidence=(input.evidence||[]).slice(0,10).map(e=>String(e).trim().slice(0,300)).filter(Boolean);
  if(input.status==='resolved'&&!evidence.length)throw new Error('Resolution requires retained evidence or a code commit; code availability does not prove a business outcome.');
  const data={key:prior.key,status:input.status,remainingGap:String(input.remainingGap||'').slice(0,600),evidence,availableTools:(input.availableTools||[]).slice(0,12),outcomeVerified:verified&&input.outcomeVerified===true};
  return {title:'Build review: '+prior.key,detail:data.remainingGap||'Capability checked against current evidence.',data,key:'capability-review:'+hash({data,previous:prior.history?.at(-1)?.id||prior.id})};
}
// Release evidence is code availability, never a claim that a QBO situation was created.
const RELEASES={
 'published-item-fingerprint-validation-repair':{commit:'ac17891',operation:'3359607d8aee4df04a3d88da'},
 'linked-invoice-receivables-verification-recovery':{commit:'50868c8',operation:'b2cbf83dd9a354dcee95e6d4'},
 'added-customer-fingerprint-validation-repair':{commit:'707e387 / 900a5a7',customers:['141','142','143']},
 'general-write-dated-sales-tax-policy':{commit:'81af99a',module:'general-write-service',tools:['manageQboRecord']},
 'management-context-readback':{commit:'ac17891',tools:['getManagementReview']},
 'terms-partial-settlement-schema':{commit:'6dbcd6d',tools:['prepareBusinessActivity']},
 'foreign-currency-bills':{commit:'24ab294',module:'general-write-service',tools:['manageQboRecord']},
 'close-checklist-evidence':{commit:'6c3d85c',tools:['getCloseChecklist','recordCloseChecklistEvidence']},
 'billable-expense-invoicing':{commit:'aeb6a14',module:'billable-charge-links',tools:['manageQboRecord']},
 'weekly-feature-breadth':{commit:'ee9b053',tools:['getCoverageSituations','getWeeklyCoverage']},
 'scoped-operation-lookup-by-decision-key':{tools:['findBusinessOperation']},
 'retained-request-scope-inspection-repair':{tools:['findBusinessOperation']},
};
async function reconcile({requests,checks,models,scope,toolNames,event}){
  const current=fold(requests);
  for(const prior of current){
    const release=RELEASES[prior.key];if(!release)continue;
    if(prior.status==='reopened'&&!release.operation&&!release.customers)continue;
    let passed=false,outcomeVerified=false,evidence=[];
    if(release.operation){const run=await models.Runs.findOne({...scope,_id:release.operation}).select('status verification recordCount createdBy').maxTimeMS(3000).lean();passed=run?.status==='verified'&&Boolean(run.verification?.evidenceHash);if(passed){try{await require('./business-stock-history').committedReceipt(models,scope,String(run.createdBy||checks.ownerId),release.operation,null);outcomeVerified=true;}catch{outcomeVerified=false;evidence.push('Stored verified status observed; independent completion proof unavailable to this check.');}}if(passed)evidence.push('Verified operation '+release.operation+'; '+run.recordCount+' records; evidence '+run.verification.evidenceHash);}
    else if(release.customers){passed=release.customers.every(id=>checks.roles.some(r=>r.entity==='Customer'&&r.id===id&&r.status==='passed'));if(passed)evidence.push('Authenticated creation definitions pass for Customers '+release.customers.join(', ')+' at '+checks.checkedAt);}
    else {passed=(release.tools||[]).every(t=>toolNames.includes(t));if(passed&&release.module){try{require('./'+release.module);}catch{passed=false;}}if(passed)evidence.push('Current callable tools: '+release.tools.join(', ')+'. Capability available; actual QBO outcome still requires governed execution.');}
    if(passed){if(release.commit)evidence.push('Implementation commit '+release.commit);const value=reviewEvent({status:'resolved',evidence,availableTools:release.tools||[],outcomeVerified},prior,{verified:outcomeVerified});if(prior.status!=='resolved')await event(value);}
    else if(prior.status==='resolved')await event(reviewEvent({status:'reopened',evidence:['Current capability check did not pass at '+checks.checkedAt],remainingGap:'Recheck the current tool/operation/definition; do not use an earlier resolution as current evidence.'},prior));
  }
}
module.exports={STATES,fold,reviewEvent,reconcile,RELEASES};
