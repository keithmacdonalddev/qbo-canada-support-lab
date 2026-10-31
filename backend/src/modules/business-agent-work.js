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
// Business dates are saved as YYYY-MM-DD; show them as e.g. "Oct 29" without timezone drift.
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const shortDate=value=>{const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value||'');return match&&MONTHS[Number(match[2])-1]?MONTHS[Number(match[2])-1]+' '+Number(match[3]):null;};
const money=cents=>(Number(cents||0)/100).toLocaleString('en-CA',{style:'currency',currency:'CAD'});
const latest=(...rows)=>{const text=shortDate(rows.map(row=>row?.last).filter(Boolean).sort().at(-1));return text?' · last '+text:'';};
// Plain facts from saved, verified work: facts.done[type]={count,last,cents}; facts.open
// (optional) is what the latest company copy still shows open. Missing facts omit the line.
function dutyFacts(key,facts){
  if(!facts?.done)return null;
  const row=type=>facts.done[type]||{count:0,last:null,cents:0};
  if(key==='receive-purchase-orders'){const r=row('receive-purchase-order');return r.count?'Received '+plural(r.count,'purchase order')+latest(r):'Nothing received yet';}
  if(key==='correct-own-records'){const r=row('correct-own-record');return r.count?'Corrected '+plural(r.count,'record')+latest(r):'No corrections made yet';}
  if(key==='inherited-obligations'){
    const invoices=row('collect-adopted-invoice'),bills=row('pay-adopted-bill'),parts=[];
    if(invoices.count)parts.push('collected '+plural(invoices.count,'invoice')+' ('+money(invoices.cents)+')');
    if(bills.count)parts.push('paid '+plural(bills.count,'bill')+' ('+money(bills.cents)+')');
    let text=parts.length?parts.join(' and ')+latest(invoices,bills):'nothing collected or paid yet';
    text=text.charAt(0).toUpperCase()+text.slice(1);
    const open=facts.open;
    if(open){
      const left=[open.invoices?.count?plural(open.invoices.count,'invoice')+' ('+money(open.invoices.cents)+')':'',open.bills?.count?plural(open.bills.count,'bill')+' ('+money(open.bills.cents)+')':''].filter(Boolean);
      text+=left.length?' · Still open: '+left.join(' and '):' · Nothing left open';
    }
    return text;
  }
  return null;
}
// Something is happening right now: an operation that is executing its records.
const IN_PROGRESS=new Set(['running','committing']);
const operationActive=operation=>Boolean(operation&&(IN_PROGRESS.has(operation.status)||operation.executionPending===true));
function ownOperation(operation,agent){
  const origin=operation?.agentAuthority,grant=agent.grant;
  return Boolean(origin&&grant&&origin.agentId===agent.id&&origin.grantId===grant.id&&origin.authorityHash===grant.authorityHash&&RESUMABLE.has(operation.status));
}

