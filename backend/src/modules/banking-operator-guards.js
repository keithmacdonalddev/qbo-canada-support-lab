'use strict';
const {hash}=require('./banking-workspace-service');
const TXNS=new Set(['Invoice','Payment','BillPayment','SalesReceipt','RefundReceipt','Purchase','Deposit','Transfer','CreditCardPayment','TaxPayment','JournalEntry']);
const sameScope=(a,b)=>['environment','realmId','connectionId'].every(k=>String(a?.[k])===String(b?.[k]));
function check(ok,message,detail){if(!ok)throw Object.assign(new Error(message),{code:'BANKING_OPERATOR_BLOCKED',status:409,bankingDetail:detail});}
function assertRulesSafe(value,{scope,accountId,packageId,fileId,startedAt,now,scenario=null}) {
  check(value?.complete===true && sameScope(value.scope,scope) && value.accountId===accountId && Array.isArray(value.rules) && Date.parse(value.observedAt)>=Date.parse(startedAt) && Date.parse(value.observedAt)<=Date.parse(now),'Complete fresh Banking > Rules inspection required');
  const ids=new Set();
  for(const r of value.rules) {
    check(typeof r.ruleId==='string' && r.ruleId && !ids.has(r.ruleId) && r.name && typeof r.active==='boolean' && typeof r.autoPost==='boolean' && typeof r.allAccounts==='boolean' && Array.isArray(r.accountIds) && r.accountIds.every(id=>typeof id==='string' && /^\d+$/.test(id)) && (r.allAccounts || r.accountIds.length>0),'Unknown bank-rule status, Auto-post or account scope; refuse upload');
    ids.add(r.ruleId);
  }
  // Conservative: conditions may be broad or hidden. Any active Auto-post rule on
  // this account could apply. Never infer safety from names or amount predicates.
  const applicable=value.rules.filter(r=>r.active && r.autoPost && (r.allAccounts || r.accountIds.includes(accountId)));
  const deliberate=scenario?.deliberate===true && fileId && scenario.fileId===fileId && scenario.packageId===packageId && scenario.accountId===accountId && scenario.rulesHash===hash(value.rules) && Array.isArray(scenario.ruleIds) && applicable.every(r=>scenario.ruleIds.includes(r.ruleId));
  check(!applicable.length || deliberate,'Upload blocked by active Auto-post rules: '+applicable.map(r=>r.name+' ['+r.ruleId+']').join(', '),{ruleIds:applicable.map(r=>r.ruleId)});
  return {...value,applicableRuleIds:applicable.map(r=>r.ruleId),deliberateScenario:deliberate || false};
}
function touchesAccount(record,id){
  if(!record || typeof record!=='object')return false;
  return Object.entries(record).some(([k,v])=>/AccountRef$/.test(k) && String(v?.value)===id || (v && typeof v==='object' && touchesAccount(v,id)));
}
function assertNoUnexpectedRecords({before,after,scope,accountId,startedAt,allowed=[]}){
  for(const [name,v] of [['before',before],['after',after]]) {
    check(v?.complete===true && sameScope(v.scope,scope) && Array.isArray(v.records),'Duplicate guard needs a complete scoped synced copy ('+name+')');
    check(v.records.every(r=>sameScope(r,scope) && r.entity && typeof r.qboId==='string'),'Synced copy contains invalid or cross-company records');
  }
  check(Date.parse(after.syncedThrough)>=Date.parse(startedAt),'Sync has not caught up after the action; never repeat Add/Match');
  const prior=new Set(before.records.map(r=>r.entity+':'+r.qboId));
  const added=after.records.filter(r=>!r.deleted && TXNS.has(r.entity) && !prior.has(r.entity+':'+r.qboId) && touchesAccount(r.record,accountId));
  const unexpected=added.filter(r=>!allowed.some(a=>a.entity===r.entity && a.id===r.qboId));
  check(!unexpected.length,'Unexpected new accounting record in account '+accountId+': '+unexpected.map(r=>r.entity+' '+r.qboId).join(', ')+'; account blocked, do not retry or undo automatically',{unexpected:unexpected.map(r=>({entity:r.entity,id:r.qboId}))});
  return {accountId,newRecords:added.map(r=>({entity:r.entity,id:r.qboId})),unexpected:[]};
}
module.exports={assertRulesSafe,assertNoUnexpectedRecords,touchesAccount,TXNS};
