'use strict';
const {randomBytes}=require('node:crypto');
const {assertAccountEligible,accountVersion}=require('./account-policy');
const {normalizePermissions}=require('./rebuild-permissions');
const ID=/^[a-f0-9]{24}$/i;
const fail=(message,status=403)=>{throw Object.assign(new Error(message),{status});};
function createSessionStreams({loadAccount=require('../middleware/currentAccount').loadCurrentAccount,workspaceFor=require('../middleware/companyScope').findWorkspaceOwner,Sessions=require('../models/AISession'),Connections=require('../models/Connection'),Memberships=require('../models/CompanyMembership'),environment=()=>require('../config').qbo.environment,now=()=>Date.now(),nonce=()=>randomBytes(32).toString('hex')}={}){
 const tickets=new Map(),connections=new Map();
 const readSession=(id,userId)=>Sessions.findOne({_id:id,userId}).select('_id userId realmId').maxTimeMS(3000).lean();
 async function authorize(identity){
   if(now()>=identity.sessionExpiresAt||environment()!==identity.environment)fail('Stream session expired.');
   const actor=await loadAccount(identity.actorId);assertAccountEligible(actor);
   if(!actor||String(actor._id)!==identity.actorId||accountVersion(actor)!==identity.authVersion)fail('Stream account authorization changed.');
   if(String(await workspaceFor(identity.actorId))!==identity.ownerId)fail('Stream company access changed.');
   if(identity.actorId!==identity.ownerId){const owner=await loadAccount(identity.ownerId);assertAccountEligible(owner);const membership=await Memberships.findOne({userId:identity.actorId,realmId:identity.realmId,status:'active'}).select('role permissionOverrides').maxTimeMS(3000).lean();if(!membership||!normalizePermissions(membership.role,membership.permissionOverrides).includes('app_data.read'))fail('Stream company membership changed.');}
   const connection=await Connections.findOne({userId:identity.ownerId,status:'active'}).sort({updatedAt:-1}).select('_id realmId').maxTimeMS(3000).lean();
   if(!connection||String(connection._id)!==identity.connectionId||connection.realmId!==identity.realmId)fail('Stream company connection changed.');
   const session=await readSession(identity.sessionId,identity.ownerId);if(!session||session.realmId!==identity.realmId)fail('Stream session is unavailable.');
 }
 async function issue({user,account,sessionId}){
   const actorId=String(account?.id||''),ownerId=String(user?.id||'');
   if(![actorId,ownerId,sessionId].every(value=>ID.test(value||''))||!Number.isSafeInteger(account?.authVersion)||!Number.isFinite(account?.sessionExpiresAt))fail('Current authenticated stream authority is required.',401);
   const session=await readSession(sessionId,ownerId);if(!session)fail('Session not found.',404);
   const connection=await Connections.findOne({userId:ownerId,status:'active'}).sort({updatedAt:-1}).select('_id realmId').maxTimeMS(3000).lean();
   const identity={actorId,ownerId,authVersion:account.authVersion,sessionId,sessionExpiresAt:account.sessionExpiresAt,realmId:session.realmId,connectionId:String(connection?._id||''),environment:environment()};
   await authorize(identity);
   for(const [key,value]of tickets)if(value.expiresAt<=now())tickets.delete(key);
   if(tickets.size>=2000)fail('Too many pending stream connections. Try again shortly.',429);
   const ticket=nonce();tickets.set(ticket,{...identity,expiresAt:now()+30000});return{ticket};
 }
 async function open({user,account,sessionId,ticket},req,res){
   const retained=typeof ticket==='string'&&/^[a-f0-9]{64}$/.test(ticket)?tickets.get(ticket):null;
   if(retained)tickets.delete(ticket);
   if(!retained||retained.expiresAt<=now())fail('Invalid or expired stream ticket.',401);
   if(retained.sessionId!==sessionId||retained.ownerId!==String(user?.id)||retained.actorId!==String(account?.id)||retained.authVersion!==account?.authVersion)fail('Stream ticket authority changed.');
   await authorize(retained);
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
   res.write('event: connected\ndata: '+JSON.stringify({sessionId})+'\n\n');
   const entry={res,identity:retained,queue:Promise.resolve(),pending:0,closed:false};
   if(!connections.has(sessionId))connections.set(sessionId,new Set());connections.get(sessionId).add(entry);
   const close=()=>{if(entry.closed)return;entry.closed=true;clearTimeout(entry.expiry);const set=connections.get(sessionId);set?.delete(entry);if(!set?.size)connections.delete(sessionId);if(!res.writableEnded)res.end();};entry.close=close;
   entry.expiry=setTimeout(close,Math.max(1,retained.sessionExpiresAt-now()));entry.expiry.unref?.();req.on('close',close);
 }
 function emit(sessionId,event,data){
   if(!/^[a-z_]{1,40}$/.test(event))return;
   const payload=JSON.stringify(data);if(payload===undefined||Buffer.byteLength(payload)>1024*1024)return;
   const tasks=[];
   for(const entry of connections.get(String(sessionId))||[]){
     if(entry.pending>=128){entry.close();continue;}entry.pending++;
     entry.queue=entry.queue.then(async()=>{if(entry.closed)return;await authorize(entry.identity);if(entry.closed)return;if(!entry.res.write('event: '+event+'\ndata: '+payload+'\n\n'))entry.close();}).catch(()=>entry.close()).finally(()=>{entry.pending--;});tasks.push(entry.queue);
   }
   return Promise.all(tasks);
 }
 return{issue,open,emit,close:()=>{for(const set of connections.values())for(const entry of set)entry.close();tickets.clear();}};
}
let service;function sessionStreams(){return service||=createSessionStreams();}
module.exports={createSessionStreams,sessionStreams};
