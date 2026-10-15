'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAccountRecovery,assertPrivatePassword}=require('../src/modules/account-recovery');
const {createAccountAutomationReview}=require('../src/modules/account-automation-review');
const {RESERVED_EMAIL,accountEligible}=require('../src/modules/account-policy');
const {args,assertBackendStopped}=require('../../scripts/security/recover-account.cjs');
const id='b'.repeat(24),other='c'.repeat(24);
const clone=value=>structuredClone(value),at=(row,key)=>key.split('.').reduce((value,part)=>value?.[part],row);
const matches=(row,filter)=>row&&Object.entries(filter).every(([key,value])=>key==='$or'?value.some(item=>matches(row,item)):key==='$and'?value.every(item=>matches(row,item)):value&&typeof value==='object'?('$exists' in value?(at(row,key)!==undefined)===value.$exists:'$gt' in value?at(row,key)>value.$gt:false):at(row,key)===value);
function fixture(){
  const h={data:{Users:[{_id:id,email:RESERVED_EMAIL,role:'supervisor',password:'old-hash',authVersion:0,connectionSwitchVersion:0}],Audits:[],Work:[{_id:'operation-1',createdBy:id,realmId:'123',environment:'production',status:'approved',planHash:'a'.repeat(64),executionRequest:{pending:true,id:'request-1'}}]}};
  h.models=Object.fromEntries(Object.keys(h.data).map(name=>[name,{
    findById(value){return this.findOne({_id:value});},
    findOne(filter){const query={select(){return query;},session(){return query;},maxTimeMS(){return query;},lean:async()=>clone(h.data[name].find(row=>matches(row,filter))||null)};return query;},
    find(filter){let limit=Infinity;const query={select(){return query;},sort(){return query;},session(){return query;},maxTimeMS(){return query;},limit(value){limit=value;return query;},lean:async()=>clone(h.data[name].filter(row=>matches(row,filter)).sort((a,b)=>String(a._id).localeCompare(String(b._id))).slice(0,limit))};return query;},
    async updateOne(filter,update,options){assert.ok(options.session);if(h.conflict)return{matchedCount:0};const row=h.data[name].find(item=>matches(item,filter));if(!row)return{matchedCount:0};Object.assign(row,clone(update.$set||{}));for(const key of Object.keys(update.$unset||{}))delete row[key];for(const [key,value]of Object.entries(update.$inc||{}))row[key]=(row[key]??0)+value;return{matchedCount:1};},
    async create(rows,options){assert.ok(options.session);if(h.failAudit)throw Error('fixture audit failure');h.data[name].push(...clone(rows));},
  }]));
  let queue=Promise.resolve();h.transaction=work=>{const result=queue.then(async()=>{const before=clone(h.data);try{return await work({inTransaction:()=>true});}catch(error){h.data=before;throw error;}});queue=result.catch(()=>{});return result;};
  h.recovery=createAccountRecovery({targetFingerprint:'f'.repeat(64),Users:h.models.Users,Audits:h.models.Audits,transaction:h.transaction,hashPassword:async()=> 'new-private-hash'});
  h.automation=createAccountAutomationReview({Users:h.models.Users,Audits:h.models.Audits,transaction:h.transaction,sources:[{key:'business',label:'Business operations',Model:h.models.Work,filter:value=>({createdBy:value}),fields:'_id realmId status planHash executionRequest'}]});
  h.recover=async()=>h.recovery.apply({id,reviewHash:(await h.recovery.preview(id)).reviewHash,password:'a private fixture passphrase'});
  return h;
}
test('recovery preserves identity, role and work; revokes sessions and leaves automation paused',async()=>{
  const h=fixture(),work=clone(h.data.Work),preview=await h.recovery.preview(id);
  assert.equal(preview.role,'supervisor');assert.equal(JSON.stringify(preview).includes('old-hash'),false);
  const result=await h.recover();assert.equal(result.sessionsRevoked,true);assert.equal(result.automationAfterRecovery,'paused');
  const user=h.data.Users[0];assert.equal(user._id,id);assert.equal(user.role,'supervisor');assert.equal(user.password,'new-private-hash');assert.equal(user.authVersion,1);assert.equal(accountEligible(user),true);assert.equal(accountEligible(user,{automation:true}),false);assert.deepEqual(h.data.Work,work);assert.equal(h.data.Audits.length,1);assert.equal(JSON.stringify(h.data.Audits).includes('private-hash'),false);
});
test('stale recovery reviews, other accounts, invalid passwords and failed audits cannot partially change credentials',async()=>{
  for(const mutation of ['version','role','password','scope']){const h=fixture(),preview=await h.recovery.preview(id),user=h.data.Users[0];if(mutation==='version')user.authVersion++;if(mutation==='role')user.role='agent';if(mutation==='password')user.password='changed-hash';if(mutation==='scope')user.email='another@fixture.invalid';const before=clone(h.data);await assert.rejects(h.recovery.apply({id,reviewHash:preview.reviewHash,password:'a private fixture passphrase'}));assert.deepEqual(h.data,before);}
  const h=fixture(),before=clone(h.data);h.failAudit=true;await assert.rejects(h.recover(),/audit/);assert.deepEqual(h.data,before);await assert.rejects(h.recovery.preview(other),/not found/);
  for(const value of ['test-data-lab','short','é'.repeat(37),{},'a'.repeat(14)])assert.throws(()=>assertPrivatePassword(value));assert.doesNotThrow(()=>assertPrivatePassword('a private fixture passphrase'));
});
test('automation needs fresh retained-work review and explicit consent; uncertain work remains intact',async()=>{
  const h=fixture();await h.recover();const preview=await h.automation.review(id);assert.equal(preview.required,true);assert.equal(preview.groups[0].entries[0].pending,true);
  await assert.rejects(h.automation.enable(id,{reviewHash:preview.reviewHash}),/explicitly acknowledge/);
  h.data.Work[0].status='blocked';await assert.rejects(h.automation.enable(id,{reviewHash:preview.reviewHash,acknowledgeRetainedWork:true}),/changed/);assert.equal(accountEligible(h.data.Users[0],{automation:true}),false);
  const fresh=await h.automation.review(id),work=clone(h.data.Work);await h.automation.enable(id,{reviewHash:fresh.reviewHash,acknowledgeRetainedWork:true});assert.equal(accountEligible(h.data.Users[0],{automation:true}),true);assert.deepEqual(h.data.Work,work);assert.equal(h.data.Audits.length,2);assert.equal((await h.automation.review(id)).required,false);
});
test('automation audit failure and concurrent credential revocation cannot leave access enabled',async()=>{
  const h=fixture();await h.recover();const preview=await h.automation.review(id),before=clone(h.data);h.failAudit=true;await assert.rejects(h.automation.enable(id,{reviewHash:preview.reviewHash,acknowledgeRetainedWork:true}),/audit/);assert.deepEqual(h.data,before);h.failAudit=false;h.data.Users[0].authVersion++;await assert.rejects(h.automation.enable(id,{reviewHash:preview.reviewHash,acknowledgeRetainedWork:true}),/changed/);
  h.data.Users[0].email='ordinary@fixture.invalid';assert.equal((await h.automation.review(id)).enabled,true);
});
test('recovery command refuses password arguments and applying while a backend listener is present',async()=>{
  assert.deepEqual(args(['--user-id',id]),{'user-id':id});assert.throws(()=>args(['--user-id',id,'--password','never-an-argument']));assert.throws(()=>args(['--user-id',id,'--apply']));
  const server=require('node:net').createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{await assert.rejects(assertBackendStopped(server.address().port),/Stop the configured backend/);}finally{await new Promise(resolve=>server.close(resolve));}
});

