'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assertRunApproval}=require('../src/modules/business-period-store');
const planHash='f'.repeat(64),actorId='b'.repeat(24),scope={environment:'production',realmId:'123',connectionId:'a'.repeat(24)};
const approved=()=>({...scope,planHash,approval:{actorId,planHash,fenceHash:'d'.repeat(64),auditId:'approval-audit',approvedAt:'2026-10-15T12:00:00.000Z',productionConsent:{confirmed:true,...scope,actorId,planHash}}});
test('business execution requires explicit consent bound to the exact real company, actor and plan',()=>{
 assert.doesNotThrow(()=>assertRunApproval(approved()));
 for(const change of [{confirmed:false},{environment:'sandbox'},{realmId:'999'},{connectionId:'c'.repeat(24)},{actorId:'e'.repeat(24)},{planHash:'0'.repeat(64)}]){const run=approved();Object.assign(run.approval.productionConsent,change);assert.throws(()=>assertRunApproval(run),/Production/);}
 const missing=approved();delete missing.approval.productionConsent;assert.throws(()=>assertRunApproval(missing),/Production/);
 const sandbox=approved();sandbox.environment='sandbox';delete sandbox.approval.productionConsent;assert.doesNotThrow(()=>assertRunApproval(sandbox));
});
