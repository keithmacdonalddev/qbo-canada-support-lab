'use strict';
const {gzipSync,gunzipSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const {canonical}=require('./business-calendar');
const {canonicalReport}=require('./report-json');
const LEGACY_REPORTS=Object.freeze(['TrialBalance','BalanceSheet','ProfitAndLoss','AgedReceivables','AgedPayables']);
const CRITICAL_REPORTS=Object.freeze([...LEGACY_REPORTS,'GeneralLedger','CashFlow']);
const DETAIL_REPORTS=new Set(['GeneralLedger','CashFlow']);
const MAX_DETAIL_BYTES=6000000,MAX_SOURCE_BYTES=6000000,MAX_DECODED_BYTES=12000000;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fail(message){throw Object.assign(Error(message),{status:409,code:'BUSINESS_REPORT_UNVERIFIED'});}
function namesFor(version){if(version===1)return LEGACY_REPORTS;if(version===2||version===3)return CRITICAL_REPORTS;fail('The report source version is unsupported.');}
function packReport(name,report,version=2){
 if(version===3)return packCurrentReport(name,report);
 if(version!==2)fail('Choose an explicit supported report packing version.');
 if(!DETAIL_REPORTS.has(name))return report;
 let text;try{text=canonical(report);}catch{fail('The complete detail report is not plain JSON.');}
 const bytes=Buffer.from(text,'utf8');if(bytes.length>MAX_DETAIL_BYTES)fail('The complete detail report exceeds its six-megabyte read budget. Shorten the period.');
 return{encoding:'gzip-canonical-json-v1',byteLength:bytes.length,sha256:digest(bytes),body:gzipSync(bytes).toString('base64')};
}
function unpackReport(name,value,version){
 if(version===3)return unpackCurrentReport(name,value);
 if(version!==2||!DETAIL_REPORTS.has(name))return value;
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='body,byteLength,encoding,sha256'||value.encoding!=='gzip-canonical-json-v1'||!Number.isSafeInteger(value.byteLength)||value.byteLength<2||value.byteLength>MAX_DETAIL_BYTES||typeof value.body!=='string'||value.body.length>Math.ceil(MAX_SOURCE_BYTES/3)*4||value.body.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.body)||!/^[a-f0-9]{64}$/.test(value.sha256||''))fail('The retained complete detail report envelope is invalid.');
 try{
  const encoded=Buffer.from(value.body,'base64');if(encoded.toString('base64')!==value.body)throw Error('base64');
  const bytes=gunzipSync(encoded,{maxOutputLength:MAX_DETAIL_BYTES});if(bytes.length!==value.byteLength||digest(bytes)!==value.sha256)throw Error('digest');
  const text=bytes.toString('utf8'),report=JSON.parse(text);if(!report||Object.getPrototypeOf(report)!==Object.prototype||!Buffer.from(canonical(report),'utf8').equals(bytes))throw Error('canonical');return report;
 }catch{fail('The retained complete detail report could not be verified within its read budget.');}
}
function assertCurrentEnvelope(name,value){
 if(!CRITICAL_REPORTS.includes(name)||!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='body,byteLength,encoding,sha256'||value.encoding!=='gzip-canonical-json-v2'||!Number.isSafeInteger(value.byteLength)||value.byteLength<2||value.byteLength>MAX_DETAIL_BYTES||typeof value.body!=='string'||value.body.length>Math.ceil(MAX_SOURCE_BYTES/3)*4||value.body.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.body)||!/^[a-f0-9]{64}$/.test(value.sha256||''))fail('The retained version-three report envelope is invalid.');
}
function packCurrentReport(name,report){
 if(!CRITICAL_REPORTS.includes(name)||!report||Object.getPrototypeOf(report)!==Object.prototype)fail('A named complete report must be plain JSON.');
 const bytes=Buffer.from(canonicalReport(report),'utf8');
 return{encoding:'gzip-canonical-json-v2',byteLength:bytes.length,sha256:digest(bytes),body:gzipSync(bytes).toString('base64')};
}
function unpackCurrentReport(name,value){
 assertCurrentEnvelope(name,value);
 try{
  const encoded=Buffer.from(value.body,'base64');if(encoded.toString('base64')!==value.body)throw Error('base64');
  const bytes=gunzipSync(encoded,{maxOutputLength:MAX_DETAIL_BYTES});if(bytes.length!==value.byteLength||digest(bytes)!==value.sha256)throw Error('digest');
  const report=JSON.parse(bytes.toString('utf8'));
  if(!report||Object.getPrototypeOf(report)!==Object.prototype||!Buffer.from(canonicalReport(report),'utf8').equals(bytes))throw Error('canonical');
  return report;
 }catch{fail('The retained version-three report could not be verified within its read budget.');}
}
function unpackReports(sources){
 const version=sources?.version,names=namesFor(version),reports=sources?.reports;
 if(!reports||Object.getPrototypeOf(reports)!==Object.prototype||Object.keys(reports).sort().join(',')!==[...names].sort().join(','))fail('Every named report source is required without replacements.');
 if(version===3&&Buffer.byteLength(canonical(reports))>MAX_SOURCE_BYTES)fail('The retained report envelopes exceed their evidence budget.');
 let decodedBytes=0;
 for(const name of names){const value=reports[name];if(version===3)assertCurrentEnvelope(name,value);if(version===1&&value?.encoding)fail('Version-one report sources cannot contain encoded reports.');const size=version===3||(version===2&&DETAIL_REPORTS.has(name))?value?.byteLength:Buffer.byteLength(canonical(value));if(!Number.isSafeInteger(size)||size<2||size>MAX_DETAIL_BYTES)fail('A complete report exceeds its decoded read budget.');decodedBytes+=size;if(decodedBytes>MAX_DECODED_BYTES)fail('The combined decoded report observation exceeds its twelve-megabyte read budget.');}
 return Object.fromEntries(names.map(name=>[name,unpackReport(name,reports[name],version)]));
}
module.exports={LEGACY_REPORTS,CRITICAL_REPORTS,DETAIL_REPORTS,MAX_DETAIL_BYTES,MAX_SOURCE_BYTES,MAX_DECODED_BYTES,namesFor,packReport,unpackReport,unpackReports};

