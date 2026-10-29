'use strict';
const { hash, canonical, shift } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const C = require('./period-close-contract');
const R = require('./report-evidence-contract');
const { validatePeriodDecision } = require('./period-close-proof');
const { createPeriodCloseReader, validateObservation, eligible } = require('./period-close-reader');
const { createContextService } = require('./rebuild-context');
const { createDefinitionsService } = require('./rebuild-definitions');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessTransaction } = require('./business-transaction');
const { fenceBusinessOwner } = require('./business-owner-fence');
const { assertPeriodControl } = require('./qbo-write-period');
const { companyActiveWork } = require('./company-active-work');
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const clone = value => JSON.parse(canonical(value));
const cutoff = (...values) => values.filter(Boolean).sort().at(-1) || null;
function createPeriodCloseService(dependencies = {}) {
  const connection = dependencies.connection || require('mongoose').connection;
  const models = dependencies.models || Object.fromEntries(Object.entries({ Users:'User', Connections:'Connection', Memberships:'CompanyMembership', Policies:'CompanyWritePolicy', Writers:'CompanyWriter', Calendars:'BusinessCalendar', Runs:'OperationRun', Steps:'OperationStep', Receipts:'QboWriteReceipt', Audits:'AuditLog' }).map(([key,name]) => [key,require('../models/' + name)]));
  const resolve = dependencies.resolveContext || createContextService().resolve, definitions = dependencies.definitions || createDefinitionsService();
  const transaction = dependencies.transaction || createBusinessTransaction(connection), accessFor = dependencies.accessFor || createBusinessRuntimeAccess, now = dependencies.now || (() => Date.now());
  const budget = () => ({ queries:0, deadline:Date.now()+8000 });
  function admit(b) { if (b && (++b.queries > 80 || Date.now() > b.deadline)) C.fail('Saved period evidence exceeded its read budget. Retry the exact inspection.'); }
  const read = (Model, filter, session, b) => { admit(b); return Model.findOne(filter).session(session).maxTimeMS(3000).lean(); };
  const critical = () => definitions.listReports({ offset:0, limit:1000 }).items.filter(row => row.tier === 'critical').sort((a,b) => a.key.localeCompare(b.key));
  function input(value) {
    C.bounded(value, 97000);
    if (!C.exact(value, ['request','reviewHash']) || !C.HASH.test(value.reviewHash || '')) C.fail('Confirm the exact reviewed accounting-period decision.',400);
    return value;
  }
  async function bind(user, action = 'periods.read', ownerOnly = false) {
    const ownerId=String(user.id), actorId=String(user.actorId || user.id), context=await resolve(user);
    if (!context.connection?.connected) C.fail('Connect the company before inspecting its period evidence.');
    const scope=scoped({realmId:context.connection.realmId,environment:context.environment,connectionId:context.connection.connectionId}), access=accessFor({...models,ownerId,actorId});
    await access.authorize(scope,action);
    if (ownerOnly && actorId!==ownerId) C.fail('Only the connected company owner can make period decisions.',403);
    return {scope,ownerId,actorId,access,companyName:context.connection.companyName};
  }
  async function ready(bound, session) {
    if (dependencies.assertReady) return dependencies.assertReady(bound,session);
    const setup=require('./business-storage-setup');
    await setup.assertProfileSetupCompleted(connection.db,{...bound.scope,ownerId:bound.ownerId},'continual-business',session);
    if (!session && (await setup.inspectStorage(connection.db,'continual-business')).some(row=>row.create || row.missingIndexes.length)) C.fail('Restore the reviewed business storage before recording a period decision.');
  }
  async function fence(bound,session) { await fenceBusinessOwner({...bound,models,session,action:'periods.manage'}); await ready(bound,session); }
  function revision(value) { return Number.isSafeInteger(value) && value>=0 && value<MAX_REVISION; }
  async function state(bound,session,b=budget()) {
    const company={environment:bound.scope.environment,realmId:bound.scope.realmId};
    const policy=await read(models.Policies,company,session,b),writer=await read(models.Writers,company,session,b),calendar=await read(models.Calendars,company,session,b);
    if (!policy || !writer || policy.contractVersion!==1 || writer.contractVersion!==1 || !['preparing','active'].includes(policy.state) || [policy,writer,...(calendar?[calendar]:[])].some(row=>String(row.connectionId)!==bound.scope.connectionId || !revision(row.revision)) || (calendar && (!revision(calendar.authorityRevision) || !revision(calendar.writerRevision)))) C.fail('Prepare or restore exact company write coordination before reviewing a period.');
    assertPeriodControl(policy.periodControl,bound.scope,bound.ownerId);
    return {policy,writer,calendar};
  }
  function stateView(value) {
    const {policy,writer,calendar}=value;
    return {policyId:String(policy._id),policyRevision:policy.revision,policyState:policy.state,periodControl:clone(policy.periodControl),writerId:String(writer._id),writerRevision:writer.revision,
      calendar:calendar?{id:String(calendar._id),revision:calendar.revision,writerRevision:calendar.writerRevision,authorityRevision:calendar.authorityRevision,authorityHash:calendar.authorityHash || null,verifiedThrough:calendar.verifiedThrough,openingDate:calendar.openingDate,stopRequested:calendar.stopRequested}:null};
  }
  async function idle(bound,value,session,b) {
    const company={environment:bound.scope.environment,realmId:bound.scope.realmId};
    if (value.writer.operationId!==null || value.writer.planHash!==null || value.writer.unresolved!==null || (value.calendar && (value.calendar.currentOperationId!==null || value.calendar.pendingCommit))) C.fail('Finish current work and settle uncertain requests before a period decision.');
    if (await read(models.Runs,{...company,status:{$nin:['verified','retired']}},session,b) || await read(models.Steps,{...company,state:{$nin:['verified']}},session,b) || await read(models.Receipts,{...company,state:{$in:['possibly-sent','unknown']}},session,b)) C.fail('Finish or retire every unfinished business plan and recover uncertain company records first.');
    const other=dependencies.activeWork ? await dependencies.activeWork(bound.scope,session) : await companyActiveWork(connection.db,bound.scope,{session});
    if (other.length) C.fail('Finish earlier legacy or master-record company work first.');
  }
  function auditFilter(bound,id) { return {_id:id,userId:bound.ownerId,realmId:bound.scope.realmId}; }
  async function reportSource(bound,selection,period,session,b) {
    const row=await read(models.Audits,auditFilter(bound,selection.id),session,b);
    if (!row) C.fail('A selected manual report source is missing.');
    const p=R.validateObservation(row,bound.scope,bound.ownerId), withdrawn=await read(models.Audits,auditFilter(bound,R.withdrawalId(selection.id)),session,b);
    if (withdrawn) { R.validateWithdrawal(withdrawn,bound.scope,bound.ownerId); C.fail('A selected manual report check was withdrawn. Review its replacement.'); }
    const definition=critical().find(value=>value.key===selection.key);
    if (!definition || p.request.reportKey!==selection.key || row.afterState.evidenceHash!==selection.evidenceHash || p.definitionHash!==hash(definition) || !C.same(p.request.period,period) || p.request.basis!=='Accrual' || !['no additional filters','no filters','all company, no filters'].includes(p.request.filters.trim().toLowerCase()) || p.request.observedOn<period.throughDate || Date.parse(p.recordedAt)>now()) C.fail('Close sources must use current critical definitions, this exact elapsed Accrual period and explicit full-company filters.');
    const checks=[...R.LEVELS.map(key=>({label:key,...p.request.checks[key]})),...p.request.assertions.map((check,index)=>({label:p.definition.assertions[index],status:check.status,note:check.note}))];
    const mandatory=['report.balance-sheet','report.trial-balance'].includes(selection.key);
    const acceptable=checks.every(check=>check.status==='passed' || (!mandatory && check.status==='not-applicable'));
    return {key:selection.key,id:selection.id,evidenceHash:selection.evidenceHash,requestHash:p.requestHash,definitionHash:p.definitionHash,name:p.definition.name,observedOn:p.request.observedOn,acceptable,checks};
  }
  async function inspect(bound,request,{session,observations,signal}={}) {
    C.validateRequest(request,bound.scope,now()); await ready(bound,session);
    const b=budget(), current=await state(bound,session,b); await idle(bound,current,session,b);
    if (!observations) observations=await (dependencies.readObservations || createPeriodCloseReader({access:bound.access,now}))(bound.scope,{signal,preferencesOnly:request.mode==='reopen'});
    validateObservation(observations,bound.scope);
    if (now()<Date.parse(observations.startedAt) || now()-Date.parse(observations.startedAt)>180000 || Date.parse(observations.observedAt)>now() || signal?.aborted) C.fail('Current account/preferences evidence expired. Review the decision again.');
    const again=await state(bound,session,b);
    if (!C.same(stateView(current),stateView(again))) C.fail('Company protection or activity changed during the account review.');
    const before=current.policy.periodControl, after={closedThrough:before.closedThrough,reconciledThrough:before.reconciledThrough}, blockers=[],exceptions=[],reports=[];
    let banks=[];
    if (request.mode==='reopen') {
      if (request.previousControlHash!==before.contentHash) C.fail('The original app protection changed. Review both cutoffs again.');
      let lower=false;
      for (const key of ['closedThrough','reconciledThrough']) {
        const previous=before[key],next=request[key];
        if ((!previous && next) || (previous && next && next>previous)) C.fail('Reopening may only lower the exact reviewed app cutoffs.');
        if (previous && (!next || next<previous)) lower=true;
        after[key]=next;
      }
      if (!lower) C.fail('Choose an actual reduction in at least one app cutoff.');
    } else {
      if (!observations.accounts || request.accountInventoryHash!==observations.accountInventoryHash) C.fail('The complete current account inventory changed. Recheck each account.');
      banks=C.bankResults(request,eligible(observations.accounts));
      for (const selected of request.reportChecks) reports.push(await reportSource(bound,selected,request.period,session,b));
      if (request.mode==='close') {
        if (before.closedThrough && (request.period.throughDate<=before.closedThrough || request.period.fromDate!==shift(before.closedThrough,1))) blockers.push('The next close must start the day after the existing closed cutoff and advance it.');
        if (current.calendar && (!current.calendar.verifiedThrough || current.calendar.verifiedThrough<request.period.throughDate)) blockers.push('Verify managed business activity through the entire requested close period first.');
        const adoptedThrough=require('./business-calendar').calendarCursor(current.calendar).adoptedThrough;
        if (adoptedThrough && request.period.fromDate<=adoptedThrough) blockers.push('Dates through '+adoptedThrough+' are adopted import history, not verified business activity. Close only periods after that date.');
        const required=critical();
        if (!required.length || required.some(definition=>!reports.some(row=>row.key===definition.key))) blockers.push('Keep a matching manual check for every current critical report ('+required.length+' required).');
        if (reports.some(row=>!row.acceptable)) blockers.push('Every selected report level and assertion must pass; only conditional reports may use explained Not applicable outcomes.');
        if (banks.some(row=>!['passed','excluded'].includes(row.status))) blockers.push('Resolve each bank/card difference or incomplete account before closing.');
        for (const row of banks.filter(row=>row.status==='excluded')) exceptions.push({kind:'account-excluded',key:row.accountId,note:request.bankChecks.find(value=>value.accountId===row.accountId).note});
        for (const report of reports) for (const check of report.checks.filter(row=>row.status==='not-applicable')) exceptions.push({kind:'report-not-applicable',key:report.key,note:check.label+': '+check.note});
        if (request.advanceReconciled && (!banks.length || banks.some(row=>row.status!=='passed'))) blockers.push('Company-wide reconciliation protection needs a zero-difference checked result for every current bank/card account, with no exclusions.');
        after.closedThrough=request.period.throughDate;
        if (request.advanceReconciled) {
          if (before.reconciledThrough && request.period.throughDate<before.reconciledThrough) blockers.push('Closing cannot lower existing reconciliation protection.');
          if (before.reconciledThrough && request.period.fromDate>shift(before.reconciledThrough,1)) blockers.push('The account evidence leaves a gap after previous reconciliation protection. Keep that cutoff unchanged or review the missing period first.');
          after.reconciledThrough=request.period.throughDate;
        }
      }
    }
    const qbo=observations.preferences.closedThrough, effectiveBefore=cutoff(before.closedThrough,before.reconciledThrough,qbo),effectiveAfter=cutoff(after.closedThrough,after.reconciledThrough,qbo);
    const nextManagedDate=current.calendar?(current.calendar.verifiedThrough?shift(current.calendar.verifiedThrough,1):current.calendar.openingDate):null;
    const review={version:1,scope:bound.scope,ownerId:bound.ownerId,requestHash:hash(request),mode:request.mode,state:stateView(current),qbo:{preferencesHash:observations.preferences.contentHash,closedThrough:qbo,accountInventoryHash:observations.accountInventoryHash},
      bankResults:banks,reportChecks:reports,exceptions,blockers,readyToApply:!blockers.length,dateEffect:{before:{closedThrough:before.closedThrough,reconciledThrough:before.reconciledThrough,effectiveThrough:effectiveBefore},after:{...after,effectiveThrough:effectiveAfter},
        newlyWritableFrom:request.mode==='reopen' && effectiveBefore && (!effectiveAfter || effectiveAfter<effectiveBefore)?effectiveAfter?shift(effectiveAfter,1):'earliest app-permitted date':null,newlyWritableThrough:request.mode==='reopen' && effectiveBefore && (!effectiveAfter || effectiveAfter<effectiveBefore)?effectiveBefore:null,nextManagedDate,nextManagedDateBlocked:!!(nextManagedDate && effectiveAfter && nextManagedDate<=effectiveAfter)}};
    C.bounded({review,observations,request},480000);
    return {current,review,reviewHash:hash(review),observations};
  }
  async function accounts(user,{signal}={}) {
    const bound=await bind(user,'periods.manage',true);await ready(bound);
    const observed=await (dependencies.readObservations || createPeriodCloseReader({access:bound.access,now}))(bound.scope,{signal});
    validateObservation(observed,bound.scope);
    return {...bound.scope,scopeHash:hash(bound.scope),accounts:eligible(observed.accounts),accountInventoryHash:observed.accountInventoryHash,observedAt:observed.observedAt,qboClosedThrough:observed.preferences.closedThrough,qboReadAttempts:observed.qboReadAttempts,currentInventory:true};
  }
  async function sources(user,period) {
    const bound=await bind(user);C.period(period,now());const b=budget(),items=[];
    for (const definition of critical()) {
      admit(b);
      const rows=await models.Audits.find({userId:bound.ownerId,realmId:bound.scope.realmId,action:R.OBSERVATION,'afterState.kind':R.OBS_KIND,'afterState.scope':bound.scope,'afterState.payload.request.reportKey':definition.key,'afterState.payload.request.period':period,'afterState.payload.request.basis':'Accrual'}).hint({userId:1,realmId:1,createdAt:-1}).sort({createdAt:-1,_id:-1}).limit(3).maxTimeMS(3000).lean();
      let candidate=null,reason='No current matching full-company manual check was found in the latest three candidates.';
      for (const row of rows) {
        try { candidate=await reportSource(bound,{key:definition.key,id:String(row._id),evidenceHash:row.afterState?.evidenceHash},period,null,b);break; }
        catch(error) { if (error.code!=='PERIOD_CLOSE_REQUIRED' && error.code!=='REPORT_EVIDENCE_UNAVAILABLE') throw error; reason=error.message; }
      }
      items.push({key:definition.key,name:definition.name,candidate,reason:candidate?null:reason,searchComplete:rows.length<3});
    }
    await bound.access.authorize(bound.scope,'periods.read');
    return {...bound.scope,period,items,qboReads:0};
  }
  async function review(user,request,options) {
    const bound=await bind(user,'periods.manage',true),value=await inspect(bound,request,options);
    return {...bound.scope,review:value.review,reviewHash:value.reviewHash,readAt:value.observations.observedAt,qboReadAttempts:value.observations.qboReadAttempts,qboWrites:0};
  }
  async function prior(bound,value,session) {
    const id=C.decisionId(bound.scope,bound.ownerId,value.request.requestKey),row=await read(models.Audits,auditFilter(bound,id),session);
    if (!row) return null;
    const p=validatePeriodDecision(row,bound.scope,bound.ownerId);
    if (p.requestHash!==hash(value) || !C.same(p.input,value)) C.fail('This request identity belongs to another accounting-period decision.');
    return {id,p,decisionHash:row.afterState.decisionHash};
  }
  async function publicResult(bound,value,reused=false) {
    const policy=await read(models.Policies,{environment:bound.scope.environment,realmId:bound.scope.realmId});
    await bound.access.authorize(bound.scope,'periods.read');
    let current=false;
    try{if(policy?.periodDecisionId===value.id && C.same(policy.periodControl,value.p.resultingControl)){assertPeriodControl(policy.periodControl,bound.scope,bound.ownerId);current=true;}}catch{/* Current protection remains separate from a retained receipt. */}
    return {...bound.scope,id:value.id,decisionHash:value.decisionHash,requestHash:value.p.requestHash,request:clone(value.p.input.request),reviewHash:value.p.input.reviewHash,status:value.p.status,mode:value.p.input.request.mode,recordedAt:value.p.recordedAt,reused,current,qboWrites:0};
  }
  async function retain(bound,value,status,selected,reason,session) {
    const id=C.decisionId(bound.scope,bound.ownerId,value.request.requestKey),recordedAt=new Date(now()).toISOString();
    let resultingControl=null;
    if (status==='applied') {
      resultingControl=selected.current.policy.periodControl;
      if (value.request.mode!=='record') {
        const control={version:1,status:'owner-recorded',scope:bound.scope,ownerId:bound.ownerId,closedThrough:selected.review.dateEffect.after.closedThrough,reconciledThrough:selected.review.dateEffect.after.reconciledThrough,evidenceNote:value.request.reason.trim(),recordedAt};
        resultingControl={...control,contentHash:hash(control)};
      }
      const {policy,writer,calendar}=selected.current;
      const changed=await models.Policies.findOneAndUpdate({_id:policy._id,...bound.scope,state:policy.state,revision:policy.revision,'periodControl.contentHash':policy.periodControl.contentHash},{$inc:{revision:1},...(value.request.mode==='record'?{}:{$set:{periodControl:resultingControl,periodDecisionId:id}})},{new:true,session}).lean();
      const writerFence=await models.Writers.findOneAndUpdate({_id:writer._id,...bound.scope,revision:writer.revision,operationId:null,planHash:null,unresolved:null},{$inc:{revision:1}},{new:true,session}).lean();
      if (!changed || !writerFence) C.fail('Company work or protected dates changed during the decision.');
      if (calendar) {
        const touched=await models.Calendars.findOneAndUpdate({_id:calendar._id,...bound.scope,revision:calendar.revision,writerRevision:calendar.writerRevision,authorityRevision:calendar.authorityRevision,authorityHash:calendar.authorityHash,currentOperationId:null,pendingCommit:null,stopRequested:calendar.stopRequested},{$inc:{authorityRevision:1}},{new:true,session}).lean();
        if (!touched) C.fail('Business plan admission or calendar authority changed during the period decision.');
      }
    }
    const payload={version:1,kind:C.KIND,scope:bound.scope,ownerId:bound.ownerId,requestHash:hash(value),input:clone(value),status,recordedAt,review:status==='applied'?selected.review:null,observations:status==='applied'?selected.observations:null,resultingControl,cancellationReason:status==='cancelled'?reason.trim():null};
    const afterState={kind:C.KIND,decisionHash:hash(payload),payload};C.bounded(afterState);
    const event={_id:id,userId:bound.ownerId,realmId:bound.scope.realmId,action:C.ACTION,actionType:'manual',outcome:'success',aiDriven:false,approvalEvent:'owner-accounting-period-decision',createdAt:new Date(recordedAt),afterState};
    if(status==='applied' && (now()<Date.parse(selected.observations.startedAt) || now()-Date.parse(selected.observations.startedAt)>180000)) C.fail('The account/preferences evidence expired before the decision could be saved.');
    validatePeriodDecision(event,bound.scope,bound.ownerId);
    await models.Audits.create([event],{session});
    return {id,p:payload,decisionHash:afterState.decisionHash};
  }
  async function apply(user,value,{signal}={}) {
    input(value);const bound=await bind(user,'periods.manage',true);C.validateRequest(value.request,bound.scope,now());
    const repeated=await prior(bound,value);
    if (repeated) { const terminal=await transaction(async session=>{await fence(bound,session);return prior(bound,value,session);});return publicResult(bound,terminal,true); }
    let result;
    try {
      const selected=await inspect(bound,value.request,{signal});
      if (selected.reviewHash!==value.reviewHash || !selected.review.readyToApply) C.fail('The reviewed evidence, work or protected dates changed, or close requirements remain unresolved.');
      result=await transaction(async session=>{
        await fence(bound,session);
        const existing=await prior(bound,value,session);if(existing)return existing;
        const current=await inspect(bound,value.request,{session,observations:selected.observations,signal});
        if (current.reviewHash!==value.reviewHash || !current.review.readyToApply) C.fail('The exact reviewed period evidence changed before confirmation.');
        return retain(bound,value,'applied',current,null,session);
      });
    } catch(error) {
      if(signal?.aborted)throw error;
      const terminal=await transaction(async session=>{await fence(bound,session);return prior(bound,value,session);});
      if(!terminal)throw error;result=terminal;
    }
    return publicResult(bound,result);
  }
  async function cancel(user,body) {
    if(!C.exact(body,['input','reason']) || !C.text(body.reason,20,2000))C.fail('Choose the exact unconfirmed decision and explain its cancellation.',400);
    const value=input(body.input),bound=await bind(user,'periods.manage',true);C.validateRequest(value.request,bound.scope,now());
    const result=await transaction(async session=>{
      await fence(bound,session);const existing=await prior(bound,value,session);if(existing)return existing;
      const policy=await read(models.Policies,{...bound.scope},session);
      if(!policy || policy.contractVersion!==1 || !revision(policy.revision) || !['preparing','active'].includes(policy.state))C.fail('Restore current company coordination before cancelling this request.');
      const changed=await models.Policies.findOneAndUpdate({_id:policy._id,...bound.scope,state:policy.state,revision:policy.revision},{$inc:{revision:1}},{new:true,session}).lean();
      if(!changed)C.fail('The company decision changed. Retry the exact cancellation.');
      return retain(bound,value,'cancelled',null,body.reason,session);
    });
    return publicResult(bound,result);
  }
  async function detailFor(bound,id) {
    if(!C.ID.test(id || ''))C.fail('Choose a saved period decision.',400);
    const row=await read(models.Audits,auditFilter(bound,id));if(!row)C.fail('This accounting-period decision is unavailable.',404);
    const p=validatePeriodDecision(row,bound.scope,bound.ownerId),support={status:'retained-owner-evidence',issues:[]};
    if(p.status==='applied'){
      validateObservation(p.observations,bound.scope);
      if(p.review.requestHash!==hash(p.input.request) || p.review.state.periodControl.contentHash!==hash(Object.fromEntries(Object.entries(p.review.state.periodControl).filter(([key])=>key!=='contentHash'))))C.fail('The original reviewed control changed.');
      assertPeriodControl(p.resultingControl,bound.scope,bound.ownerId);
      if(p.input.request.mode!=='reopen' && !C.same(C.bankResults(p.input.request,eligible(p.observations.accounts)),p.review.bankResults))C.fail('The retained bank arithmetic changed.');
      const b=budget();
      for(const selection of p.input.request.reportChecks || []){
        try{const source=await reportSource(bound,selection,p.input.request.period,null,b);if(!C.same(source,p.review.reportChecks.find(value=>value.id===source.id)))C.fail('A retained report result changed.');}
        catch(error){support.status='support-changed';support.issues.push({key:selection.key,message:/withdrawn/.test(error.message)?'Supporting manual report check was withdrawn.':'Supporting report evidence or its current definition is unavailable or changed.'});}
      }
    }
    const result=await publicResult(bound,{id,p,decisionHash:row.afterState.decisionHash});
    return {...result,decision:clone(p),support,limitation:'Dated owner-entered evidence and independently checked arithmetic. Source files, transaction matching and official QuickBooks bank reconciliation are not independently certified. App protection stays in force until a separate owner decision.'};
  }
  async function detail(user,id){return detailFor(await bind(user),id);}
  function cursor(bound,value){
    if(!value)return null;
    try{if(typeof value!=='string' || value.length>1000)throw Error();const row=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(!C.exact(row,['scopeHash','at','id']) || row.scopeHash!==hash({...bound.scope,ownerId:bound.ownerId}) || !C.ID.test(row.id) || new Date(row.at).toISOString()!==row.at)throw Error();return row;}catch{C.fail('Reload saved period history; its cursor changed.',400);}
  }
  async function status(user,{after}={}){
    const bound=await bind(user),anchor=cursor(bound,after),filter={userId:bound.ownerId,realmId:bound.scope.realmId,action:C.ACTION,'afterState.kind':C.KIND,'afterState.payload.scope':bound.scope};
    if(anchor)filter.$or=[{createdAt:{$lt:new Date(anchor.at)}},{createdAt:new Date(anchor.at),_id:{$lt:anchor.id}}];
    const rows=await models.Audits.find(filter).select('_id createdAt').hint({userId:1,realmId:1,createdAt:-1}).sort({createdAt:-1,_id:-1}).limit(26).maxTimeMS(3000).lean(),page=rows.slice(0,25),last=page.at(-1);
    const policy=await read(models.Policies,{environment:bound.scope.environment,realmId:bound.scope.realmId});
    let canManage=false,canReview=false,reason='Only the current prepared company owner can record period decisions.',current=null,protection=policy?.periodControl || null,protectionStatus=protection?'confirmed':'unprepared';
    try{if(bound.actorId!==bound.ownerId)throw Error();await bound.access.authorize(bound.scope,'periods.manage');await ready(bound);canManage=true;reason='Prepare company write coordination and initial protected-date choices before a new period review.';const currentState=await state(bound);await idle(bound,currentState,null,budget());canReview=true;reason=null;}catch(error){if(canManage)reason=error.code==='PERIOD_CLOSE_REQUIRED'?error.message:'Current company preparation could not be confirmed.';}
    if(protection)try{assertPeriodControl(protection,bound.scope,bound.ownerId);}catch{protection=null;protectionStatus='unavailable';reason='Saved app protection needs recovery; no accounting-period assurance is available.';canReview=false;}
    if(policy?.periodDecisionId)try{current=await detailFor(bound,policy.periodDecisionId);}catch{current={id:policy.periodDecisionId,unavailable:true,message:'The retained period decision could not be confirmed. Saved protection remains separate.'};}
    await bound.access.authorize(bound.scope,'periods.read');
    return {...bound.scope,scopeHash:hash(bound.scope),companyName:bound.companyName,owner:bound.actorId===bound.ownerId,canManage,canReview,blockReason:reason,protection,protectionStatus,current,
      history:{items:page.map(row=>({id:String(row._id),recordedAt:new Date(row.createdAt).toISOString(),verified:false,message:'Open this saved decision to verify its evidence and outcome.'})),next:rows.length>25?Buffer.from(JSON.stringify({scopeHash:hash({...bound.scope,ownerId:bound.ownerId}),at:new Date(last.createdAt).toISOString(),id:String(last._id)})).toString('base64url'):null,complete:rows.length<=25},readAt:new Date(now()).toISOString(),qboReads:0};
  }
  return {accounts,sources,review,apply,cancel,status,detail};
}
module.exports={createPeriodCloseService};
