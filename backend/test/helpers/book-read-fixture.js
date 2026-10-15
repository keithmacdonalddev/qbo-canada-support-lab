'use strict';
const {QBOClient}=require('../../src/modules/qbo-client');
const config=require('../../src/config');
function bookReadFixture(reports){
 const scope={environment:config.qbo.environment,realmId:'123',connectionId:'a'.repeat(24)},actorId='b'.repeat(24),ownerId='c'.repeat(24),h={scope,calls:[],actions:[],reports,revoked:false};
 const accounts=[{Id:'1',SyncToken:'0',AccountType:'Accounts Receivable'},{Id:'2',SyncToken:'0',AccountType:'Accounts Payable'}];
 h.client=Object.create(QBOClient.prototype);Object.assign(h.client,{realmId:scope.realmId,connection:{_id:scope.connectionId,userId:ownerId,realmId:scope.realmId,status:'active'},_requestLog:[],_retryAfterUntil:0,_windowMs:60000,ensureFreshToken:async()=>{},oauthClient:{makeApiCall:async options=>{h.calls.push(options);if(h.onCall)await h.onCall(options);const url=new URL(options.url),name=url.pathname.split('/').at(-1);return{status:200,json:name==='query'?{QueryResponse:{Account:accounts,startPosition:1,maxResults:2}}:h.reports[name]};}}});
 h.access={authorize:async(_scope,action)=>{h.actions.push(action);if(h.revoked)throw Object.assign(Error('Fixture report membership revoked'),{status:403,code:'BUSINESS_ACCESS_DENIED'});return{actorId,ownerId};},resolveClient:async()=>h.client};return h;
}
module.exports={bookReadFixture};
