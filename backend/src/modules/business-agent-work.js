'use strict';
// One list of everything the business needs, split by who must do it. The
// accountant owns everything it can do through governed tools; the owner sees
// only work that genuinely needs a person (consent, a QuickBooks screen, a
// login, an AI key, or a decision the owner reserved).
const ACCOUNTANT='accountant', OWNER='owner';
// Record types the accountant's governed workflows (dated calendar templates and
// same-day activity batches) can create today.
const ACCOUNTANT_ENTITIES=new Set(['Estimate','TimeActivity','Invoice','Payment','Deposit','Bill','BillPayment','PurchaseOrder','SalesReceipt','Purchase','VendorCredit','CreditMemo','RefundReceipt','Transfer','JournalEntry','Customer','Vendor','Item']);
const RESUMABLE=new Set(['stopped','approved','reserved','running','blocked','awaiting-evidence']);
const KNOWN=new Set(['not-published','calendar-stopped','completion-pending','uncertain-write','population-owned','current-operation','history-uncommitted','coordination-paused']);
const AI_ERROR=/AI connection/i;
const featureName=signal=>String(signal.label||signal.key||'feature');
const plural=(count,word)=>count+' '+word+(count===1?'':'s');
const features=list=>list.slice(0,20).map(signal=>({key:signal.key,name:featureName(signal),status:signal.status}));

function coverageSignals(coverage){
  const signals=[];
  for(const area of coverage?.areas||[])for(const signal of area.signals||[])if(['missing','stale'].includes(signal.status))signals.push(signal);
  return signals;
}
function ownOperation(operation,agent){
  const origin=operation?.agentAuthority,grant=agent.grant;
  return Boolean(origin&&grant&&origin.agentId===agent.id&&origin.grantId===grant.id&&origin.authorityHash===grant.authorityHash&&RESUMABLE.has(operation.status));
}

