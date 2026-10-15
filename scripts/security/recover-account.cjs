'use strict';
// Operator-only credential migration. Never imported by app startup.
const path=require('node:path'),net=require('node:net');
const {createRequire}=require('node:module');
const backendRequire=createRequire(path.resolve(__dirname,'../../backend/package.json'));
function args(argv){
  const result={};
  for(let index=0;index<argv.length;index++){
    const key=argv[index];
    if(key==='--apply'){if(result.apply)throw new Error('Duplicate apply option.');result.apply=true;continue;}
    if(!['--user-id','--review-hash'].includes(key)||result[key.slice(2)]!==undefined||!argv[index+1]||argv[index+1].startsWith('--'))throw new Error('Use --user-id <existing-account-id>, and only after approval --apply --review-hash <preview-hash>. Passwords are never accepted as arguments.');
    result[key.slice(2)]=argv[++index];
  }
  if(!/^[a-f0-9]{24}$/i.test(result['user-id']||'')||Boolean(result.apply)!==Boolean(result['review-hash'])||(result.apply&&!/^[a-f0-9]{64}$/.test(result['review-hash'])))throw new Error('A valid existing account ID is required. Apply also requires the exact preview hash.');
  return result;
}
async function assertBackendStopped(port){
  if(!Number.isInteger(Number(port))||Number(port)<1||Number(port)>65535)throw new Error('The configured backend port is invalid.');
  for(const host of ['127.0.0.1','::1']){
    const connected=await new Promise((resolve,reject)=>{const socket=net.createConnection({port:Number(port),host});let settled=false;const end=(error,value)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value);};socket.setTimeout(1000,()=>end(new Error('Cannot establish whether the backend is stopped.')));socket.once('connect',()=>end(null,true));socket.once('error',error=>['ECONNREFUSED','EAFNOSUPPORT','EADDRNOTAVAIL'].includes(error.code)?end(null,false):end(new Error('Cannot establish whether the backend is stopped.')));});
    if(connected)throw new Error('Stop the configured backend explicitly before applying credential recovery. This command will not stop it.');
  }
}
async function privatePassword(){
  if(!process.stdin.isTTY)throw new Error('Apply requires an interactive terminal so the new password can be entered privately.');
  const {Writable}=require('node:stream'),readline=require('node:readline/promises');
  const output=new Writable({write(_chunk,_encoding,done){done();}});
  const reader=readline.createInterface({input:process.stdin,output,terminal:true});
  try{
    process.stderr.write('New private password (hidden): ');const first=await reader.question('');process.stderr.write('\nRepeat password (hidden): ');const second=await reader.question('');process.stderr.write('\n');
    if(first!==second)throw new Error('Passwords did not match. Nothing was changed.');return first;
  }finally{reader.close();output.destroy();}
}
async function main(argv=process.argv.slice(2)){
  const options=args(argv);
  backendRequire('dotenv').config({path:path.resolve(__dirname,'../../.env'),quiet:true});
  const config=require('../../backend/src/config');
  const {storageTarget,configureDatabaseDns}=require('../../backend/src/modules/storage-target');
  const target=storageTarget(config.mongoUri);
  if(options.apply)await assertBackendStopped(config.port);
  const password=options.apply?await privatePassword():undefined;
  const mongoose=backendRequire('mongoose');
  try{
    configureDatabaseDns();
    await mongoose.connect(config.mongoUri,{serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,autoCreate:false,autoIndex:false});
    const service=require('../../backend/src/modules/account-recovery').createAccountRecovery({targetFingerprint:target.fingerprint,Users:require('../../backend/src/models/User'),Audits:require('../../backend/src/models/AuditLog'),transaction:require('../../backend/src/modules/business-transaction').createBusinessTransaction(mongoose.connection)});
    const result=options.apply?await service.apply({id:options['user-id'],reviewHash:options['review-hash'],password}):await service.preview(options['user-id']);
    console.log(JSON.stringify(result,null,2));
  }finally{await mongoose.disconnect();}
}
if(require.main===module)main().catch(error=>{console.error(error.status||/^(Use |A valid |Duplicate |Stop |The configured |Cannot establish |Apply requires |Passwords did not)/.test(error.message)?error.message:'Account recovery failed. Storage and credential details are suppressed. No external records are changed by this command.');process.exitCode=1;});
module.exports={args,assertBackendStopped,main};