// "Today (Fri Oct 30): 20 planned · 7 in QuickBooks · 3 in progress" from counted native create receipts.
function todayLine(today){
  if(!today||!today.label)return null;
  if(today.unavailable)return 'Today ('+today.label+'): '+(today.target?today.target+' planned · ':'')+'count unavailable right now';
  if(!today.target)return 'Today ('+today.label+'): closed'+(today.saved?' · '+today.saved+' in QuickBooks':'');
  return 'Today ('+today.label+'): '+today.target+' planned · '+today.saved+' in QuickBooks'+(today.verified<today.saved?' ('+today.verified+' verified)':'')+(today.reserved?' · '+today.reserved+' in progress':'');
}
// Cadence kinds that mean the accountant is working now or straight after the current review.
const CONTINUOUS=new Set(['slice','obligations','recovery','catch-up','management','owner','poll']);
const halifaxTime=value=>require('./business-agent-cadence').localTime(value);
function businessWork({settings,agent,business,sync,coverage=null,activityPolicyHash=null,usage=null,facts=null,today=null,calendarClose=null,cadence=null,owned=[],requests=null}={}){
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
  // The only spinner states: sync not yet current, or an operation that is executing. A review in
  // progress is shown by rightNow() above this list. Enabled duties are 'on-duty' (no animation).
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
  const active=operationActive(operation);
  if(resumable)add({key:'continue-operation',owner:ACCOUNTANT,state:stuck?'blocked':running&&active?'working':'waiting',title:'Finish its interrupted accounting work',detail:operation.lastError||'An operation it started stopped part-way.',next:stuck?'Stopped part-way. The accountant retries on each review, without sending anything twice.':running&&active?'Sending its records to QuickBooks now, without sending anything twice.':running?'Resumes it on the next review, without sending anything twice.':'Resumes once the accountant is running.'});
  const recovery={'uncertain-write':['Settle a request that may already be in QuickBooks','A request may have been saved without confirmation. It must be checked in QuickBooks, never resent.','uncertain-write-recovery'],'completion-pending':['Finish closing a completed period','A period finished but its completion record still needs settling.','completion-recovery'],'coordination-paused':['Restore write coordination','Company write coordination is paused.','coordination-recovery']};
  for(const [code,[title,detail,capability]] of Object.entries(recovery))if(codes.has(code))add({key:code,owner:ACCOUNTANT,state:'blocked',title,detail,next:'Needs a recovery capability that is being built.',capability,href:'/company/manage'});
  // Standing duties carried out by same-day activity under the approved rules. A duty
  // spins only while the current operation is actually carrying out that kind of work.
  const doingNow=types=>running&&active&&(operation?.activityBatch?.types||[]).some(type=>types.includes(type));
  const duty=(key,types,item,idle)=>{
    const now=doingNow(types),summary=dutyFacts(key,facts);
    add({key,owner:ACCOUNTANT,state:stale||!running?'waiting':now?'working':'on-duty',...item,next:stale?'Starts after you approve the accountant’s updated business rules.':!running?'Starts once the accountant is running.':now?'Doing this now in the current operation.':idle,...(summary?{facts:summary}:{})});
  };
  if(published)duty('receive-purchase-orders',['receive-purchase-order'],{title:'Receive open purchase orders into supplier bills',detail:'Receives wholly unreceived purchase orders created by its own workflows or adopted import, in full at their original inventory cost. Partially received orders are unavailable.',capability:'purchase-order-receiving'},'Looks for open orders to receive at each business review.');
  if(published)duty('own-receivables-payables',['invoice-on-terms','collect-own-invoice','bill-on-terms','pay-own-bill','send-estimate','convert-own-estimate','order-stock'],{title:'Run sales and purchases over time',detail:'Invoices customers and records supplier bills on payment terms, leaves them open until they fall due, and later collects or pays them in full or in part. Sends estimates and converts accepted ones into invoices, and orders stock for later receiving.'},'Raises, collects and pays open invoices and bills at each business review.');
  if(published)duty('correct-own-records',['correct-own-record'],{title:'Correct its own mistakes',detail:'Reverses its own earlier records dated today when they were wrong: a full credit applied to an unpaid service invoice, a refund of a fully collected service sale, a supplier credit applied to an unpaid operating bill, or the exact reverse of a journal entry, at the original tax rate. Originals are never edited, and each record is corrected at most once.'},'Checks its recent records for mistakes at each business review.');
  // Approved work that holds no calendar slot (for example, approval saved but queueing failed).
  // Unsent work outside the slot is retired automatically and is not shown.
  const pending=(Array.isArray(owned)?owned:[]).filter(run=>run&&run.disposition!=='unsent'&&run.operationId!==operation?.operationId&&grant&&run.agentAuthority?.agentId===agent.id&&run.agentAuthority?.grantId===grant.id);
  const stranded=pending.some(run=>run.disposition==='stranded');
  if(pending.length)add({key:'finish-approved',owner:ACCOUNTANT,state:stranded?'blocked':!running?'waiting':pending.some(run=>run.executionPending||IN_PROGRESS.has(run.status))?'working':'waiting',title:'Finish approved accounting work',
    detail:plural(pending.length,'approved operation')+' not finished yet ('+pending.slice(0,3).map(run=>run.status+(run.day?' for '+shortDate(run.day):'')).join(', ')+'). New periods and batches wait until it is done.',
    next:stranded?'It stopped after saving records outside the business calendar. Continuing it needs a recovery capability that is being built; nothing is sent twice.':running?'Resumes it at the next review, without sending anything twice.':'Resumes once the accountant is running.',...(stranded?{capability:'stranded-recovery',href:'/company/manage'}:{})});
  // Calendar catch-up and today's activity (continuous-business plan v2 §3b–§3c).
  const nextAt=cadence?.nextReviewAt?halifaxTime(cadence.nextReviewAt):null,held=cadence?.kind==='held'||cadence?.kind==='ceiling';
  if(published&&calendarClose){
    const closed=shortDate(business.verifiedThrough),closing=shortDate(calendarClose.fromDate)+(calendarClose.throughDate!==calendarClose.fromDate?'–'+shortDate(calendarClose.throughDate):'');
    add({key:'close-calendar',owner:ACCOUNTANT,state:!running?'waiting':held?'blocked':'on-duty',title:'Close the business calendar through yesterday',
      detail:(closed?'Calendar closed through '+closed:'Calendar not closed yet')+' · closing '+closing+(calendarClose.behindDays>1?' ('+plural(calendarClose.behindDays,'day')+' behind)':'')+'. Each period closes within one calendar month, on its seven-report evidence, including days with no scheduled activity.',
      next:!running?'Starts once the accountant is running.':(cadence?.reason?cadence.reason.charAt(0).toUpperCase()+cadence.reason.slice(1):'Closes at the next review')+(nextAt?' · next try '+nextAt:'')+'.'});
  }
  if(published&&today){
    const due=today.dueSlot,line=todayLine(today);
    const detail=today.unavailable?'Today’s count could not be read; same-day activity waits for the next review.'
      :!today.target?'No same-day activity is planned for this day. Obligations and corrections continue.'
      :calendarClose?'Same-day activity starts once the calendar is closed through yesterday.'
      :today.ceilingReached?'Today’s ceiling of '+today.ceiling+' records is reached. Same-day activity resumes tomorrow.'
      :requests?.reached&&today.remaining>0?(reason=>reason.charAt(0).toUpperCase()+reason.slice(1)+'.')(require('./business-agent-cadence').requestBudgetReason(requests))
      :due?'Working continuously: today is '+plural(Number.isSafeInteger(today.behind)?today.behind:due.records,'record')+' behind schedule; the next batch of about '+plural(due.records,'record')+' of genuine business work runs now.'
      :today.remaining===0?'Today’s target is met.'
      :today.hourResetAt?'Paused: the hourly limit of '+today.hourCap+' new records is reached. Work continues at '+halifaxTime(today.hourResetAt)+'.'
      :today.nextSlotAt?'On schedule. More work is due at '+halifaxTime(today.nextSlotAt)+'.':'Today’s schedule is complete; any shortfall is not replayed.';
    add({key:'todays-activity',owner:ACCOUNTANT,state:stale||!running?'waiting':doingNow(['settled-service-sale','paid-operating-expense','paid-cash-expense','supplier-credit','customer-credit','customer-refund','bank-transfer','journal-entry'])?'working':'on-duty',title:'Run today’s business activity',...(line?{facts:line}:{}),detail,
      next:stale?'Starts after you approve the accountant’s updated business rules.':!running?'Starts once the accountant is running.':CONTINUOUS.has(cadence?.kind)?'Working continuously'+(cadence?.reason?' ('+cadence.reason+')':'')+'.':nextAt?'Paused until '+nextAt+(cadence?.reason?': '+cadence.reason:'')+'.':'Works through the day in small batches.'});
  }
  if(business.adoptedThrough)duty('inherited-obligations',['collect-adopted-invoice','pay-adopted-bill'],{title:'Settle invoices and bills left open by the imported history',detail:'History through '+business.adoptedThrough+' was adopted from an import. The calendar does not collect or pay its open customer invoices and supplier bills; the accountant settles them as part of daily activity.',capability:'adopted-obligations'},'Collects and pays them at business reviews as customers pay and bills fall due.');
  for(const blocker of blockers)if(!KNOWN.has(blocker.code))add({key:'blocker-'+(blocker.code||'unknown'),owner:ACCOUNTANT,state:'blocked',title:blocker.title||'Business work is held',detail:blocker.detail||'',next:'Retried on the next review.',href:blocker.href||'/company/manage'});

  const clear=!items.some(item=>item.state==='blocked'||item.state==='needs-owner');
  if(coverage){
    const signals=coverageSignals(coverage),manual=signals.filter(signal=>signal.fill==='quickbooks');
    const own=signals.filter(signal=>signal.fill!=='quickbooks'&&ACCOUNTANT_ENTITIES.has(signal.entity)),later=signals.filter(signal=>signal.fill!=='quickbooks'&&!ACCOUNTANT_ENTITIES.has(signal.entity));
    const checked=coverage.asOf?' Feature check from '+coverage.asOf+'.':'';
    if(own.length)add({key:'use-features',owner:ACCOUNTANT,state:running&&clear?'on-duty':'waiting',title:'Put '+plural(own.length,'QuickBooks feature')+' to use',detail:'Next: '+own.slice(0,3).map(featureName).join(', ')+'.'+checked,next:running&&clear?'Works these into upcoming business activity.':'Starts once the work above is done.',features:features(own)});
    if(later.length)add({key:'new-workflows',owner:ACCOUNTANT,state:'blocked',title:plural(later.length,'feature')+' need new kinds of business activity',detail:'The accountant has no workflow that creates these yet. Next: '+later.slice(0,3).map(featureName).join(', ')+'.'+checked,next:'These workflows are being built.',capability:'more-workflows',features:features(later)});
    if(manual.length)add({key:'manual-features',owner:OWNER,state:'optional',title:plural(manual.length,'feature')+' can only be set up in QuickBooks',detail:'QuickBooks does not let apps do these. Next: '+manual.slice(0,3).map(featureName).join(', ')+'.',action:{kind:'link',href:'/coverage',label:'See how'},features:features(manual)});
  }else add({key:'check-features',owner:ACCOUNTANT,state:'waiting',title:'Check which QuickBooks features are in use',detail:'No feature check is available since the server started.',next:'Appears after the next feature check on the Coverage page.',href:'/coverage'});

  const needsOwner=items.filter(item=>item.owner===OWNER&&item.state==='needs-owner'),blocked=items.filter(item=>item.owner===ACCOUNTANT&&item.state==='blocked');
  const headline=needsOwner.length?(needsOwner.length===1?'One thing needs you: '+needsOwner[0].title.charAt(0).toLowerCase()+needsOwner[0].title.slice(1)+'.':needsOwner.length+' things need you.'):!running?'Nothing needs you right now. The accountant is not running yet.':blocked.length?'Nothing needs you. The accountant is running the business; some work waits for capabilities still being built.':'Nothing needs you. The accountant is running the business.';
  return {headline,needsOwner:needsOwner.length,items};
}

