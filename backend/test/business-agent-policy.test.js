'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateControl,reduceControl,businessBlockers,DEFAULT_SETTINGS}=require('../src/modules/business-agent-policy');
const ownerId='a'.repeat(24),authorityHash='b'.repeat(64),clock=Date.parse('2026-10-23T15:00:00.000Z');
const business={scope:{environment:'production'},authorityHash};
const row={_id:'c'.repeat(24),settings:{...DEFAULT_SETTINGS,monitoring:true},grant:null};
const command=(name,rest={})=>({command:name,expectedRevision:0,requestKey:'fixture_request_0001',...rest});
test('control schema refuses company, authority and nested unknown overrides',()=>{
  assert.throws(()=>validateControl(command('pause',{realmId:'foreign'})),/exact/);
  assert.throws(()=>validateControl(command('save-instructions',{settings:{instructions:'hi',autonomous:true}})),/exact/);
  assert.throws(()=>validateControl(command('configure-specialists',{settings:{specialists:['receivables','receivables']}})),/at most once/);
  assert.throws(()=>validateControl(command('configure',{settings:{syncIntervalSeconds:1,decisionIntervalMinutes:60}})),/interval/);
});
test('standing authority is company-policy bound, explicit in Production and has no expiry or lifetime record quota',()=>{
  assert.throws(()=>reduceControl(row,command('enable-autonomy',{confirmProduction:false}),business,clock,ownerId),/Production/);
  const granted=reduceControl(row,command('enable-autonomy',{confirmProduction:true}),business,clock,ownerId);
  assert.equal(granted.settings.autonomous,true);assert.equal(granted.grant.authorityHash,authorityHash);assert.equal(granted.grant.ownerId,ownerId);assert.match(granted.grant.id,/^[a-f0-9]{64}$/);
  assert.equal('expiresAt' in granted.grant,false);assert.equal('maxTransactions' in granted.settings,false);
});
test('pause keeps monitoring, while stopping monitoring also revokes autonomous dispatch',()=>{
  const active={...row,settings:{...row.settings,autonomous:true}};
  assert.deepEqual(reduceControl(active,command('pause'),business,clock,ownerId).settings,{...active.settings,autonomous:false});
  const stopped=reduceControl(active,command('stop-monitoring'),business,clock,ownerId);assert.equal(stopped.settings.monitoring,false);assert.equal(stopped.settings.autonomous,false);
});
test('resume retains standing grant and rejects changed published business',()=>{
  const granted=reduceControl(row,command('enable-autonomy',{confirmProduction:true}),business,clock,ownerId);
  assert.throws(()=>reduceControl({...row,grant:granted.grant},command('resume'),{...business,authorityHash:'d'.repeat(64)},clock,ownerId),/renew/);
  const resumed=reduceControl({...row,grant:granted.grant},command('resume'),business,clock,ownerId);assert.equal(resumed.settings.autonomous,true);assert.equal(resumed.grant,undefined);
});
test('populated history and unresolved original work cannot look like an empty starting company',()=>{
  const blockers=businessBlockers({calendar:{authorityHash,verifiedThrough:null},writer:{populationDelegation:{jobId:'saved'},unresolved:{key:'possible'}},job:{status:'populated'},run:{status:'blocked',lastError:'Keep original records'},policy:{state:'active'}});
  assert.deepEqual(blockers.map(row=>row.code),['uncertain-write','population-owned','current-operation','history-uncommitted']);assert.match(blockers.at(-1).detail,/do not rebuild/);
});