test('completed history is digested in pages without imposing an account recovery cutoff',async()=>{
 const h=fixture();h.data.Work=[];for(let index=0;index<1251;index++)h.data.Work.push({_id:String(index).padStart(24,'0'),createdBy:id,realmId:'123',status:'verified'});
 await h.recover();const preview=await h.automation.review(id);assert.equal(preview.groups[0].total,1251);assert.equal(preview.groups[0].history.verified,1251);assert.equal(preview.groups[0].entries.length,0);
 await h.automation.enable(id,{reviewHash:preview.reviewHash,acknowledgeRetainedWork:true});assert.equal(accountEligible(h.data.Users[0],{automation:true}),true);
});

test('retained authorization review includes member-prepared plans approved by the recovered owner',async()=>{
 const h=fixture(),definition=require('../src/modules/account-automation-review').defaultSources().find(source=>source.key==='business');
 h.data.Work=[{_id:'operation-shared',createdBy:other,realmId:'123',status:'approved',approval:{actorId:id},executionRequest:null}];await h.recover();
 const service=createAccountAutomationReview({Users:h.models.Users,Audits:h.models.Audits,transaction:h.transaction,sources:[{...definition,Model:h.models.Work}]});
 const preview=await service.review(id);assert.equal(preview.groups[0].total,1);assert.equal(preview.groups[0].entries[0].id,'operation-shared');assert.equal(preview.groups[0].entries[0].status,'approved');
});