function businessWork({settings,agent,business,sync,coverage=null,activityPolicyHash=null,usage=null}={}){
  settings=settings||{};agent=agent||{};business=business||{};sync=sync||{};
  const items=[],blockers=Array.isArray(business.blockers)?business.blockers:[],codes=new Set(blockers.map(item=>item.code));
  const add=item=>items.push({detail:'',next:'',...item});
  const operation=business.currentOperation,grant=agent.grant,published=!codes.has('not-published');
  // Only a changed published business needs the owner again; new accountant
  // workflows are covered by the standing grant (owner direction 2026-10-29).
  const stale=grant&&business.authorityHash&&grant.authorityHash!==business.authorityHash;

  if(usage?.pause)add({key:'ai-usage-limit',owner:OWNER,state:'needs-owner',title:usage.pause.title,detail:usage.pause.detail+(usage.pause.resetAt?' Reset: '+usage.pause.resetAt+'.':''),action:{kind:'link',href:'/company#ai-usage',label:'View AI usage & limits'}});
  // Things only the owner can do.
  if(!settings.monitoring)add({key:'enable-monitoring',owner:OWNER,state:'needs-owner',title:'Turn on company monitoring',detail:'The app keeps a live copy of the company so the accountant can see what is happening.',action:{kind:'enable-monitoring',label:'Start monitoring'}});
  if(!published)add({key:'publish-business',owner:OWNER,state:'needs-owner',title:'Choose and publish the business',detail:'The accountant needs a published business definition before it can run anything.',action:{kind:'link',href:'/company/manage',label:'Open business setup'}});
  else if(settings.monitoring&&!grant)add({key:'grant-authority',owner:OWNER,state:'needs-owner',title:'Let the accountant run the business',detail:'This is a one-time approval to create accounting records in this company under the published business rules. After this it keeps running on its own, around the clock.',action:{kind:'enable-autonomy',label:'Give authority'}});
  else if(settings.monitoring&&stale)add({key:'renew-authority',owner:OWNER,state:'needs-owner',title:'Approve the accountant’s updated business rules',detail:'The business definition or the kinds of work the accountant can do changed since you approved it. It needs your one-time approval for the new version.',action:{kind:'enable-autonomy',label:'Approve'}});
  else if(settings.monitoring&&!settings.autonomous)add({key:'resume',owner:OWNER,state:'needs-owner',title:'You paused the accountant',detail:'Nothing new happens in the business until you resume it.',action:{kind:'resume',label:'Resume'}});
  if(codes.has('calendar-stopped'))add({key:'calendar-stopped',owner:OWNER,state:'needs-owner',title:'You stopped business activity',detail:'A saved Stop request is holding all accounting work.',action:{kind:'link',href:'/company/manage',label:'Review the stop'}});
  if(AI_ERROR.test(agent.lastError||''))add({key:'ai-connection',owner:OWNER,state:'needs-owner',title:'Fix the AI connection',detail:'The accountant could not reach its AI model on its last review.',action:{kind:'link',href:'/settings',label:'Open settings'}});

  // The accountant's own work.
  const running=Boolean(settings.monitoring&&settings.autonomous&&grant&&!stale&&!usage?.pause);
  if(settings.monitoring&&sync.status&&sync.status!=='current')add({key:'catch-up',owner:ACCOUNTANT,state:'working',title:'Catching up with QuickBooks',detail:'Reading the latest company changes. Accounting work waits until every record type is current.',next:'Continues automatically.'});
  const resumable=codes.has('current-operation')&&ownOperation(operation,agent);
  if(codes.has('population-owned')||codes.has('history-uncommitted')||(codes.has('current-operation')&&!resumable)){
    const imported=business.populationStatus==='populated'&&(codes.has('population-owned')||codes.has('history-uncommitted'));
    const records=Number.isFinite(business.recordCount)?business.recordCount.toLocaleString('en-CA')+' ':'';
    add(imported
      ?{key:'adopt-history',owner:ACCOUNTANT,state:'blocked',title:'Take ownership of the existing '+records+'records',detail:'An earlier bulk import filled the company with history'+(business.recordsThrough?' through '+business.recordsThrough:'')+'. Before new activity, the accountant has to check that history and adopt it as its starting point'+(operation&&!resumable?', including the import’s unfinished first operation':'')+'.',next:'The accountant cannot adopt imported history yet; this capability is being built.',capability:'history-adoption',href:'/company/manage'}
      :{key:'settle-operations',owner:ACCOUNTANT,state:'blocked',title:'Settle existing business operations',detail:'Earlier history or an operation started outside the accountant is still open'+(operation?.lastError?': '+operation.lastError:'.'),next:'The accountant cannot settle work it did not start yet; this capability is being built.',capability:'history-adoption',href:'/company/manage'});
  }
  // A blocked operation is not progressing; say so instead of showing it as work in progress.
  const stuck=operation?.status==='blocked';
  if(resumable)add({key:'continue-operation',owner:ACCOUNTANT,state:stuck?'blocked':running?'working':'waiting',title:'Finish its interrupted accounting work',detail:operation.lastError||'An operation it started stopped part-way.',next:stuck?'Stopped part-way. The accountant retries on each review, without sending anything twice.':running?'Resumes it on the next review, without sending anything twice.':'Resumes once the accountant is running.'});
  const recovery={'uncertain-write':['Settle a request that may already be in QuickBooks','A request may have been saved without confirmation. It must be checked in QuickBooks, never resent.','uncertain-write-recovery'],'completion-pending':['Finish closing a completed period','A period finished but its completion record still needs settling.','completion-recovery'],'coordination-paused':['Restore write coordination','Company write coordination is paused.','coordination-recovery']};
  for(const [code,[title,detail,capability]] of Object.entries(recovery))if(codes.has(code))add({key:code,owner:ACCOUNTANT,state:'blocked',title,detail,next:'Needs a recovery capability that is being built.',capability,href:'/company/manage'});
  // Same-day activity collects and pays adopted obligations once the owner has approved
  // the activity rules that include them.
  if(published)add({key:'receive-purchase-orders',owner:ACCOUNTANT,state:stale||!running?'waiting':'working',title:'Receive open purchase orders into supplier bills',detail:'Receives wholly unreceived purchase orders created by its own workflows or adopted import, in full at their original inventory cost. Partially received orders are unavailable.',next:stale?'Starts after you approve the accountant’s updated business rules.':running?'Checks open receiving choices as stock arrives.':'Starts once the accountant is running.',capability:'purchase-order-receiving'});
  if(published)add({key:'correct-own-records',owner:ACCOUNTANT,state:stale||!running?'waiting':'working',title:'Correct its own mistakes',detail:'Reverses its own earlier records dated today when they were wrong: a full credit applied to an unpaid service invoice, a refund of a fully collected service sale, a supplier credit applied to an unpaid operating bill, or the exact reverse of a journal entry, at the original tax rate. Originals are never edited, and each record is corrected at most once.',next:stale?'Starts after you approve the accountant’s updated business rules.':running?'Checks its recent records for mistakes as part of daily activity.':'Starts once the accountant is running.'});
  if(business.adoptedThrough)add({key:'inherited-obligations',owner:ACCOUNTANT,state:stale||!running?'waiting':'working',title:'Settle invoices and bills left open by the imported history',detail:'History through '+business.adoptedThrough+' was adopted from an import. The calendar does not collect or pay its open customer invoices and supplier bills; the accountant settles them as part of daily activity.',next:stale?'Starts after you approve the accountant’s updated business rules.':running?'Collects and pays them as customers pay and bills fall due.':'Starts once the accountant is running.',capability:'adopted-obligations'});
  for(const blocker of blockers)if(!KNOWN.has(blocker.code))add({key:'blocker-'+(blocker.code||'unknown'),owner:ACCOUNTANT,state:'blocked',title:blocker.title||'Business work is held',detail:blocker.detail||'',next:'Retried on the next review.',href:blocker.href||'/company/manage'});

  const clear=!items.some(item=>item.state==='blocked'||item.state==='needs-owner');
  if(coverage){
    const signals=coverageSignals(coverage),manual=signals.filter(signal=>signal.fill==='quickbooks');
    const own=signals.filter(signal=>signal.fill!=='quickbooks'&&ACCOUNTANT_ENTITIES.has(signal.entity)),later=signals.filter(signal=>signal.fill!=='quickbooks'&&!ACCOUNTANT_ENTITIES.has(signal.entity));
    const checked=coverage.asOf?' Feature check from '+coverage.asOf+'.':'';
    if(own.length)add({key:'use-features',owner:ACCOUNTANT,state:running&&clear?'working':'waiting',title:'Put '+plural(own.length,'QuickBooks feature')+' to use',detail:'Next: '+own.slice(0,3).map(featureName).join(', ')+'.'+checked,next:running&&clear?'Works these into upcoming business activity.':'Starts once the work above is done.',features:features(own)});
    if(later.length)add({key:'new-workflows',owner:ACCOUNTANT,state:'blocked',title:plural(later.length,'feature')+' need new kinds of business activity',detail:'The accountant has no workflow that creates these yet. Next: '+later.slice(0,3).map(featureName).join(', ')+'.'+checked,next:'These workflows are being built.',capability:'more-workflows',features:features(later)});
    if(manual.length)add({key:'manual-features',owner:OWNER,state:'optional',title:plural(manual.length,'feature')+' can only be set up in QuickBooks',detail:'QuickBooks does not let apps do these. Next: '+manual.slice(0,3).map(featureName).join(', ')+'.',action:{kind:'link',href:'/coverage',label:'See how'},features:features(manual)});
  }else add({key:'check-features',owner:ACCOUNTANT,state:'waiting',title:'Check which QuickBooks features are in use',detail:'No feature check is available since the server started.',next:'Appears after the next feature check on the Coverage page.',href:'/coverage'});

  const needsOwner=items.filter(item=>item.owner===OWNER&&item.state==='needs-owner'),blocked=items.filter(item=>item.owner===ACCOUNTANT&&item.state==='blocked');
  const headline=needsOwner.length?(needsOwner.length===1?'One thing needs you: '+needsOwner[0].title.charAt(0).toLowerCase()+needsOwner[0].title.slice(1)+'.':needsOwner.length+' things need you.'):!running?'Nothing needs you right now. The accountant is not running yet.':blocked.length?'Nothing needs you. The accountant is running the business; some work waits for capabilities still being built.':'Nothing needs you. The accountant is running the business.';
  return {headline,needsOwner:needsOwner.length,items};
}

module.exports={businessWork,coverageSignals,ACCOUNTANT_ENTITIES,ACCOUNTANT,OWNER};
