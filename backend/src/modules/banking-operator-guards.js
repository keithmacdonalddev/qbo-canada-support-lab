'use strict';
const {hash}=require('./banking-workspace-service');
const TXNS=new Set(['Invoice','Payment','BillPayment','SalesReceipt','RefundReceipt','Purchase','Deposit','Transfer','CreditCardPayment','TaxPayment','JournalEntry']);
const sameScope=(a,b)=>['environment','realmId','connectionId'].every(k=>String(a?.[k])===String(b?.[k]));
function check(ok,message,detail){if(!ok)throw Object.assign(new Error(message),{code:'BANKING_OPERATOR_BLOCKED',status:409,bankingDetail:detail});}
function assertRulesSafe(value,{scope,accountId,accountName,accountFullName,accounts=[],packageId,fileId,startedAt,now}) {
  check(value?.complete===true && sameScope(value.scope,scope) && value.accountId===accountId && Array.isArray(value.rules) && Date.parse(value.observedAt)>=Date.parse(startedAt) && Date.parse(value.observedAt)<=Date.parse(now),'Complete fresh Banking > Rules inspection required');
  for(const r of value.rules) {
    check(typeof r.name==='string' && r.name.trim() && typeof r.active==='boolean' && typeof r.autoPost==='boolean' && typeof r.allAccounts==='boolean' && Array.isArray(r.accountIds) && r.accountIds.every(id=>typeof id==='string' && /^\d+$/.test(id)) && Array.isArray(r.conditions) && r.conditions.length>0 && (r.allAccounts || r.accountIds.length>0 || Array.isArray(r.accountNames) && r.accountNames.length>0 && r.accountNames.every(n=>typeof n==='string' && n.trim())), 'Unknown bank-rule name, conditions, status, Auto-post or account scope; refuse upload');
  }
  const coverage=value.coverage;
  check(coverage?.filter==='all' && coverage.includesActive===true && coverage.includesDisabled===true && Array.isArray(coverage.pages) && coverage.pages.length>0 && coverage.pages.every((p,i)=>p.page===i+1 && p.pageCount===coverage.pages.length && Number.isInteger(p.ruleCount) && p.ruleCount>=0 && typeof p.screenshot==='string' && p.screenshot) && coverage.totalRules===value.rules.length && coverage.pages.reduce((n,p)=>n+p.ruleCount,0)===value.rules.length, 'Complete visible rules list across every page and both statuses required');
  const rulesHash=hash(value.rules),ruleKeys=value.rules.map(r=>hash({name:r.name,active:r.active,autoPost:r.autoPost,allAccounts:r.allAccounts,accountIds:r.accountIds,accountNames:r.accountNames || [],conditions:r.conditions}));
  // Name/visible account scope is the native identity. Internal IDs need not be
  // exposed by QBO. Unknown predicates never make an active Auto-post rule safe.
  const normalize=n=>n.trim().replace(/\s+/g,' ').toLowerCase();
  const catalog=[...accounts,{Id:accountId,Name:accountName,FullyQualifiedName:accountFullName}];
  const resolved=value.rules.map(r=>{
    const ids=new Set(r.accountIds);
    for(const name of r.accountNames || []){
      check(!/\.\.\.|…/.test(name),'Clipped applied-to account name; refuse upload');
      const matches=new Set(catalog.filter(a=>[a.Name,a.FullyQualifiedName].some(n=>typeof n==='string' && normalize(n)===normalize(name))).map(a=>String(a.Id)));
      check(matches.size===1,'Unknown or ambiguous applied-to account name: '+name+'; refuse upload');
      ids.add([...matches][0]);
    }
    return [...ids];
  });
  const applicable=value.rules.filter((r,i)=>r.active && r.autoPost && (r.allAccounts || resolved[i].includes(accountId)));
  check(!applicable.length,'Upload blocked by active Auto-post rules: '+applicable.map(r=>r.name).join(', '),{ruleNames:applicable.map(r=>r.name),rulesHash});
  return {...value,rulesHash,ruleKeys,deliberateScenario:false};
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
