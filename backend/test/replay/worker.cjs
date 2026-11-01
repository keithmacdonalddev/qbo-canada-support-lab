'use strict';
// A disposable offline process: no database sockets, provider transport, child
// commands, filesystem writes, or inherited credentials.
const deny=()=>{throw Object.assign(Error('Replay I/O forbidden'),{code:'REPLAY_IO_FORBIDDEN'});};
for(const name of ['net','tls','http','https','http2','dgram','dns']) {
 const mod=require('node:'+name);
 for(const key of ['connect','createConnection','request','get','createServer','createSocket','lookup','resolve','resolve4','resolve6'])if(typeof mod[key]==='function')mod[key]=deny;
 if(name==='net')mod.Socket.prototype.connect=deny;
}
global.fetch=deny;global.WebSocket=class {constructor(){deny();}};
const cp=require('node:child_process');
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=deny;
const fs=require('node:fs');
for(const key of ['writeFile','writeFileSync','appendFile','appendFileSync','mkdir','mkdirSync','rm','rmSync','unlink','unlinkSync','rename','renameSync','createWriteStream'])if(typeof fs[key]==='function')fs[key]=deny;
for(const key of ['writeFile','appendFile','mkdir','rm','unlink','rename'])fs.promises[key]=deny;
const readonlyFlags=flags=>typeof flags==='string'?['r','rs','sr'].includes(flags):Number.isInteger(flags)&&(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))===0;
for(const key of ['open','openSync']){const original=fs[key];fs[key]=function(file,flags,...args){if(!readonlyFlags(flags))return deny();return original.call(this,file,flags,...args);};}
const originalOpen=fs.promises.open;fs.promises.open=async(file,flags,...args)=>{if(!readonlyFlags(flags))return deny();return originalOpen(file,flags,...args);};
process.on('message',async input=>{
 try {
   const {replayDataset}=require('./harness.cjs');
   const report=await replayDataset(input);

   if(input.proveActivityChoices) {
     const {checkChoices}=require('./harness.cjs'),{safeError}=require('./runtime.cjs');
     report.regressionProof={};
     for(const [name,from,to] of [
       ['96fe35a-single-use-query','maxTimeMS(3000).lean().exec();','maxTimeMS(3000).lean();'],
       ['96fe35a-non-json-records','JSON.parse(JSON.stringify(row.record))','structuredClone(row.record)']
     ]) {
       try {
         await checkChoices({root:input.root,data:input.bundle.data,capturedAt:input.bundle.capturedAt,features:input.features,
           transform:(filename,source)=>{
             if(!filename.endsWith('business-activity-choice-client.js'))return source;
             if(!source.includes(from))throw Object.assign(Error(),{code:'REPLAY_BUG_DOUBLE_NOT_APPLICABLE'});
             return source.replace(from,to);
           }});
         report.regressionProof[name]={caught:false};
       }catch(error){report.regressionProof[name]={caught:error.code!=='REPLAY_BUG_DOUBLE_NOT_APPLICABLE',errorDetail:safeError(error,'activity-choices-bug-double')};}
     }
     report.regressionProof.currentPassed=report.preflight?.every(p=>p.status==='passed')===true;
     report.regressionProof.proved=report.regressionProof.currentPassed&&report.regressionProof['96fe35a-single-use-query'].caught;
   }

   process.send(report,()=>process.exit(report.passed?0:1));
 } catch(error) {
   const {safeError}=require('./runtime.cjs');
   process.send({version:1,passed:false,errorDetail:safeError(error,'worker')},()=>process.exit(1));
 }
});
