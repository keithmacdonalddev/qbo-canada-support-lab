#!/usr/bin/env node
'use strict';
// Fixed-company entry for the app, Claude Code and Codex. No secrets in output.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createSessionCoordinator}=require('../../backend/src/modules/qbo-browser-session');
const {REALM,MESSAGES}=require('../../backend/src/modules/qbo-browser-login');
const ROOT=path.resolve(__dirname,'../..');
async function readTask(relative,root=ROOT){
 if(typeof relative!=='string'||!/^artifacts\/terra-live\/tasks\/[a-f0-9-]{36}\/task[.]txt$/.test(relative))throw Error('Use an exact retained QuickBooks task file.');
 const base=await fs.realpath(path.join(root,'artifacts/terra-live/tasks')),file=await fs.realpath(path.join(root,relative));
 if(!file.startsWith(base+path.sep))throw Error('Task escapes its retained directory.');
 const stat=await fs.stat(file);if(!stat.isFile()||stat.size<1||stat.size>32000)throw Error('Invalid task.');
 return fs.readFile(file,'utf8');
}
async function main(argv=process.argv.slice(2)){
 const [command,flag,actor,taskFlag,taskPath]=argv;
 if(!['status','ensure','run'].includes(command)||flag!=='--actor'||!['app','accountant','claude-code','codex-cli'].includes(actor)||(command==='run'?argv.length!==5||taskFlag!=='--task':argv.length!==3))throw Error('Usage: qbo-session.cjs status|ensure|run --actor app|accountant|claude-code|codex-cli [--task artifacts/terra-live/tasks/<uuid>/task.txt]');
 const coordinator=createSessionCoordinator();
 if(command==='status'){console.log(JSON.stringify(await coordinator.status()));return;}
 const prompt=command==='run'?await readTask(taskPath):null;
 const {acquireOperatorLease,createTerraRunner}=require('../../backend/src/modules/banking-terra-runner');
 const release=await acquireOperatorLease();
 try{
  const context={actor,scope:{realmId:REALM,environment:'production'}};
  if(command==='ensure'){await coordinator.withSession(context,async({proof})=>console.log(JSON.stringify(proof)));return;}
  // Actor is attribution, not permission. Existing Terra task scope/stop rules apply.
  const runner=createTerraRunner({root:ROOT,coordinator}),runId='bf7-'+crypto.randomUUID();
  await runner.withSession(context,async()=>{const result=await runner.run({runId,task:{prompt},mode:'flow'});console.log(JSON.stringify({runId,exitCode:result.exitCode,cleanupConfirmed:result.cleanupConfirmed,replyPath:result.replyPath}));if(result.exitCode!==0||!result.cleanupConfirmed)process.exitCode=1;});
 }finally{await release();}
}
if(require.main===module)main().catch(error=>{const code=Object.hasOwn(MESSAGES,error?.code)?error.code:error.code==='BANKING_OPERATOR_BUSY'?'QBO_SESSION_BUSY':'QBO_SIGNIN_REQUIRED';console.error(JSON.stringify({status:'blocked',code,message:MESSAGES[code]}));process.exitCode=1;});
module.exports={main,readTask};
