'use strict';
// Child-owned completion evidence survives a coordinating process crash.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {hash}=require('../../backend/src/modules/business-calendar');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(ok,message)=>{if(!ok)throw new Error(message);};
async function writeReceipt({root,runId,taskFile,output,exitCode,cleanupConfirmed,actionId,authorityHash,startedMs}) {
  check(/^bf7-[a-f0-9-]{36}$/.test(runId)&&/^[a-f0-9]{64}$/.test(actionId)&&/^[a-f0-9]{64}$/.test(authorityHash),'Invalid native execution identity');
  const base=await fs.realpath(path.join(root,'artifacts/terra-live')),directory=await fs.realpath(output);
  check(directory.startsWith(base+path.sep)&&path.basename(directory).startsWith(runId+'-'),'Unexpected native output');
  const task=await fs.readFile(taskFile,'utf8'),prompt=await fs.readFile(path.join(directory,'prompt.txt'),'utf8');
  const reply=await fs.readFile(path.join(directory,'reply.txt')),commands=await fs.readFile(path.join(directory,'commands.txt'));
  const settings=await fs.readFile(path.join(directory,'settings.txt'),'utf8'),commandAudit=JSON.parse(await fs.readFile(path.join(directory,'command-audit.json'),'utf8'));
  const models=[...settings.matchAll(/"model":"([^"]+)"/g)].map(m=>m[1]);
  const model=models.length>0&&models.every(m=>m==='gpt-6.1-terra')?'gpt-6.1-terra':null;
  const body={version:1,kind:'native-estimate-execution',runId,actionId,authorityHash,mode:'flow',session:'qbo-ops',promptHash:hash(task),assembledPromptSha256:sha(Buffer.from(prompt)),exitCode,cleanupConfirmed,model,commandAudit,outputDirectory:directory,startedMs,finishedAt:new Date().toISOString(),replySha256:sha(reply),commandsSha256:sha(commands)};
  const file=path.join(directory,'native-execution.json'),temporary=file+'.tmp';
  await fs.writeFile(temporary,JSON.stringify({body,contentHash:hash(body)}),{flag:'wx'});await fs.link(temporary,file);await fs.unlink(temporary);
}
async function readReceipt(root,{runId,promptHash,nativeRepair}) {
  check(/^bf7-[a-f0-9-]{36}$/.test(runId),'Invalid native run');
  const base=path.join(root,'artifacts/terra-live'),dirs=(await fs.readdir(base,{withFileTypes:true})).filter(d=>d.isDirectory()&&d.name.startsWith(runId+'-'));
  if(dirs.length===0)return null;check(dirs.length===1,'Ambiguous retained native run');
  const directory=await fs.realpath(path.join(base,dirs[0].name));let retained;
  try{retained=JSON.parse(await fs.readFile(path.join(directory,'native-execution.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const {body,contentHash}=retained;
  check(hash(body)===contentHash&&body.kind==='native-estimate-execution'&&body.runId===runId&&body.promptHash===promptHash&&body.actionId===nativeRepair?.actionId&&body.authorityHash===nativeRepair.authorityHash&&body.mode==='flow'&&body.session==='qbo-ops'&&body.outputDirectory===directory,'Retained native execution changed');
  const task=await fs.readFile(path.join(root,'artifacts/banking/operator-tasks',runId,'task.txt'),'utf8');
  const prompt=await fs.readFile(path.join(directory,'prompt.txt')),reply=await fs.readFile(path.join(directory,'reply.txt')),commands=await fs.readFile(path.join(directory,'commands.txt'));
  check(hash(task)===promptHash&&sha(prompt)===body.assembledPromptSha256&&sha(reply)===body.replySha256&&sha(commands)===body.commandsSha256,'Retained native artifacts changed');
  return {exitCode:body.exitCode,cleanupConfirmed:body.cleanupConfirmed,model:body.model,commandAudit:body.commandAudit,outputDirectory:directory,startedMs:body.startedMs,reply:reply.toString('utf8'),replyPath:path.join(directory,'reply.txt'),commandsPath:path.join(directory,'commands.txt')};
}
if(require.main===module){
  const [runId,taskFile,output,code,cleanup,actionId,authorityHash,start]=process.argv.slice(2);
  writeReceipt({root:path.resolve(__dirname,'../..'),runId,taskFile,output,exitCode:Number(code),cleanupConfirmed:cleanup==='1',actionId,authorityHash,startedMs:Number(start)*1000}).catch(()=>{process.stderr.write('Native completion evidence could not be retained\n');process.exitCode=4;});
}
module.exports={writeReceipt,readReceipt};
