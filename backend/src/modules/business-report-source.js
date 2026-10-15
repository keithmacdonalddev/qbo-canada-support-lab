'use strict';
const {gzipSync,gunzipSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const {canonical}=require('./business-calendar');
const LEGACY_REPORTS=Object.freeze(['TrialBalance','BalanceSheet','ProfitAndLoss','AgedReceivables','AgedPayables']);
const CRITICAL_REPORTS=Object.freeze([...LEGACY_REPORTS,'GeneralLedger','CashFlow']);
const DETAIL_REPORTS=new Set(['GeneralLedger','CashFlow']);
const MAX_DETAIL_BYTES=6000000,MAX_SOURCE_BYTES=6000000,MAX_DECODED_BYTES=12000000;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fail(message){throw Object.assign(Error(message),{status:409,code:'BUSINESS_REPORT_UNVERIFIED'});}
function namesFor(version){if(version===1)return LEGACY_REPORTS;if(version===2)return CRITICAL_REPORTS;fail('The report source version is unsupported.');}
function packReport(name,report){
 if(!DETAIL_REPORTS.has(name))return report;
 let text;try{text=canonical(report);}catch{fail('The complete detail report is not plain JSON.');}
 const bytes=Buffer.from(text,'utf8');if(bytes.length>MAX_DETAIL_BYTES)fail('The complete detail report exceeds its six-megabyte read budget. Shorten the period.');
 return{encoding:'gzip-canonical-json-v1',byteLength:bytes.length,sha256:digest(bytes),body:gzipSync(bytes).toString('base64')};
}
function unpackReport(name,value,version){
 if(version!==2||!DETAIL_REPORTS.has(name))return value;
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='body,byteLength,encoding,sha256'||value.encoding!=='gzip-canonical-json-v1'||!Number.isSafeInteger(value.byteLength)||value.byteLength<2||value.byteLength>MAX_DETAIL_BYTES||typeof value.body!=='string'||value.body.length>Math.ceil(MAX_SOURCE_BYTES/3)*4||value.body.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.body)||!/^[a-f0-9]{64}$/.test(value.sha256||''))fail('The retained complete detail report envelope is invalid.');
 try{
  const encoded=Buffer.from(value.body,'base64');if(encoded.toString('base64')!==value.body)throw Error('base64');
  const bytes=gunzipSync(encoded,{maxOutputLength:MAX_DETAIL_BYTES});if(bytes.length!==value.byteLength||digest(bytes)!==value.sha256)throw Error('digest');
  const text=bytes.toString('utf8'),report=JSON.parse(text);if(!report||Object.getPrototypeOf(report)!==Object.prototype||!Buffer.from(canonical(report),'utf8').equals(bytes))throw Error('canonical');return report;
 }catch{fail('The retained complete detail report could not be verified within its read budget.');}
}
function unpackReports(sources){
 const version=sources?.version,names=namesFor(version),reports=sources?.reports;
 if(!reports||Object.getPrototypeOf(reports)!==Object.prototype||Object.keys(reports).sort().join(',')!==[...names].sort().join(','))fail('Every named report source is required without replacements.');
 let decodedBytes=0;
 for(const name of names){const value=reports[name];if(version===1&&value?.encoding)fail('Version-one report sources cannot contain encoded reports.');const size=version===2&&DETAIL_REPORTS.has(name)?value?.byteLength:Buffer.byteLength(canonical(value));if(!Number.isSafeInteger(size)||size<2||size>MAX_DETAIL_BYTES)fail('A complete report exceeds its decoded read budget.');decodedBytes+=size;if(decodedBytes>MAX_DECODED_BYTES)fail('The combined decoded report observation exceeds its twelve-megabyte read budget.');}
 return Object.fromEntries(names.map(name=>[name,unpackReport(name,reports[name],version)]));
}
module.exports={LEGACY_REPORTS,CRITICAL_REPORTS,DETAIL_REPORTS,MAX_DETAIL_BYTES,MAX_SOURCE_BYTES,MAX_DECODED_BYTES,namesFor,packReport,unpackReport,unpackReports};
