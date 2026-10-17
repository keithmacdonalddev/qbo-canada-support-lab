'use strict';
const {setTimeout:wait}=require('node:timers/promises');
// Shared by every GET in one exclusive population worker. Never wraps a POST.
function createPopulationReadQueue({now=()=>Date.now(),sleep=wait,spacing=180,concurrency=3,perMinute=330}={}){
  let active=0,nextAt=0,cooldown=0;const attempts=[],pending=[];
  async function acquire(signal){if(signal?.aborted)throw signal.reason||Error('Population reads cancelled');await new Promise((resolve,reject)=>{const item={resolve,reject,signal};pending.push(item);pump();});}
  function pump(){while(active<concurrency&&pending.length){const item=pending.shift();if(item.signal?.aborted){item.reject(item.signal.reason||Error('Population reads cancelled'));continue;}active++;item.resolve();}}
  async function pace(signal){for(;;){const at=now();while(attempts.length&&attempts[0]<=at-60000)attempts.shift();const until=Math.max(nextAt,cooldown,attempts.length>=perMinute?attempts[0]+60050:0);if(until>at){await sleep(Math.min(until-at,5000),undefined,{signal});continue;}nextAt=at+spacing;attempts.push(at);return;}}
  async function run(work,signal){await acquire(signal);try{for(let retry=0;;retry++){await pace(signal);try{return await work();}catch(error){if(error.status!==429||retry>=2||signal?.aborted)throw error;cooldown=Math.max(cooldown,now()+65000);}}}finally{active--;pump();}}
  return {run,delayUntil:value=>{cooldown=Math.max(cooldown,value);}};
}
module.exports={createPopulationReadQueue};
