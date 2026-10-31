'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{gzipSync}=require('node:zlib'),{createHash}=require('node:crypto');
const {canonical}=require('../src/modules/business-calendar');
const {LEGACY_REPORTS,CRITICAL_REPORTS,MAX_DETAIL_BYTES,packReport,unpackReport,unpackReports}=require('../src/modules/business-report-source');
const report={Header:{ReportName:'GeneralLedger',StartPeriod:'2026-09-01',EndPeriod:'2026-09-30',ReportBasis:'Accrual',Currency:'CAD',Time:'2026-10-15T12:00:00Z'},Columns:{Column:[{ColTitle:'Date'},{ColTitle:'Amount'}]},Rows:{Row:[{type:'Data',ColData:[{value:'2026-09-01'},{value:'100.00'}]}]}};
test('versioned detail envelopes retain the entire canonical report and original volatile header',()=>{
 const packed=packReport('GeneralLedger',report);assert.deepEqual(unpackReport('GeneralLedger',packed,2),report);assert.equal(packed.byteLength,Buffer.byteLength(canonical(report)));assert.equal(unpackReport('GeneralLedger',packed,2).Header.Time,report.Header.Time);
 const old=Object.fromEntries(LEGACY_REPORTS.map(name=>[name,{Header:{ReportName:name},Rows:{Row:[]}}]));assert.deepEqual(unpackReports({version:1,reports:old}),old);assert.equal(packReport('ProfitAndLoss',report),report);assert.equal(unpackReport('ProfitAndLoss',report,1),report);
});
test('corrupt, ambiguous, oversized, noncanonical or unknown envelopes cannot become report evidence',()=>{
 const original=packReport('GeneralLedger',report);
 for(const change of [{byteLength:original.byteLength+1},{sha256:'0'.repeat(64)},{body:original.body+'\n'},{body:'not base64'},{encoding:'raw'},{extra:true},{byteLength:MAX_DETAIL_BYTES+1}])assert.throws(()=>unpackReport('GeneralLedger',{...original,...change},2),/report/);
 for(const text of [JSON.stringify(report,null,2),'{"x":1,"x":2}','[]','null']){const bytes=Buffer.from(text),packed={encoding:original.encoding,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),body:gzipSync(bytes).toString('base64')};assert.throws(()=>unpackReport('GeneralLedger',packed,2),/report/);}
 const bomb=Buffer.alloc(MAX_DETAIL_BYTES+1,32),packed={encoding:original.encoding,byteLength:MAX_DETAIL_BYTES,sha256:createHash('sha256').update(bomb).digest('hex'),body:gzipSync(bomb).toString('base64')};assert.throws(()=>unpackReport('CashFlow',packed,2),/budget/);
 assert.throws(()=>packReport('GeneralLedger',{data:'x'.repeat(MAX_DETAIL_BYTES)}),/budget/);
});
test('v2 requires exact seven report names and detail envelopes while v1 remains exact five',()=>{
 const reports=Object.fromEntries(CRITICAL_REPORTS.map(name=>[name,packReport(name,{...report,Header:{...report.Header,ReportName:name}})]));assert.equal(Object.keys(unpackReports({version:2,reports})).length,7);
 for(const version of [0,3,null,undefined])assert.throws(()=>unpackReports({version,reports}),/version/);
 const missing={...reports};delete missing.CashFlow;assert.throws(()=>unpackReports({version:2,reports:missing}),/named report/);assert.throws(()=>unpackReports({version:1,reports}),/named report/);assert.throws(()=>unpackReports({version:2,reports:{...reports,GeneralLedger:report}}),{code:'BUSINESS_REPORT_UNVERIFIED'});
});

test('combined decoded budget is checked before decoding any detail body',()=>{
 const reports=Object.fromEntries(LEGACY_REPORTS.map(name=>[name,{}]));for(const name of ['GeneralLedger','CashFlow'])reports[name]={encoding:'gzip-canonical-json-v1',byteLength:MAX_DETAIL_BYTES,sha256:'0'.repeat(64),body:'bad'};
 assert.throws(()=>unpackReports({version:2,reports}),/combined decoded/);
 const old=Object.fromEntries(LEGACY_REPORTS.map(name=>[name,{}]));old.ProfitAndLoss=packReport('GeneralLedger',report);assert.throws(()=>unpackReports({version:1,reports:old}),/Version-one/);
});

test('concatenated gzip members share the same decompression output limit',()=>{
 const half=Buffer.alloc(MAX_DETAIL_BYTES/2+1,32),body=Buffer.concat([gzipSync(half),gzipSync(half)]).toString('base64');assert.throws(()=>unpackReport('GeneralLedger',{encoding:'gzip-canonical-json-v1',byteLength:MAX_DETAIL_BYTES,sha256:'0'.repeat(64),body},2),{code:'BUSINESS_REPORT_UNVERIFIED'});
});

test('retained digest cannot turn malformed UTF-8 bytes into a different canonical JSON value',()=>{
 for(const invalid of [Buffer.from([255]),Buffer.from([192,175]),Buffer.from([226,130])]){const bytes=Buffer.concat([Buffer.from('{"value":"'),invalid,Buffer.from('"}')]),packed={encoding:'gzip-canonical-json-v1',byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),body:gzipSync(bytes).toString('base64')};assert.throws(()=>unpackReport('GeneralLedger',packed,2),{code:'BUSINESS_REPORT_UNVERIFIED'});}
});

test('approval report requirements follow immutable account effects, with conservative unknown and calendar close fallbacks',()=>{
 const {approvalReportNames}=require('../src/modules/business-report-source');
 const manifest=entity=>({activityBatch:{activities:[]},records:[{entity}]});
 assert.deepEqual(approvalReportNames(manifest('Invoice')),['TrialBalance','BalanceSheet','ProfitAndLoss','AgedReceivables','GeneralLedger']);
 assert.deepEqual(approvalReportNames(manifest('Bill')),['TrialBalance','BalanceSheet','ProfitAndLoss','AgedPayables','GeneralLedger']);
 assert.deepEqual(approvalReportNames(manifest('Transfer')),['TrialBalance','BalanceSheet','ProfitAndLoss','GeneralLedger','CashFlow']);
 assert.deepEqual(approvalReportNames(manifest('Customer')),[]);assert.equal(approvalReportNames({records:[{entity:'Invoice'}]}).length,7);assert.equal(approvalReportNames(manifest('Unknown')).length,7);
 const journal=manifest('JournalEntry');journal.activityBatch.activities=[{type:'journal-entry',lines:[{accountKey:'serviceIncome'},{accountKey:'operatingExpense'}]}];assert.equal(approvalReportNames(journal).length,4);
});
