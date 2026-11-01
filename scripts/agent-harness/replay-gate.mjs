#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {digest}=require('../../backend/test/replay/loader.cjs');
const {loadStored}=require('../../backend/test/replay/loader.cjs');
const {safeError}=require('../../backend/test/replay/runtime.cjs');
export function parseArgs(args,now=Date.now()) {
 const options={since:new Date(now-3*86400000).toISOString(),ops:[],json:false};
 let days, explicitSince;
 for(let i=0;i<args.length;i++) {
   const arg=args[i];
   if(arg==='--json')options.json=true;
   else if(arg==='--prove-activity-choices')options.proveActivityChoices=true;
   else if(arg==='--help')options.help=true;
   else if(['--since','--days','--ops'].includes(arg)) {
     const value=args[++i];if(!value||value.startsWith('--'))throw Error('Missing '+arg);
     if(arg==='--since')explicitSince=value;
     if(arg==='--days')days=Number(value);
     if(arg==='--ops')options.ops=[...new Set(value.split(','))];
   } else throw Error('Unknown option');
 }
 if(days!==undefined && (!Number.isInteger(days)||days<1||days>31))throw Error('Invalid days');
 if(days!==undefined&&explicitSince)throw Error('Use days or since');
 if(days!==undefined)options.since=new Date(now-days*86400000).toISOString();
 if(explicitSince) {
   if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(explicitSince)||!Number.isFinite(Date.parse(explicitSince))||Date.parse(explicitSince)>now)throw Error('Invalid since');
   options.since=new Date(explicitSince).toISOString();
   if(!options.since.startsWith(explicitSince.slice(0,10)))throw Error('Invalid date');
 }
 if(options.ops.length>1000||options.ops.some(id=>!/^[a-f0-9]{24}$/.test(id)))throw Error('Invalid operation ids');
 return options;
}
let activeWorker;
export function runOffline(input,timeoutMs,onProgress=()=>{}) {
 return new Promise((resolve,reject)=>{
   // No Mongo URI, OAuth settings or AI keys enter the offline process environment.
   const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','PATH','Path'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
   const child=fork(path.join(root,'backend/test/replay/worker.cjs'),[],{
     cwd:root,windowsHide:true,serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],env,execArgv:[]
   });
   activeWorker=child;
   let result;
   const timer=setTimeout(()=>{child.kill();},timeoutMs);
   child.on('message',value=>{if(value?.type==='progress')onProgress(value);else result=value;});
   child.on('error',error=>{clearTimeout(timer);reject(error);});
   child.on('exit',(code,signal)=>{if(activeWorker===child)activeWorker=null;clearTimeout(timer);if(result)resolve(result);else reject(Object.assign(Error(),{code:signal?'REPLAY_TIMEOUT':'REPLAY_WORKER_EXIT'}));});
   child.send(input,error=>{if(error){child.kill();clearTimeout(timer);reject(error);}});
 });
}

async function captureCode() {
 const directory=path.join(root,'backend/src/modules'),sources={};
 for(const name of (await fs.readdir(directory)).filter(n=>n.endsWith('.js')).sort())sources['backend/src/modules/'+name]=await fs.readFile(path.join(directory,name),'utf8');
 return {sources,hash:digest(sources)};
}

async function main() {
 const started=Date.now();let options;
 const cutoff=setTimeout(()=>{activeWorker?.kill();console.log(JSON.stringify({version:1,passed:false,errorDetail:{code:'REPLAY_WHOLE_GATE_TIMEOUT',stage:'gate'}}));process.exit(1);},570000);cutoff.unref();
 try {
   options=parseArgs(process.argv.slice(2));
   if(options.help) {
     console.log('Read-only stored-operation gate: --days N (default 3), --since YYYY-MM-DD or UTC timestamp, --ops id,id, --json. Missing evidence fails closed.');return;
   }
   const bundle=await loadStored({root,...options,deadline:started+510000});
   const sourceCapture=await captureCode();bundle.data.__replaySources=sourceCapture.sources;
   const features=require('../../backend/src/config').features||{};
   const report=await runOffline({root,bundle,features,proveActivityChoices:options.proveActivityChoices},Math.max(1,540000-(Date.now()-started)));
   report.codeHash=sourceCapture.hash;
   report.sourceChanged=(await captureCode()).hash!==sourceCapture.hash;
   if(report.sourceChanged)report.passed=false;
   report.elapsedMs=Date.now()-started;
   if(options.json)console.log(JSON.stringify(report));
   else {
     console.log('Replay gate: '+(report.passed?'PASS':'FAIL')+' ('+report.elapsedMs+'ms)');
     for(const entry of report.preflight||[])console.log('activity-choices '+entry.status+' '+(entry.errorDetail?.code||entry.sourceHash));
     for(const operation of report.operations||[])console.log(operation.id+' '+operation.outcome+' '+(operation.errorDetail||[]).map(e=>e.stage+':'+e.code).join(' '));
     if(report.errorDetail)console.log(report.errorDetail.stage+':'+report.errorDetail.code);
     console.log(JSON.stringify(report.counts||{}));
   }
   process.exitCode=report.passed?0:1;
 } catch(error) {
   console.log(JSON.stringify({version:1,passed:false,errorDetail:safeError(error,'gate')}));
   process.exitCode=1;
 } finally {clearTimeout(cutoff);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
