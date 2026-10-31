'use strict';
const { hash, canonical } = require('./business-calendar');
const { evaluateReportSources } = require('./book-evidence');
const { createBusinessStorageReadiness } = require('./business-runtime-storage');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
const CHECKS = Object.freeze([
  { key: 'records', label: 'Record outcomes and unresolved-work review', mode: 'review' },
  { key: 'trial-balance', label: 'Trial balance', mode: 'report' },
  { key: 'balance-sheet', label: 'Balance sheet', mode: 'report' },
  { key: 'receivables', label: 'Receivables and open credits', mode: 'report' },
  { key: 'payables', label: 'Payables and supplier credits', mode: 'report' },
  { key: 'cash-clearing', label: 'Cash, deposits and clearing items', mode: 'review', perAccount: true },
  { key: 'adjustments', label: 'Accruals, reversals and prepaid roll-forward', mode: 'review' },
  { key: 'sales-tax', label: 'Sales tax balances and exceptions', mode: 'review' },
  { key: 'inventory', label: 'Inventory valuation and exceptions', mode: 'review' },
  { key: 'performance', label: 'Performance and service-period cut-off', mode: 'review' },
  { key: 'dimensions', label: 'Classes, locations and unclassified amounts', mode: 'review' },
  { key: 'bank-reconciliation', label: 'Bank or card reconciliation', mode: 'manual', perAccount: true },
  { key: 'tax-filing', label: 'GST/HST filing and remittance', mode: 'manual' },
  { key: 'closing-date', label: 'QuickBooks closing-date protection', mode: 'manual' },
  { key: 'physical-inventory', label: 'Physical inventory count', mode: 'manual' },
]);
function fail(message, status = 409, code = 'BUSINESS_CLOSE_CHECKLIST_REQUIRED') { throw Object.assign(new Error(message), { status, code }); }
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('Use the exact checklist fields without company or result overrides.', 400); }
function monthPeriod(month) {
  if (typeof month !== 'string' || !/^(?:20[0-9]{2})-(?:0[1-9]|1[0-2])$/.test(month)) fail('Choose a month in YYYY-MM format.', 400);
  const [year, mm] = month.split('-').map(Number);
  return { fromDate: month + '-01', throughDate: new Date(Date.UTC(year, mm, 0)).toISOString().slice(0, 10) };
}
const sameScope = (a, b) => ['environment','realmId','connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
const accountRows = accounts => accounts.map(row => ({ id: String(row.Id), name: row.Name || row.FullyQualifiedName || String(row.Id), type: row.AccountType, active: row.Active !== false })).filter(row => /^[0-9]{1,20}$/.test(row.id));
const eventDigest = row => hash({ kind: row.kind, title: row.title, detail: row.detail || '', data: row.data || null, at: new Date(row.at).toISOString() });
function createBusinessCloseChecklist({ models, connection, transaction, bind, fence, now = () => Date.now(), assertStorageReady, CloseEvidence, Events } = {}) {
  if (!models || [transaction,bind,fence].some(fn => typeof fn !== 'function')) throw new TypeError('Close checklist requires scoped governance and transactional audit');
  const store = () => CloseEvidence || models.CloseChecklist || require('../models/BusinessCloseChecklistEvidence');
  const events = () => Events || models.Events || require('../models/BusinessAgentEvent');
  let readiness;
  async function ready() { if (assertStorageReady) return assertStorageReady(); readiness ||= createBusinessStorageReadiness({ connection, models: { CloseChecklist: store() }, now }); return readiness(); }
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(5000).lean();
  const find = (Model, filter, session, limit) => Model.find(filter).session(session).sort({ revision: -1, createdAt: -1, _id: -1 }).limit(limit).maxTimeMS(5000).lean();
  const own = bound => ({ ...bound.scope, ownerId: bound.ownerId });
  function checkedPayload(row, bound) {
    const p = row?.payload;
    if (!p || row.contractVersion !== 1 || !sameScope(row,bound.scope) || String(row.ownerId) !== bound.ownerId || hash(p) !== row.contentHash || p.period !== row.period || p.accountId !== row.accountId || p.checkKey !== row.checkKey || p.revision !== row.revision || p.requestHash !== row.requestHash || !sameScope(p.scope,bound.scope) || p.ownerId !== bound.ownerId || !ID.test(p.actorId || '') || !Number.isSafeInteger(row.revision) || row.revision < 1) fail('Saved checklist evidence failed its integrity check.');
    return p;
  }
  async function verifyRow(row, bound, session) {
    const p = checkedPayload(row,bound);
    const audit = await read(models.Audits, { _id: row.auditId, userId: bound.ownerId, realmId: bound.scope.realmId, action: 'Business close checklist evidence recorded', outcome: 'success' }, session);
    if (!audit || String(audit.actorUserId || audit.userId) !== p.actorId || audit.actionType !== (p.decisionSource === 'accountant-tool' ? 'ai_executed' : 'manual') || Boolean(audit.aiDriven) !== (p.decisionSource === 'accountant-tool') || canonical(audit.inputParams) !== canonical({ scope: bound.scope, checklistId: String(row._id), contentHash: row.contentHash, requestHash: row.requestHash })) fail('The close checklist audit is unavailable or changed.');
    return p;
  }
  async function operationReference(bound, ref, period, session) {
    const row = await read(models.Evidence, { _id: ref.id, ...bound.scope, evidenceHash: ref.hash }, session);
    if (!row || row.contractVersion !== 1 || !sameScope(row.proof,bound.scope) || !sameScope(row.sources?.scope,bound.scope) || hash(row.proof) !== row.evidenceHash || row.proof.operationId !== String(row.operationId) || row.proof.planHash !== row.planHash || canonical(row.sources.period) !== canonical({ fromDate: row.proof.fromDate, throughDate: row.proof.throughDate })) fail('Choose intact retained operation evidence for this company.');
    const { sourceHash, ...source } = row.sources;
    if (!HASH.test(sourceHash || '') || hash(source) !== sourceHash || row.proof.fromDate > period.throughDate || row.proof.throughDate < period.fromDate) fail('The evidence source is changed or outside this month.');
    const audit = await read(models.Audits, { _id: row.auditId, userId: bound.ownerId, realmId: bound.scope.realmId, action: 'Business operation evidence recorded', outcome: 'success' }, session);
    if (!audit || !sameScope(audit.inputParams,bound.scope) || audit.inputParams?.details?.evidenceHash !== ref.hash || audit.inputParams?.details?.sourceHash !== sourceHash || audit.inputParams?.details?.operationId !== String(row.operationId) || audit.inputParams?.eventKey !== 'business-period-evidence:' + row.operationId + ':' + row.evidenceRevision) fail('The retained operation evidence audit is unavailable.');
    const evaluation = evaluateReportSources(row.sources, { allowExplicitZero: true });
    return { kind: ref.kind, id: ref.id, hash: ref.hash, operationId: String(row.operationId), period: row.sources.period, observedAt: row.sources.observedAt, completeMonth: canonical(row.sources.period) === canonical(period), checks: evaluation.checks.map(({ key,status }) => ({ key,status })), recordsSupported: row.proof.complete === true && row.proof.assertions?.some(a => a.key === 'records' && a.status === 'passed') === true, accounts: accountRows(row.sources.accounts || []) };
  }
  async function reference(bound, ref, period, session) {
    exact(ref, ['kind','id','hash']);
    if (!ID.test(ref.id || '') || !HASH.test(ref.hash || '')) fail('Use a retained evidence identifier and its exact hash.',400);
    if (ref.kind === 'operation-evidence') return operationReference(bound,ref,period,session);
    if (ref.kind === 'business-baseline') {
      if(!models.Baselines) fail('Retained company observations are unavailable.');
      const row=await read(models.Baselines,{_id:ref.id,...own(bound),evidenceHash:ref.hash},session);
      const checked=require('./business-baseline').validateBaselineObservation(row), source=checked.sources, payload=checked.payload;
      if(source.period.fromDate>period.throughDate||source.period.throughDate<period.fromDate) fail('The company observation is outside this month.');
      const expected={baselineId:String(row._id),...bound.scope,actorId:String(row.actorId),blueprintId:payload.blueprint.id,blueprintHash:payload.blueprint.contentHash,requestHash:row.requestHash,evidenceHash:row.evidenceHash,sourceHash:payload.sourceHash,purpose:payload.purpose,fromDate:payload.period.fromDate,throughDate:payload.period.throughDate,...(row.contractVersion===2?{inventoryVersion:row.inventorySources.version,inventoryHash:payload.inventory.sourceHash,inventoryStartedAt:payload.inventory.startedAt,inventoryObservedAt:payload.inventory.observedAt}:{}),status:'captured'};
      const audit=await read(models.Audits,{_id:row.auditId,userId:bound.ownerId,realmId:bound.scope.realmId,action:'Business baseline observation saved',outcome:'success'},session);
      if(!audit||String(audit.actorUserId||audit.userId)!==String(row.actorId)||audit.actionType!=='manual'||canonical(audit.afterState)!==canonical(expected)) fail('The company observation audit is unavailable or changed.');
      const evaluation=evaluateReportSources(source,{allowExplicitZero:true});
      return {...ref,period:source.period,observedAt:source.observedAt,completeMonth:canonical(source.period)===canonical(period),checks:evaluation.checks.map(({key,status})=>({key,status})),recordsSupported:false,accounts:accountRows(source.accounts||[])};
    }
    if (ref.kind !== 'business-event') fail('Unsupported close evidence reference.',400);
    const row = await read(events(), { _id: ref.id, ...bound.scope, ownerId: bound.ownerId },session);
    if (!row || eventDigest(row) !== ref.hash || new Date(row.at).toISOString().slice(0,10) < period.fromDate || new Date(row.at).toISOString().slice(0,10) > period.throughDate) fail('Choose an intact business decision recorded during this month.');
    return { ...ref, title: row.title, observedAt: new Date(row.at).toISOString(), completeMonth: false, checks: [], accounts: [] };
  }
  function target(checkKey, accountId, accounts) {
    const check = CHECKS.find(c => c.key === checkKey);
    if (!check || (check.perAccount ? !accounts.some(a => a.id === accountId && ['Bank','Credit Card'].includes(a.type)) : accountId !== 'company')) fail('Choose a checklist item and its stated account.',400);
    return check;
  }
  function result(check, input, refs, period) {
    if (input.disposition === 'exception') return { status: 'exception', reason: input.note };
    if (input.disposition === 'reopen') return { status: 'open', reason: input.note };
    if (input.disposition === 'manual-attestation') {
      if (check.mode !== 'manual') fail('This check uses retained evidence or an explicit review.',400);
      exact(input.attestation,['confirmed','asOfDate','reference']);
      if (input.attestation.confirmed !== true || input.attestation.asOfDate !== period.throughDate || typeof input.attestation.reference !== 'string' || input.attestation.reference.trim().length < 10 || input.attestation.reference.length > 1000) fail('Manually attest the exact month-end date and a statement, filing or settings evidence reference.',400);
      return { status: 'manually-attested', reason: 'Owner attestation recorded; not independently verified by the app.' };
    }
    if (input.attestation !== null) fail('Only a manual attestation accepts attestation fields.',400);
    if (!['evidence','review'].includes(input.disposition) || !refs.length) fail('Attach retained evidence, record an exception, or explicitly reopen the item.',400);
    if (check.mode === 'manual') return { status: 'evidence-recorded', reason: 'Supporting evidence does not establish manual completion. Owner attestation remains open.' };
    if (check.mode === 'report') {
      if (input.disposition !== 'evidence') fail('Report checks are evaluated from the retained sources.',400);
      const passed = refs.some(r => r.completeMonth && (check.key === 'records' ? r.recordsSupported : r.checks.some(c => c.key === check.key && c.status === 'passed')));
      return { status: passed ? 'report-supported' : 'evidence-recorded', reason: passed ? 'Supported by the complete monthly retained evidence; this is not a bank reconciliation, filing or closing-date check.' : 'No complete monthly passing source supports this check. Partial evidence remains attached.' };
    }
    return { status: input.disposition === 'review' && refs.some(r => r.completeMonth) ? 'review-recorded' : 'evidence-recorded', reason: input.disposition === 'review' && refs.some(r => r.completeMonth) ? 'Review recorded with monthly evidence; conclusions are the recorded reviewer assessment.' : 'Evidence attached; a documented review with full-month evidence is still required.' };
  }
  async function cachedReference(bound,ref,period,session,cache) {
    const key=canonical(ref); if(!cache.has(key)) cache.set(key,reference(bound,ref,period,session)); return cache.get(key);
  }
  async function sources(bound, period, session, cache = new Map()) {
    // Prefer exact monthly observations; recent daily snapshots remain explicitly partial.
    const monthly = await models.Evidence.find({ ...bound.scope, 'proof.fromDate': period.fromDate, 'proof.throughDate': period.throughDate }).session(session).sort({ createdAt:-1,_id:-1 }).limit(10).maxTimeMS(5000).lean();
    const recent = await models.Evidence.find({ ...bound.scope, 'proof.fromDate': { $gte:period.fromDate }, 'proof.throughDate': { $lte:period.throughDate, $gte:period.fromDate } }).session(session).sort({ createdAt:-1,_id:-1 }).limit(10).maxTimeMS(5000).lean();
    const candidates = [], rejected = [];
    const monthlyBaselines=models.Baselines ? await models.Baselines.find({...own(bound),'payload.period.fromDate':period.fromDate,'payload.period.throughDate':period.throughDate}).session(session).sort({createdAt:-1,_id:-1}).limit(10).maxTimeMS(5000).lean() : [];
    for(const row of monthlyBaselines) { try {candidates.push(await cachedReference(bound,{kind:'business-baseline',id:String(row._id),hash:row.evidenceHash},period,session,cache));} catch(error) {if(!/^BUSINESS_(CLOSE|REPORT|BASELINE)/.test(error.code||''))throw error;rejected.push({id:String(row._id),reason:'Retained monthly observation integrity or report checks are unavailable.'});} }
    for (const row of [...new Map([...monthly,...recent].map(r=>[String(r._id),r])).values()]) {
      try { candidates.push(await cachedReference(bound,{ kind:'operation-evidence',id:String(row._id),hash:row.evidenceHash },period,session,cache)); }
      catch (error) { if (!/^BUSINESS_(CLOSE|REPORT|BASELINE)/.test(error.code || '')) throw error; rejected.push({ id:String(row._id), reason:'Retained evidence integrity or report checks are unavailable.' }); }
    }
    const decisions = await events().find({ ...own(bound), kind:'management-decision', at: { $gte:new Date(period.fromDate+'T00:00:00Z'), $lt:new Date(Date.parse(period.throughDate+'T00:00:00Z')+86400000) } }).session(session).sort({at:-1,_id:-1}).limit(20).maxTimeMS(5000).lean();
    const references = [...candidates.map(({accounts,checks,recordsSupported,...r})=>r), ...decisions.map(r=>({kind:'business-event',id:String(r._id),hash:eventDigest(r),title:r.title,observedAt:new Date(r.at).toISOString(),completeMonth:false}))];
    const accounts = [...new Map(candidates.flatMap(r=>r.accounts).map(a=>[a.id,a])).values()];
    return { references, candidates, accounts, rejected, bounded:true };
  }
  async function getCloseChecklist(user, input) {
    exact(input,['period']); const period = monthPeriod(input.period), bound = await bind(user,'operations.read');
    const cache = new Map(), data = await sources(bound,period,null,cache);
    let storage = { ready:true }, rows = [];
    try { await ready(); }
    catch(error) { if (!['BUSINESS_STORAGE_UNPREPARED','BUSINESS_CLOSE_STORAGE_UNPREPARED'].includes(error.code)) throw error; storage = {ready:false,reason:'Checklist storage needs explicit preparation. Existing evidence is read-only; no collection or index was created.'}; }
    // Read-only queries do not create missing collections. Preserve history even when write indexes need preparation.
    rows = await find(store(),{...own(bound),period:input.period},null,2001);
    if(rows.length > 2000) fail('This checklist history exceeds its read budget; narrow archival support is required.');
    const history=[], revisions=new Set();
    for(const row of rows) { const identity=[row.checkKey,row.accountId,row.revision].join(':'); if(revisions.has(identity)) fail('Duplicate checklist revisions need review.'); revisions.add(identity); const payload=await verifyRow(row,bound); history.push({ id:String(row._id),contentHash:row.contentHash,auditId:row.auditId,...payload }); }
    // Recheck current evidence links instead of presenting a broken reference as supported.
    const unavailable = new Set();
    for (const entry of history) {
      for (const ref of entry.evidenceReferences) { try { await cachedReference(bound,ref,period,null,cache); } catch (error) { if (!/^BUSINESS_(CLOSE|REPORT|BASELINE)/.test(error.code || '')) throw error; unavailable.add(entry.id); } }
    }
    // Retain referenced accounts even if no longer in the latest observation.
    const accounts=[...new Map([...data.accounts,...history.map(h=>h.account).filter(Boolean)].map(a=>[a.id,a])).values()];
    const items=CHECKS.flatMap(check => (check.perAccount ? accounts.filter(a=>['Bank','Credit Card'].includes(a.type)) : [{id:'company',name:'Company'}]).map(account=>{
      const entries=history.filter(h=>h.checkKey===check.key&&h.accountId===account.id).sort((a,b)=>b.revision-a.revision), current=entries[0];
      return { ...check, accountId:account.id, accountName:account.name, revision:current?.revision||0, status:current && unavailable.has(current.id) ? 'evidence-unavailable' : current?.result.status||'open', current:current||null, history:entries, supportedBy:data.candidates.filter(r=>check.mode==='report'&&r.completeMonth&&r.checks.some(c=>c.key===check.key&&c.status==='passed')).map(r=>r.id) };
    }));
    await bound.access.authorize(bound.scope,'operations.read');
    return { scope:bound.scope,contextHash:hash({scope:bound.scope,ownerId:bound.ownerId}),period:input.period,...period,owner:bound.actorId===bound.ownerId,storage,accounts,accountCoverage:accounts.length?'retained-observation':'unavailable',items,evidence:data.references,rejectedEvidence:data.rejected,sourceLimit:'Up to ten monthly operation observations, ten monthly company surveys, ten recent snapshots and twenty decisions; not a complete inventory of evidence.',summary:{total:items.length,open:items.filter(i=>!['report-supported','review-recorded','manually-attested'].includes(i.status)).length,exceptions:items.filter(i=>i.status==='exception').length},limitation:'Calendar and ledger verification never establish bank reconciliation, tax filing or QuickBooks closing-date protection. Manual attestations record the owner’s statement only.' };
  }
  async function recordCloseChecklistEvidence(user,input,{ manualAttestation = false } = {}) {
    exact(input,['contextHash','period','accountId','checkKey','expectedRevision','requestKey','disposition','evidenceReferences','note','attestation']);
    const period=monthPeriod(input.period);
    if (input.disposition === 'manual-attestation' && !manualAttestation) fail('Manual attestations must come from the owner’s explicit checklist form, not an automated tool.',403);
    if (input.disposition === 'manual-attestation' && period.throughDate > new Date(now()).toISOString().slice(0,10)) fail('A future month cannot be manually attested.',400);
    if (!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>=10000||typeof input.requestKey!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestKey)||typeof input.note!=='string'||input.note.trim().length<20||input.note.length>4000||!Array.isArray(input.evidenceReferences)||input.evidenceReferences.length>10||new Set(input.evidenceReferences.map(r=>r?.kind+':'+r?.id)).size!==input.evidenceReferences.length||!['evidence','review','exception','reopen','manual-attestation'].includes(input.disposition)) fail('Supply a bounded checklist decision, explanation, evidence and current revision.',400);
    if (input.disposition!=='manual-attestation'&&input.attestation!==null) fail('Attestation fields require an explicit manual attestation.',400);
    const bound=await bind(user,'operations.record');
    if (!HASH.test(input.contextHash || '') || input.contextHash !== hash({scope:bound.scope,ownerId:bound.ownerId})) fail('The selected company changed. Reload the checklist before recording a decision.');
    if (input.disposition==='manual-attestation'&&bound.actorId!==bound.ownerId) fail('Only the connected company owner can attest manual close work.',403);
    await ready();
    const id=hash({scope:bound.scope,ownerId:bound.ownerId,requestKey:input.requestKey}).slice(0,24), requestHash=hash(input);
    try { return await transaction(async session=>{
      if(!session?.inTransaction?.()) fail('Checklist evidence and its audit require one transaction.');
      await fence(bound,session,'operations.record');
      const existing=await read(store(),{_id:id,...own(bound)},session);
      if(existing) { const p=await verifyRow(existing,bound,session); if(existing.requestHash!==requestHash||p.actorId!==bound.actorId) fail('This checklist request key already names a different decision.'); return {scope:bound.scope,id,revision:p.revision,status:p.result.status,reused:true}; }
      const rows=await find(store(),{...own(bound),period:input.period,accountId:input.accountId,checkKey:input.checkKey},session,1), previous=rows[0];
      if(previous) await verifyRow(previous,bound,session);
      if((previous?.revision||0)!==input.expectedRevision) fail('This checklist item changed. Refresh it before recording your decision.');
      const refs=[]; for(const ref of input.evidenceReferences) refs.push(await reference(bound,ref,period,session));
      const accounts=[...refs.flatMap(r=>r.accounts),...(previous?.payload.account?[previous.payload.account]:[])];
      if(input.accountId !== 'company' && !accounts.some(a=>a.id===input.accountId)) {
        const candidate=await models.Evidence.findOne({...bound.scope,'proof.fromDate':{$gte:period.fromDate},'proof.throughDate':{$lte:period.throughDate,$gte:period.fromDate}}).session(session).sort({createdAt:-1,_id:-1}).maxTimeMS(5000).lean();
        if(candidate) accounts.push(...(await operationReference(bound,{kind:'operation-evidence',id:String(candidate._id),hash:candidate.evidenceHash},period,session)).accounts);
      }
      if(input.accountId !== 'company' && !accounts.some(a=>a.id===input.accountId) && models.Baselines) {
        const baseline=await models.Baselines.findOne({...own(bound),'payload.period.fromDate':period.fromDate,'payload.period.throughDate':period.throughDate}).session(session).sort({createdAt:-1,_id:-1}).maxTimeMS(5000).lean();
        if(baseline) accounts.push(...(await reference(bound,{kind:'business-baseline',id:String(baseline._id),hash:baseline.evidenceHash},period,session)).accounts);
      }
      const check=target(input.checkKey,input.accountId,accounts), evaluated=result(check,input,refs,period);
      const payload={version:1,scope:bound.scope,ownerId:bound.ownerId,actorId:bound.actorId,period:input.period,accountId:input.accountId,account:accounts.find(a=>a.id===input.accountId)||null,checkKey:input.checkKey,revision:input.expectedRevision+1,requestHash,decisionSource:manualAttestation?'authenticated-ui':'accountant-tool',disposition:input.disposition,note:input.note.trim(),attestation:input.attestation,at:new Date(now()).toISOString(),evidenceReferences:input.evidenceReferences,previousId:previous?String(previous._id):null,result:evaluated};
      const contentHash=hash(payload), auditId=hash({closeChecklist:id,contentHash}).slice(0,24);
      await models.Audits.create([{_id:auditId,userId:bound.ownerId,...(bound.actorId!==bound.ownerId?{actorUserId:bound.actorId}:{}),realmId:bound.scope.realmId,action:'Business close checklist evidence recorded',actionType:manualAttestation?'manual':'ai_executed',aiDriven:!manualAttestation,outcome:'success',inputParams:{scope:bound.scope,checklistId:id,contentHash,requestHash}}],{session});
      await store().create([{_id:id,contractVersion:1,...own(bound),period:input.period,accountId:input.accountId,checkKey:input.checkKey,revision:payload.revision,requestHash,contentHash,payload,auditId}],{session});
      return {scope:bound.scope,id,revision:payload.revision,status:evaluated.status,reused:false};
    }); } catch(error) { if(error.code===11000) fail('A concurrent checklist decision was saved. Refresh before retrying.'); throw error; }
  }
  return { getCloseChecklist,recordCloseChecklistEvidence };
}
// Lazy composition for callers outside the HTTP router; no tools are wired here.
const getCloseChecklist = (user,input) => require('./business-governance-service').createBusinessGovernanceService().getCloseChecklist(user,input);
const recordCloseChecklistEvidence = (user,input) => require('./business-governance-service').createBusinessGovernanceService().recordCloseChecklistEvidence(user,input);
module.exports = { CHECKS,monthPeriod,createBusinessCloseChecklist,getCloseChecklist,recordCloseChecklistEvidence };