// Approval alone may use a subset. Full book/closing observations keep unpackReports' exact contract.
function approvalReportNames(manifest) {
 if (!manifest?.activityBatch || !(manifest.entries || manifest.records)?.length) return [...CRITICAL_REPORTS];
 const entities = (manifest.entries || manifest.records).map(entry => entry.step?.entity || entry.entity);
 const nonposting = ['Customer','Vendor','Item','Estimate','PurchaseOrder','TimeActivity'];
 const known = [...nonposting,'Invoice','Bill','Payment','BillPayment','SalesReceipt','CreditMemo','VendorCredit','RefundReceipt','Purchase','Deposit','Transfer','JournalEntry'];
 if (entities.some(entity => !known.includes(entity))) return [...CRITICAL_REPORTS];
 if (entities.every(entity => nonposting.includes(entity))) return [];
 const broadJournal = entities.includes('JournalEntry') && !(manifest.activityBatch.activities?.length && manifest.activityBatch.activities.every(row => row.type === 'journal-entry' && row.lines?.every(line => ['serviceIncome','supplyIncome','careIncome','operatingExpense'].includes(line.accountKey))));
 const names = new Set(['TrialBalance','BalanceSheet','ProfitAndLoss','GeneralLedger']);
 if (broadJournal || entities.some(entity => ['Invoice','Payment','CreditMemo'].includes(entity))) names.add('AgedReceivables');
 if (broadJournal || entities.some(entity => ['Bill','BillPayment','VendorCredit'].includes(entity))) names.add('AgedPayables');
 if (broadJournal || entities.some(entity => ['Payment','BillPayment','SalesReceipt','RefundReceipt','Purchase','Deposit','Transfer'].includes(entity))) names.add('CashFlow');
 return CRITICAL_REPORTS.filter(name => names.has(name));
}
function evaluateApprovalReportSources(source, required) {
 if (!Array.isArray(required) || new Set(required).size !== required.length || required.some(name => !CRITICAL_REPORTS.includes(name))) fail('Unsupported approval report requirements.');
 const names = Object.keys(source.reports || {});
 if (names.some(name => !CRITICAL_REPORTS.includes(name)) || required.some(name => !names.includes(name))) fail('Every relevant approval report is required.');
 // Retain the aggregate decompression bound even for a smaller approval observation.
 let decoded = 0;
 for (const name of names) { const value = source.reports[name]; const size = source.version === 3 || DETAIL_REPORTS.has(name) ? value?.byteLength : Buffer.byteLength(canonical(value)); if (!Number.isSafeInteger(size) || size < 2 || size > MAX_DETAIL_BYTES || (decoded += size) > MAX_DECODED_BYTES) fail('Approval report decoded budget exceeded.'); }
 require('./business-report-cache').assertReportReuse(source);
 const reports = Object.fromEntries(names.map(name => [name, unpackReport(name, source.reports[name], source.version)]));
 const { evaluateBooks } = require('./book-evidence');
 const evaluation = evaluateBooks(reports, source.period, {}, {records: source.accounts}, {allowExplicitZero: true, includeCritical: true, sourceVersion: source.version});
 const keys = required.length ? ['trial-balance','balance-sheet', ...(required.includes('AgedReceivables') ? ['receivables'] : []), ...(required.includes('AgedPayables') ? ['payables'] : [])] : [];
 const checks = evaluation.checks.filter(check => keys.includes(check.key));
 const missing = evaluation.reportCoverage.missing.filter(name => required.includes(name));
 return {...evaluation, checks, reportCoverage: {...evaluation.reportCoverage, required: required.length, available: required.length - missing.length, missing, complete: !missing.length}, status: checks.some(check => check.status === 'failed') ? 'differences-found' : checks.every(check => check.status === 'passed') && !missing.length ? 'checks-passed' : 'verification-incomplete'};
}
module.exports.approvalReportNames = approvalReportNames;
module.exports.evaluateApprovalReportSources = evaluateApprovalReportSources;
