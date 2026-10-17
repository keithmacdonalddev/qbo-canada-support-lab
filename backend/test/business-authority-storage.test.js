'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Authority=require('../src/models/BusinessAuthority');
const {hash}=require('../src/modules/business-calendar');
const {fixture,scope,ownerId,now,clone}=require('./helpers/business-link-repair-fixture');
function payload(kind){const p=clone(fixture().plan);p.kind=kind;p.before.invoice.record.Line.push({Amount:250,DetailType:'SubTotalLineDetail',SubTotalLineDetail:{}});p.parentLedgers=[{report:{Header:{ReportName:'GeneralLedger'},Rows:{}}}];return p;}
for(const kind of ['business-link-repair-plan','business-link-repair-outcome'])test('native authority serialization preserves exact '+kind+' JSON including empty provider objects',async()=>{
 const value=payload(kind),contentHash=hash(value),doc=new Authority({contractVersion:1,...scope,actorId:ownerId,auditId:'d'.repeat(24),contentHash,payload:value,createdAt:new Date(now)});await doc.validate();
 assert.equal(Authority.schema.options.minimize,false);assert.equal(typeof doc.connectionId.toHexString,'function');assert.ok(doc.createdAt instanceof Date);
 for(const roundtrip of [doc.toObject(),doc.toBSON(),JSON.parse(JSON.stringify(doc)),Authority.hydrate(doc.toObject()).toObject()]){assert.deepEqual(roundtrip.payload,value);assert.equal(hash(roundtrip.payload),contentHash);assert.deepEqual(roundtrip.payload.parentLedgers[0].report.Rows,{});assert.deepEqual(roundtrip.payload.before.invoice.record.Line.at(-1).SubTotalLineDetail,{});}
 assert.notEqual(hash(doc.toObject({minimize:true}).payload),contentHash,'the native legacy option reproduces the observed storage loss');
});
test('authority hash validation still rejects changed content before storage',async()=>{const value=payload('business-link-repair-plan'),doc=new Authority({contractVersion:1,...scope,actorId:ownerId,auditId:'d'.repeat(24),contentHash:hash(value),payload:value});doc.payload.reason+=' changed';await assert.rejects(doc.validate(),/Retained authority content changed/);});