// The first non-empty line of a review summary, without markdown markers, for a one-line recap.
function oneLine(text,max=220){
  const line=String(text||'').split(/\r?\n+/).map(part=>part.replace(/^(?:[\s#>*\-•]+|\d+[.)]\s+)+/,'').replace(/[*_`]+/g,'').trim()).find(Boolean)||'';
  return line.length>max?line.slice(0,max-1).trimEnd()+'…':line;
}
const SHOWN_STEPS=8;
// What the accountant is doing at this moment. Times are ISO strings; the page words them.
// state: not-configured | stopped | paused | usage-paused | reviewing | recovering | catching-up | idle
function rightNow({configured=false,settings={},usage=null,reviewing=false,recovering=false,activePass=null,progress=null,nextDecisionAt=null,lastDecisionAt=null,events=[],sync={},today=null,calendarClose=null,cadence=null,requests=null}={}){
  settings=settings||{};
  // Today's counts, why the next review is when it is, and any calendar lag, for the "Today" line.
  const extra={today:today&&today.label?{label:today.label,target:today.target,saved:today.saved??null,verified:today.verified??null,reserved:today.reserved??null,ceiling:today.ceiling,ceilingReached:Boolean(today.ceilingReached),unavailable:Boolean(today.unavailable),line:todayLine(today)}:null,
    cadence:cadence&&cadence.kind?{kind:cadence.kind,reason:String(cadence.reason||'')}:null,
    requests:requests?{used:requests.used,limit:requests.limit,reached:Boolean(requests.reached),unavailable:Boolean(requests.unavailable),scope:requests.scope||null,sync:requests.sync??null,meteredToday:requests.meteredToday??null,meteredMonth:requests.meteredMonth??null,monthlyLimit:requests.monthlyLimit??null,allowance:requests.allowance??null}:null,
    calendar:calendarClose?{closedThrough:shortDate(calendarClose.closedThrough||null)||null,closing:shortDate(calendarClose.fromDate)+(calendarClose.throughDate!==calendarClose.fromDate?'–'+shortDate(calendarClose.throughDate):''),behindDays:calendarClose.behindDays}:null};
  const last=(Array.isArray(events)?events:[]).filter(event=>event&&event.kind==='review-completed').sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')))[0]||null;
  const base={state:'idle',role:null,startedAt:null,nextReviewAt:nextDecisionAt||null,lastReviewAt:last?.at||lastDecisionAt||null,lastSummary:last?oneLine(last.detail):'',steps:[],earlierSteps:0,pause:null,...extra};
  if(!configured)return {...base,state:'not-configured',nextReviewAt:null};
  if(!settings.monitoring)return {...base,state:'stopped',nextReviewAt:null};
  if(reviewing&&activePass){
    const own=Boolean(progress&&progress.passId===activePass.id);
    const steps=own?require('./business-agent-progress').cleanSteps(progress.steps):[];
    return {...base,state:'reviewing',role:activePass.role||'accountant',startedAt:(own&&progress.startedAt)||activePass.startedAt||null,steps:steps.slice(-SHOWN_STEPS).reverse(),earlierSteps:Math.max(0,steps.length-SHOWN_STEPS)};
  }
  if(!settings.autonomous)return {...base,state:'paused',nextReviewAt:null};
  if(usage?.pause)return {...base,state:'usage-paused',nextReviewAt:usage.pause.resetAt||null,pause:{title:String(usage.pause.title||''),resetAt:usage.pause.resetAt||null}};
  if(recovering)return {...base,state:'recovering'};
  if(sync?.status&&sync.status!=='current')return {...base,state:'catching-up'};
  return base;
}

module.exports={businessWork,rightNow,oneLine,dutyFacts,todayLine,coverageSignals,ACCOUNTANT_ENTITIES,ACCOUNTANT,OWNER};
