'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const modules=process.env.BF7_MODULE_ROOT || path.resolve(__dirname,'../src/modules');
const {recoverBankingLocks,verifyRetainedRunStopped}=require(path.join(modules,'banking-operator-recovery'));
const {createFileJournal}=require(path.join(modules,'banking-operator'));
const {fileStateStore,readBankingLoopStatus}=require(path.join(modules,'banking-operator-loop'));
const stop=require('./fixtures/banking-bl-real-stop.json');
async function locks(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bl-locks-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const [name,file,data] of [['qbo-terra-live.lock','owner.txt','terra-live-'+stop.journal.runId+'-54135-1793511849\n'],['qbo-banking-operator.lock','owner.json',JSON.stringify({pid:58412})]]){await fs.mkdir(path.join(dir,name));await fs.writeFile(path.join(dir,name,file),data);}
 const out=path.join(dir,'artifacts/terra-live',stop.journal.runId+'-20261101-014409');await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'pids.txt'),'86672 codex.exe\n9364 node.exe\n');
 return {temp:dir,root:dir,out,scanProcesses:async()=>[{pid:10,parent:0,terra:false}]};
}
test('BL verifies old owner, every Terra run and sampled unmarked helpers dead before clearing both locks',async t=>{
 const opts=await locks(t);
 for(const live of [{pid:58412,parent:0,terra:false},{pid:20,parent:0,terra:true},{pid:9364,parent:0,terra:false},{pid:30,parent:9364,terra:false}]){
  assert.equal((await recoverBankingLocks({...opts,scanProcesses:async()=>[live]})).busy,true);assert.ok(await fs.stat(path.join(opts.temp,'qbo-terra-live.lock')));
 }
 const result=await recoverBankingLocks(opts);assert.equal(result.busy,false);assert.equal(result.recovered.length,2);await assert.rejects(fs.stat(path.join(opts.temp,'qbo-terra-live.lock')),{code:'ENOENT'});
});
test('BL process enumeration denial/missing sampling retain lock; changed owner cannot be removed',async t=>{
 const opts=await locks(t);await assert.rejects(recoverBankingLocks({...opts,scanProcesses:async()=>{throw new Error('denied');}}),/denied/);assert.ok(await fs.stat(path.join(opts.temp,'qbo-terra-live.lock')));
 let scans=0;await assert.rejects(recoverBankingLocks({...opts,scanProcesses:async()=>{if(++scans===2)await fs.writeFile(path.join(opts.temp,'qbo-terra-live.lock/owner.txt'),'changed');return [{pid:10,terra:false}];}}),/changed during recovery/);
 await fs.writeFile(path.join(opts.temp,'qbo-terra-live.lock/owner.txt'),'terra-live-'+stop.journal.runId+'-54135-1793511849\n');await fs.unlink(path.join(opts.out,'pids.txt'));await assert.rejects(recoverBankingLocks(opts));
});
test('BL stale recovery mutex has PID ownership; live owner and incomplete publication defer safely',async t=>{
 const opts=await locks(t),dir=path.join(opts.temp,'qbo-banking-recovery.9999.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.lock');await fs.mkdir(dir);
 assert.equal((await recoverBankingLocks({...opts,scanProcesses:async()=>[{pid:9999,terra:false}]})).busy,true);
 assert.equal((await recoverBankingLocks(opts)).busy,false);
 const fresh=await locks(t);await fs.unlink(path.join(fresh.temp,'qbo-banking-operator.lock/owner.json'));assert.equal((await recoverBankingLocks(fresh)).busy,true);
});
test('BL journal finish survives leftover crash temporary file',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bl-journal-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const journal=createFileJournal(dir),entry=structuredClone(stop.journal);await journal.start(entry);await fs.writeFile(path.join(dir,entry.runId+'.json.tmp'),'crash');await journal.finish({...entry,status:'blocked',reason:stop.result.reason});assert.equal((await journal.list(entry.scope,'60'))[0].status,'blocked');assert.equal(await fs.readFile(path.join(dir,entry.runId+'.json.tmp'),'utf8'),'crash');
});
test('BL heartbeat API persists timestamps/outcome and hides unauthorized account diagnostics',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bl-heartbeat-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=fileStateStore(path.join(dir,'artifacts/banking/operator-loop-state.json')),lastTickAt='2026-11-01T07:00:00Z',lastRunAt='2026-11-01T06:59:00Z';await store.write({status:'blocked',packageId:stop.result.packageId,lastTickAt,lastRunAt,lastOutcome:{status:'blocked',packageId:stop.result.packageId,reason:stop.result.reason}});
 const visible=await readBankingLoopStatus({root:dir,enabled:true,packages:[{id:stop.result.packageId}]});assert.equal(visible.lastTickAt,lastTickAt);assert.equal(visible.lastRunAt,lastRunAt);assert.equal(visible.lastOutcome.reason,stop.result.reason);
 const hidden=await readBankingLoopStatus({root:dir,enabled:true,packages:[]});assert.ok(!JSON.stringify(hidden).includes(stop.result.packageId));assert.ok(!JSON.stringify(hidden).includes(stop.result.reason));
});

test('BL retained run is checked independently even when wrapper lock already disappeared',async t=>{
 const opts=await locks(t);await assert.rejects(verifyRetainedRunStopped(opts.root,stop.journal,async()=>[{pid:9364,parent:0,terra:false}]),/still live/);await verifyRetainedRunStopped(opts.root,stop.journal,opts.scanProcesses);
});
