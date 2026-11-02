'use strict';
const stamp=value=>value?new Date(value).getTime():0;
const TERMINAL=['completed','incomplete','cancelled','failed','yielded','plan-limit','cap-reached'];
// Requesting a review changes scheduling, never the authority/lease generation.
function requestReview(row,input,now){
 const live=Boolean(row.leaseToken&&stamp(row.leaseExpiresAt)>now);
 const pass=live&&row.status==='reviewing'&&row.activePass?.role==='accountant'?row.activePass:null;
 const old=row.reviewRequest;
 if(pass){
  const request=old?.passId===pass.id?old:{id:input.requestKey,requestedAt:new Date(now).toISOString(),state:'running',passId:pass.id,attemptId:row.reviewProgress?.passId===pass.id?row.reviewProgress.attemptId:null,startedAt:pass.startedAt};
  return {changes:{reviewRequest:request},disposition:'already-running',request};
 }
 if(old?.state==='queued'){return {changes:{},disposition:'already-queued',request:old};}
 const request={id:input.requestKey,requestedAt:new Date(now).toISOString(),state:'queued'};
 return {changes:{reviewRequest:request,reviewRequestedAt:new Date(now),nextDecisionAt:new Date(now),nextWakeAt:new Date(now)},disposition:'queued',request};
}
function startRequestedReview(row,pass,attemptId){
 return pass.role==='accountant'&&row.reviewRequest?.state==='queued'?{reviewRequest:{...row.reviewRequest,state:'running',passId:pass.id,attemptId,startedAt:pass.startedAt}}:{};
}
async function reviewRequestView(row,{outcomeFor,usagePause,now=Date.now()}={}){
 const request=row?.reviewRequest;if(!request)return null;
 const view={...request,pending:false};
 let terminal=null;
 if(request.passId&&outcomeFor){try{terminal=await outcomeFor(row,request);}catch{return {...view,state:'unavailable',title:'Review result could not be read',detail:'Your request is saved. Refresh to read its exact result before requesting another review.'};}}
 if(terminal&&TERMINAL.includes(terminal.data?.outcome)){
  const outcome=terminal.data.outcome;
  const titles={completed:'Review completed',incomplete:'Review ended with work remaining',cancelled:'Review was interrupted',failed:'Review needs attention',yielded:'Review is waiting for current company data','plan-limit':'Review is waiting for the AI limit','cap-reached':'Review is waiting for the AI limit'};
  return {...view,state:outcome,finishedAt:new Date(terminal.at).toISOString(),title:titles[outcome],detail:terminal.detail||'Open the recorded activity for this review.',attemptId:terminal.data.attemptId||request.attemptId};
 }
 if(request.state==='failed')return {...view,state:'failed',title:'Requested review could not start',detail:request.error||'The worker could not start this request. Saved work is retained; retry to request another review.'};
 if(!row.settings?.monitoring||!row.settings?.autonomous)return {...view,state:'cancelled',title:'Requested review is paused',detail:'The accountant is paused. Resume it to continue under its existing authority.'};
 if(usagePause)return {...view,state:'waiting',pending:true,title:'Review requested · waiting for the AI limit',detail:usagePause.detail};
 if(request.state==='running'){
  const live=row.leaseToken&&stamp(row.leaseExpiresAt)>now&&row.activePass?.id===request.passId;
  return {...view,state:live?'running':'interrupted',pending:Boolean(live),title:live?'Your review is running':'Review was interrupted',detail:live?'The accountant is checking the business. Repeated requests join this review and do not restart it.':'Saved work is retained. The worker will recover; use recorded activity to inspect this attempt.'};
 }
 if(row.lastError&&row.status==='attention')return {...view,state:'failed',title:'Requested review could not start',detail:row.lastError};
 return {...view,state:'queued',pending:true,title:'Your review is queued',detail:row.cadence?.kind==='ceiling'?'The daily review limit still applies. The saved request will wait for the next allowed review.':'The accountant will review the business after the current worker finishes its checks. You can leave this page; the result stays here.'};
}
module.exports={requestReview,startRequestedReview,reviewRequestView,TERMINAL};