test('an exact enable retry returns the existing decision without another grant or audit',async()=>{
 const h=fixture();await h.recover();const body={reviewHash:(await h.automation.review(id)).reviewHash,acknowledgeRetainedWork:true};await h.automation.enable(id,body);const before=clone(h.data);
 const retry=await h.automation.enable(id,body);assert.equal(retry.enabled,true);assert.equal(retry.reused,true);assert.deepEqual(h.data,before);
 await h.recover();assert.equal(h.data.Users[0].automationReviewHash,undefined);await assert.rejects(h.automation.enable(id,body),/changed/);assert.equal(accountEligible(h.data.Users[0],{automation:true}),false);
});

test('storage target evidence excludes credential material and honors the normal DNS override',()=>{
 const {storageTarget,configureDatabaseDns}=require('../src/modules/storage-target');
 const first=storageTarget('mongodb+srv://fixture-user:fixture-password@cluster.fixture.invalid/lab?authSource=admin&password=private-query');
 const second=storageTarget('mongodb+srv://another:rotated@CLUSTER.fixture.invalid/lab?authMechanismProperties=SECRET%3Aother');
 assert.deepEqual(first,second);assert.deepEqual(first.descriptor,{scheme:'mongodb+srv',hosts:['cluster.fixture.invalid'],database:'lab',replicaSet:null,srvServiceName:'mongodb'});assert.equal(JSON.stringify(first).includes('password'),false);
 assert.notEqual(first.fingerprint,storageTarget('mongodb+srv://cluster.fixture.invalid/other').fingerprint);assert.notEqual(first.fingerprint,storageTarget('mongodb+srv://other.fixture.invalid/lab').fingerprint);
 assert.equal(storageTarget('mongodb://localhost/lab').fingerprint,storageTarget('mongodb://localhost:27017/lab').fingerprint);
 let servers;configureDatabaseDns(' 1.1.1.1, 8.8.8.8 ',{setServers:value=>{servers=value;}});assert.deepEqual(servers,['1.1.1.1','8.8.8.8']);
});

test('target fingerprints preserve the installed driver database and SRV selection semantics',()=>{
 const {storageTarget}=require('../src/modules/storage-target');
 assert.notEqual(storageTarget('mongodb://host/?dbName=prod').fingerprint,storageTarget('mongodb://host/?DBNAME=copy').fingerprint);
 assert.equal(storageTarget('mongodb://host/prod?dbName=ignored').fingerprint,storageTarget('mongodb://host/?dbName=prod').fingerprint);
 assert.notEqual(storageTarget('mongodb+srv://cluster.fixture.invalid/lab?srvServiceName=mongodb').fingerprint,storageTarget('mongodb+srv://cluster.fixture.invalid/lab?SRVSERVICENAME=other').fingerprint);
 assert.notEqual(storageTarget('mongodb://host/lab?replicaSet=one').fingerprint,storageTarget('mongodb://host/lab?replicaSet=two').fingerprint);
});

test('retained master approvals and uncertain attempts appear in account recovery review', async () => {
 const h=fixture(),definition=require('../src/modules/account-automation-review').defaultSources().find(source=>source.key==='masters');
 h.data.Work=[{_id:'master-stopped',ownerId:id,realmId:'123',state:'stopped',claim:'open',approval:{approvedAt:'fixture'},records:[{state:'verified'}]}, {_id:'master-unknown',ownerId:id,realmId:'123',state:'blocked',claim:'open',approval:null,records:[{state:'unknown'}]}, {_id:'master-closed',ownerId:id,realmId:'123',state:'closed',claim:'closed',approval:{approvedAt:'fixture'},records:[{state:'verified'}]}];await h.recover();
 const service=createAccountAutomationReview({Users:h.models.Users,Audits:h.models.Audits,transaction:h.transaction,sources:[{...definition,Model:h.models.Work}]});
 const preview=await service.review(id);assert.equal(preview.groups[0].total,3);assert.equal(preview.groups[0].entries.length,2);assert.equal(preview.groups[0].entries.find(row=>row.id==='master-unknown').uncertain,true);assert.equal(preview.groups[0].history.stopped,1);
});
