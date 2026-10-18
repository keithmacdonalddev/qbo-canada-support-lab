'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {withWriteWorkflow,claimWriteWorkflow}=require('../src/modules/qbo-write-workflow');
const workflow={version:1,kind:'reproduction',sessionId:'a'.repeat(24),planId:'b'.repeat(24),stepNumber:1};
test('write correlation is isolated, server-validated and consumed once per case change',async()=>{assert.equal(claimWriteWorkflow(),null);await withWriteWorkflow(workflow,async()=>{},async()=>{const context=claimWriteWorkflow();assert.deepEqual(context.workflow,workflow);await Promise.resolve();assert.throws(()=>claimWriteWorkflow(),/more than one/);});assert.equal(claimWriteWorkflow(),null);assert.throws(()=>withWriteWorkflow({...workflow,planId:'bad'},()=>{},()=>{}),/exact saved/);});

test('population repair correlation binds an immutable exact authority and is consumed once',async()=>{const repair={version:1,kind:'population-link-repair',authorityHash:'c'.repeat(64)};await withWriteWorkflow(repair,async()=>{},async()=>{assert.deepEqual(claimWriteWorkflow().workflow,repair);assert.throws(()=>claimWriteWorkflow(),/more than one/);});for(const bad of [{...repair,authorityHash:'bad'},{...repair,jobId:'d'.repeat(24)}])assert.throws(()=>withWriteWorkflow(bad,()=>{},()=>{}),/immutable/);});
