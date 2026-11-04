'use strict';
// Retained native configuration, admitted only by a reviewed local observer.
// A hash retains integrity; it is not provider authentication. No HTTP/AI admission.
const { hash, canonical } = require('./business-calendar');
const crypto = require('node:crypto');
const { scoped } = require('./qbo-write-contract');
const KIND = 'native-tax-agency-control-accounts-v1';
const ACTION = 'Retained reviewed native tax-account associations';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const HEX = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/, QID = /^\d{1,30}$/;
const clone = value => JSON.parse(JSON.stringify(value));
function need(ok, message) { if (!ok) throw Object.assign(new Error(message), { status:409, code:'GENERAL_TAX_ACCOUNT_PROOF_UNAVAILABLE' }); }
const sameScope = (a,b) => ['environment','realmId','connectionId'].every(k => String(a?.[k]) === String(b?.[k]));
function age(at, now) {
  const time = Date.parse(at);
  need(Number.isFinite(time) && time > 0 && time <= now + 120000 && now - time <= MAX_AGE_MS, 'Native tax-account observation expired or has an invalid time; retain fresh native configuration evidence.');
}
function nativeId(node, type, realmId, prefixes) {
  need(node?.type === type && typeof node.id === 'string', 'Native tax association has the wrong entity type.');
  const parts = node.id.split(':');
  need(parts.length === 2 && QID.test(parts[1]) && /^[A-Za-z0-9+/_=-]+$/.test(parts[0]), 'Native tax association identity is malformed.');
  const decoded = Buffer.from(parts[0], 'base64').toString('utf8').split(':');
  need(decoded.length === 3 && decoded[0] === 'v4.1' && decoded[1] === realmId && /^[a-f0-9]{10}$/.test(decoded[2]), 'Native tax association belongs to another company or identity contract.');
  need(!prefixes.has(type) || prefixes.get(type) === decoded[2], 'Native entity identity prefix changed.');
  need(![...prefixes].some(([other,prefix]) => other !== type && prefix === decoded[2]), 'Native entity identity types overlap.');
  prefixes.set(type, decoded[2]); return parts[1];
}
function parseCapture(capture, scope, now = Date.now()) {
  scope = scoped(scope);
  need(capture?.version === 2 && sameScope(capture.scope,scope) && capture.nativeOrigin === 'https://qbo.intuit.com' && capture.operation === 'Company__tax_agencies_indirect_tax_ui_qbo', 'Exact native tax observation scope and operation are required.');
  age(capture.at,now);
  const observer=capture.observer, result=capture.result;
  need(['codex-cli','claude-code'].includes(observer?.actor) && observer.identityVerified === true && observer.companyVerified === true && HEX.test(observer.identityHash||'') && HEX.test(observer.leaseOwnerHash||''), 'Reviewed native identity, company and coordinated observation are required.');
  need(HEX.test(capture.queryHash||'') && result?.status === 200 && result.graphqlNoErrors === true && (!Object.hasOwn(result,'errors') || Array.isArray(result.errors) && !result.errors.length) && result.dataPresent === true && HEX.test(result.rawResponseSha256||''), 'Native tax observation needs a successful complete GraphQL result and its reviewed response digest.');
  const prefixes=new Map();
  need(nativeId(result.company,'Company',scope.realmId,prefixes) === scope.realmId, 'Native response company changed.');
  need(Array.isArray(result.agencies) && result.agencies.length > 0 && result.agencies.length <= 100, 'Native agency associations are missing or exceed their complete observation budget.');
  const agencies=[], seen=new Set(), controls=new Set();
  for (const row of result.agencies) {
    const agencyId=nativeId(row,'Indirecttaxes_TaxAgency',scope.realmId,prefixes), accountId=nativeId(row.control,'Accounting_LedgerAccount',scope.realmId,prefixes);
    need(!seen.has(agencyId) && !controls.has(accountId), 'Native agency/control association is duplicated or ambiguous.');
    seen.add(agencyId); controls.add(accountId); agencies.push({agencyId,accountId});
  }
  need(Array.isArray(result.rates) && result.rates.length > 0 && result.rates.length <= 1000, 'Native rate associations are missing or incomplete.');
  const rates=[], rateIds=new Set(), uncoveredAgencyIds=new Set();
  for (const row of result.rates) {
    const rateId=nativeId(row,'Indirecttaxes_TaxRate',scope.realmId,prefixes), agencyId=nativeId(row.agency,'Indirecttaxes_TaxAgency',scope.realmId,prefixes);
    need(!rateIds.has(rateId), 'Native rate association is repeated.');
    if(!seen.has(agencyId))uncoveredAgencyIds.add(agencyId);
    rateIds.add(rateId); rates.push({rateId,agencyId});
  }
  return {scope,observedAt:capture.at,observer:{actor:observer.actor,identityVerified:true,identityHash:observer.identityHash,companyVerified:true,leaseOwnerHash:observer.leaseOwnerHash},queryHash:capture.queryHash,rawResponseSha256:result.rawResponseSha256,uncoveredAgencyIds:[...uncoveredAgencyIds].sort(),agencies:agencies.sort((a,b)=>a.agencyId.localeCompare(b.agencyId)),rates:rates.sort((a,b)=>a.rateId.localeCompare(b.rateId))};
}
function configuration(entity, record, expectedId) {
  need(record && String(record.Id) === String(expectedId) && record.sparse !== true, 'Fresh tax configuration identity is missing or partial.');
  const fields = entity === 'Account' ? ['Id','SyncToken','Active','AccountType','AccountSubType','CurrencyRef','ParentRef','SubAccount'] : entity === 'TaxAgency' ? ['Id','SyncToken','DisplayName','TaxTrackedOnPurchases','TaxTrackedOnSales','LastFileDate','SalesTaxReturnRef'] : ['Id','SyncToken','Active','AgencyRef','RateValue','DisplayType','SpecialTaxType','EffectiveTaxRate','TaxReturnLineRef'];
  const value=Object.fromEntries(fields.filter(k=>record[k] !== undefined).map(k=>[k,clone(record[k])]));
  // Account metadata time also changes with ordinary postings; it does not identify a control-account configuration change.
  if (entity !== 'Account' && record.MetaData?.LastUpdatedTime) value.configurationUpdatedAt=record.MetaData.LastUpdatedTime;
  if (entity === 'Account') need(record.Active === true && record.AccountType === 'Other Current Liability' && record.AccountSubType === 'GlobalTaxPayable' && record.CurrencyRef?.value === 'CAD', 'Observed native tax control is no longer an active CAD global-tax payable account.');
  return value;
}
async function one(Model, filter, session=null) {
  need(Model?.findOne, 'Native tax proof storage or linked admission audit is unavailable.');
  let q=Model.findOne(filter); if(session)q=q.session(session); return q.maxTimeMS(3000).lean();
}
async function loadProof({Authorities,Audits,scope,now=Date.now(),session=null}) {
  if(!Authorities)return null;
  let q=Authorities.findOne({...scope,'payload.kind':KIND}).sort({createdAt:-1,_id:-1});if(session)q=q.session(session);
  const row=await q.maxTimeMS(3000).lean();if(!row)return null;
  const p=row.payload;
  need(row.contractVersion === 1 && sameScope(row,scope) && sameScope(p?.scope,scope) && p.kind === KIND && p.version === 1 && p.revoked !== true && row.contentHash === hash(p), 'Latest retained native tax proof changed or has the wrong scope.');
  age(p.observedAt,now); age(p.admittedAt,now);
  need(Date.parse(p.observedAt) <= Date.parse(p.admittedAt) + 120000, 'Native proof admission predates its observation.');
  need(ID.test(p.actorId||'') && ID.test(p.ownerId||'') && String(row.actorId) === p.actorId && HEX.test(p.captureSha256||'') && HEX.test(p.rawResponseSha256||''), 'Native proof actor or observation binding changed.');
  need(Array.isArray(p.associations) && p.associations.length > 0 && p.associations.length <= 100 && new Set(p.associations.map(a=>a.agencyId)).size === p.associations.length && new Set(p.associations.map(a=>a.accountId)).size === p.associations.length && p.associations.every(a=>QID.test(a.agencyId||'')&&QID.test(a.accountId||'')&&a.agency?.Id===a.agencyId&&a.account?.Id===a.accountId), 'Retained native tax associations are incomplete or duplicated.');
  need(Array.isArray(p.uncoveredAgencyIds) && p.uncoveredAgencyIds.length <= 1000 && new Set(p.uncoveredAgencyIds).size === p.uncoveredAgencyIds.length && p.uncoveredAgencyIds.every(id=>QID.test(id||'')&&!p.associations.some(a=>a.agencyId===id)), 'Retained uncovered native agencies are invalid or overlap a proven association.');
  need(p.observer && Object.keys(p.observer).every(k=>['actor','identityVerified','identityHash','companyVerified','leaseOwnerHash'].includes(k)) && ['codex-cli','claude-code'].includes(p.observer?.actor) && p.observer.identityVerified === true && p.observer.companyVerified === true && HEX.test(p.observer.identityHash||'') && HEX.test(p.observer.leaseOwnerHash||'') && HEX.test(p.queryHash||''), 'Retained native observer attestation is missing or invalid.');
  const audit=await one(Audits,{_id:row.auditId,realmId:scope.realmId},session);
  need(audit && audit.action === ACTION && audit.actionType === 'manual' && audit.outcome === 'success' && String(audit.userId) === p.ownerId && String(audit.actorUserId||audit.userId) === p.actorId && sameScope(audit.inputParams,scope) && audit.inputParams.captureSha256 === p.captureSha256 && audit.inputParams.observer === p.observer.actor && audit.afterState?.authorityId === String(row._id) && audit.afterState.proofHash === row.contentHash && audit.afterState.captureSha256 === p.captureSha256, 'Native tax proof has no matching scoped successful admission audit.');
  need(Number.isFinite(Date.parse(audit.createdAt)) && Date.parse(audit.createdAt) >= Date.parse(p.admittedAt) - 120000 && Date.parse(audit.createdAt) <= Date.parse(p.admittedAt) + 120000, 'Native proof audit time differs from its reviewed admission.');
  return {...clone(p),authorityId:String(row._id),contentHash:row.contentHash};
}
async function admitProof({models,access,transaction,copy,scope,actorId,ownerId,captureBytes,reviewedCaptureSha256,now=()=>Date.now()}) {
  scope=scoped(scope);
  need((Buffer.isBuffer(captureBytes)||typeof captureBytes==='string')&&ID.test(actorId||'')&&ID.test(ownerId||'')&&HEX.test(reviewedCaptureSha256||''),'Reviewed native capture bytes and authenticated actor are required.');
  const bytes=Buffer.from(captureBytes);need(bytes.length>0&&bytes.length<=1000000,'Native capture exceeds its exact evidence budget.');
  const captureSha256=crypto.createHash('sha256').update(bytes).digest('hex');need(captureSha256===reviewedCaptureSha256,'Native capture bytes differ from the reviewed digest.');
  let capture;try{capture=JSON.parse(bytes.toString('utf8'));}catch{need(false,'Native capture is not valid JSON.');}
  const observed=parseCapture(capture,scope,now());
  await access.authorize(scope,'reports.manual.record');
  const associations=[];
  for(const row of observed.agencies) {
    const agency=configuration('TaxAgency',await copy.read(scope,'TaxAgency',row.agencyId),row.agencyId);
    const account=configuration('Account',await copy.read(scope,'Account',row.accountId),row.accountId);
    associations.push({...row,agency,account});
  }
  const payload={version:1,kind:KIND,scope,actorId,ownerId,observedAt:observed.observedAt,admittedAt:new Date(now()).toISOString(),captureSha256,queryHash:observed.queryHash,rawResponseSha256:observed.rawResponseSha256,observer:observed.observer,uncoveredAgencyIds:observed.uncoveredAgencyIds,provenance:'Reviewed local native observation; hashes/audit retain integrity, not signed provider authentication.',associations};
  const contentHash=hash(payload),authorityId=contentHash.slice(0,24),auditId=hash({kind:KIND,contentHash}).slice(0,24);
  await transaction(async session=>{
    const actor=await access.authorize(scope,'reports.manual.record',{session});
    need(actor.actorId===actorId&&actor.ownerId===ownerId,'Native tax admission actor or owner changed.');
    const old=await one(models.Authorities,{_id:authorityId,...scope},session);
    if(old){need(old.contentHash===contentHash,'Native tax admission identity conflict.');return;}
    await models.Audits.create([{_id:auditId,userId:ownerId,...(actorId!==ownerId?{actorUserId:actorId}:{}),realmId:scope.realmId,action:ACTION,actionType:'manual',outcome:'success',inputParams:{...scope,captureSha256,observer:observed.observer.actor},afterState:{authorityId,proofHash:contentHash,captureSha256},createdAt:new Date(now())}],{session});
    await models.Authorities.create([{_id:authorityId,contractVersion:1,...scope,contentHash,payload,actorId,auditId}],{session});
  });
  return {authorityId,contentHash,associations:associations.map(({agencyId,accountId})=>({agencyId,accountId}))};
}
async function contextFor({proof,scope,rateIds,copy}) {
  const rates=[],agencies=[],accounts=[],map=new Map(),seenAgencies=new Set();
  for(const rateId of rateIds) {
    const rate=configuration('TaxRate',await copy.read(scope,'TaxRate',rateId),rateId), agencyId=rate.AgencyRef?.value;
    need(QID.test(agencyId||''),'Fresh tax rate has no exact agency reference.');
    const row=proof.associations.find(a=>a.agencyId===agencyId);need(row,'The tax rate agency has no retained native control-account association.');
    if(!seenAgencies.has(agencyId)) {
      const agency=configuration('TaxAgency',await copy.read(scope,'TaxAgency',agencyId),agencyId),account=configuration('Account',await copy.read(scope,'Account',row.accountId),row.accountId);
      const {configurationUpdatedAt: _postingTimestamp,...retainedAccount}=row.account;
      need(canonical(agency)===canonical(row.agency)&&canonical(account)===canonical(retainedAccount),'Native tax agency/control configuration changed; retain a fresh native association proof.');
      seenAgencies.add(agencyId);agencies.push(agency);accounts.push(account);
    }
    rates.push(rate);map.set(rateId,row.accountId);
  }
  return {taxAccount:rateId=>{need(map.has(String(rateId)),'Exact current tax rate is missing from the native account proof context.');return map.get(String(rateId));},evidence:{authorityId:proof.authorityId,contentHash:proof.contentHash,observedAt:proof.observedAt,captureSha256:proof.captureSha256,rates,agencies,accounts}};
}
module.exports={KIND,ACTION,MAX_AGE_MS,parseCapture,configuration,loadProof,admitProof,contextFor};
