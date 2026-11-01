'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
// Enumeration only. Never stop a process, and never treat age as death proof.
async function scanBankingProcesses(){
  if(process.platform!=='win32')throw new Error('Banking lock recovery requires verified Windows process enumeration');
  const command="$ErrorActionPreference='Stop'; $me=$PID; $rows=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; terra=[bool]($_.CommandLine -match 'terra_live_run=|terra-live[.]sh|terra-live-bf7-') } }); ConvertTo-Json -InputObject $rows -Compress";
  const stdout=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',command],{windowsHide:true,timeout:15000,maxBuffer:2000000},(e,out)=>e?reject(new Error('Cannot verify live banking processes; locks retained')):resolve(out)));
  const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));
  if(!Array.isArray(rows)||!rows.length||rows.some(r=>!Number.isInteger(r.pid)||!Number.isInteger(r.parent)||typeof r.terra!=='boolean'))throw new Error('Incomplete banking process enumeration; locks retained');
  return rows;
}
async function readLock(directory,file){try{return await fs.readFile(path.join(directory,file),'utf8');}catch(e){if(e.code==='ENOENT'){try{await fs.stat(directory);}catch(x){if(x.code==='ENOENT')return null;throw x;}throw Object.assign(new Error('Lock ownership is being published or requires inspection'),{code:'BANKING_OPERATOR_BUSY'});}throw e;}}
async function recoverBankingLocks({temp=os.tmpdir(),root=path.resolve(__dirname,'../../..'),scanProcesses=scanBankingProcesses}={}){
  const terra=path.join(temp,'qbo-terra-live.lock'),operator=path.join(temp,'qbo-banking-operator.lock');
  let t,o;try{t=await readLock(terra,'owner.txt');o=await readLock(operator,'owner.json');}catch(e){if(e.code==='BANKING_OPERATOR_BUSY')return {busy:true,recovered:[]};throw e;}
  if(t===null && o===null)return {busy:false,recovered:[]};
  let owner;try{owner=o===null?null:JSON.parse(o);}catch{throw new Error('Invalid banking lock owner; retain lock');}
  if(owner && (!Number.isInteger(owner.pid)||owner.pid<=0))throw new Error('Invalid banking owner PID; retain lock');
  const sampled=new Set();
  if(t!==null){
    const match=/^terra-live-(.+)-\d+-\d+\s*$/.exec(t);
    if(!match || !/^[A-Za-z0-9._-]+$/.test(match[1]))throw new Error('Unknown Terra lock marker; retain lock');
    const base=path.join(root,'artifacts/terra-live'),names=(await fs.readdir(base)).filter(n=>n.startsWith(match[1]+'-'));
    // Missing sampling evidence cannot prove that unmarked helpers have exited.
    if(names.length!==1)throw new Error('Exact Terra process sampling evidence required; lock retained');
    const pids=await fs.readFile(path.join(base,names[0],'pids.txt'),'utf8');
    if(!pids.trim())throw new Error('Empty Terra process sampling evidence; lock retained');
    for(const line of pids.trim().split(/\r?\n/)){const m=/^(\d+)\s+\S+$/.exec(line.trim());if(!m)throw new Error('Invalid Terra process sampling evidence; lock retained');sampled.add(Number(m[1]));}
  }
  const alive=rows=>rows.some(p=>p.terra || p.pid===owner?.pid || sampled.has(p.pid) || sampled.has(p.parent) || p.parent===owner?.pid);
  // PID is published atomically in the directory name: a crash cannot leave
  // an ownerless mutex between mkdir and writing an owner file.
  const token='qbo-banking-recovery.'+process.pid+'.'+require('node:crypto').randomUUID()+'.lock';
  const recovery=path.join(temp,token);await fs.mkdir(recovery);
  try{
    const rows=await scanProcesses();
    for(const name of await fs.readdir(temp)){
      if(name===token)continue;
      const m=/^qbo-banking-recovery[.](\d+)[.]([a-f0-9-]+)[.]lock$/.exec(name);if(!m)continue;
      if(rows.some(p=>p.pid===Number(m[1])))return {busy:true,recovered:[]};
      // Unique names cannot refer to a replacement owner's directory.
      try{await fs.rmdir(path.join(temp,name));}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(alive(await scanProcesses()) || alive(await scanProcesses()))return {busy:true,recovered:[]};
    const recovered=[];
    for(const [dir,file,expected] of [[terra,'owner.txt',t],[operator,'owner.json',o]]){
      if(expected===null)continue;
      if(await readLock(dir,file)!==expected)throw new Error('Banking lock changed during recovery; retain lock');
      const entries=await fs.readdir(dir);if(entries.length!==1 || entries[0]!==file)throw new Error('Unexpected banking lock contents; retain lock');
      await fs.unlink(path.join(dir,file));await fs.rmdir(dir);recovered.push(path.basename(dir));
    }
    return {busy:false,recovered};
  }finally{await fs.rmdir(recovery);}
}
// Read only retained local evidence. Events can be huge (screenshots); expose
// only the final agent message, never tool payloads, credentials or page dumps.
async function verifyRetainedRunStopped(root,entry,scanProcesses=scanBankingProcesses){
  const base=path.join(root,'artifacts/terra-live'),names=(await fs.readdir(base)).filter(n=>n.startsWith(entry.runId+'-'));
  if(!names.length)throw new Error('Retained run process evidence required; recovery blocked');
  if(names.length!==1)throw new Error('Ambiguous retained Terra run; recovery blocked');
  let pids;try{pids=await fs.readFile(path.join(base,names[0],'pids.txt'),'utf8');}catch{throw new Error('Run process evidence missing; recovery blocked');}
  if(!pids.trim())throw new Error('Run process evidence empty; recovery blocked');
  const ids=new Set(pids.trim().split(/\r?\n/).map(line=>{const m=/^(\d+)\s+\S+$/.exec(line.trim());if(!m)throw new Error('Invalid retained process identity');return Number(m[1]);}));
  for(let i=0;i<2;i++){const rows=await scanProcesses();if(rows.some(p=>p.terra || ids.has(p.pid) || ids.has(p.parent)))throw Object.assign(new Error('A retained Terra process is still live; recovery waits'),{code:'BANKING_OPERATOR_BUSY'});}
  return {processesVerifiedAbsent:true};
}
async function readRetainedTerraResult(root,entry){
  const base=path.join(root,'artifacts/terra-live');let names;
  try{names=(await fs.readdir(base)).filter(n=>n.startsWith(entry.runId+'-'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(names.length!==1)return null;
  const directory=path.join(base,names[0]);
  try{return {reply:await fs.readFile(path.join(directory,'reply.txt'),'utf8'),source:path.join(directory,'reply.txt')};}catch(e){if(e.code!=='ENOENT')throw e;}
  try{
    const lines=(await fs.readFile(path.join(directory,'events.jsonl'),'utf8')).split('\n');let reply=null;
    for(const line of lines){let e;try{e=JSON.parse(line);}catch{continue;}if(e.type==='item.completed' && e.item?.type==='agent_message' && typeof e.item.text==='string')reply=e.item.text;}
    return reply?{reply,source:path.join(directory,'events.jsonl')}:null;
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
module.exports={scanBankingProcesses,recoverBankingLocks,readRetainedTerraResult,verifyRetainedRunStopped};
