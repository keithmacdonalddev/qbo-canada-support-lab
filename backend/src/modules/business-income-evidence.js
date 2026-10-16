'use strict';
const {hash,canonical}=require('./business-calendar');
const {rowsOf,money,explicitZeroReport}=require('./book-evidence');
const {packReport,unpackReport}=require('./business-report-source');
function fail(message){throw Object.assign(new Error(message),{status:409,code:'BUSINESS_INCOME_EVIDENCE_REQUIRED'});}
function incomeCents(report,period,reportSourceVersion=2){
 if(![1,2,3].includes(reportSourceVersion))fail('Choose an explicit supported income report version.');
 const h=report?.Header;if(h?.ReportName!=='ProfitAndLoss'||h.Currency!=='CAD'||h.ReportBasis!=='Accrual'||h.StartPeriod!==period.fromDate||h.EndPeriod!==period.throughDate)fail('Profit and loss needs the exact CAD accrual period.');
 if(explicitZeroReport(report,reportSourceVersion))return 0;
 if(reportSourceVersion===3&&h.Option?.some(option=>option.Name==='NoReportData'&&String(option.Value)==='true'))fail('A no-data profit and loss report must confirm a supported zero layout.');
 const rows=rowsOf(report).filter(row=>row.group==='Income'&&row.Summary?.ColData);if(rows.length!==1)fail('An unambiguous income total is required.');const value=money(rows[0].Summary.ColData.at(-1)?.value);if(!Number.isSafeInteger(value))fail('The income total is unavailable.');return value;
}
function managedIncome(entries){return entries.filter(row=>row.kind==='create'&&['Invoice','SalesReceipt','CreditMemo'].includes(row.step.entity)).reduce((sum,row)=>{const credit=row.step.entity==='CreditMemo';if(credit&&row.step.details.activityTemplateVersion!==3)fail('Credits require the original explicit customer-credit schedule.');return sum+(credit?-1:1)*row.step.details.lines.reduce((value,line)=>value+line.amountCents,0);},0);}
function createIncomeExpectation(scope,period,entries,report,observedAt,reportSourceVersion=2){
 if(![1,2,3].includes(reportSourceVersion))fail('Choose an explicit supported starting report version.');
 const openingIncomeCents=incomeCents(report,period,reportSourceVersion),managedIncomeCents=managedIncome(entries);
 const version=reportSourceVersion===3?2:1;
 const source=version===2?{version:2,scope,period,reportSourceVersion:3,report:packReport('ProfitAndLoss',report,3),observedAt}:{version:1,scope,period,report,observedAt};
 const expectation={version,scope,period,openingIncomeCents,managedIncomeCents,expectedIncomeCents:openingIncomeCents+managedIncomeCents,source,sourceHash:hash(source)};validateIncomeExpectation(expectation,scope,period,entries);return expectation;
}
function retainedIncomeReport(value){
 if(value?.version===1&&value.source?.version===1)return value.source.report;
 if(value?.version===2&&value.source?.version===2&&value.source.reportSourceVersion===3)return unpackReport('ProfitAndLoss',value.source.report,3);
 fail('The starting income evidence version is unavailable.');
}
function validateIncomeExpectation(value,scope,period,entries){
 const report=retainedIncomeReport(value);
 if(canonical(value.scope)!==canonical(scope)||canonical(value.period)!==canonical(period)||value.sourceHash!==hash(value.source)||canonical(value.source.scope)!==canonical(scope)||canonical(value.source.period)!==canonical(period)||incomeCents(report,period,value.version===2?3:2)!==value.openingIncomeCents||!Number.isFinite(Date.parse(value.source.observedAt)))fail('The retained starting income observation changed.');
 const delta=entries?managedIncome(entries):value.managedIncomeCents;
 if(![value.openingIncomeCents,value.managedIncomeCents,value.expectedIncomeCents,delta].every(Number.isSafeInteger)||delta!==value.managedIncomeCents||value.expectedIncomeCents!==value.openingIncomeCents+delta)fail('The income expectation differs from the original planned sales.');return value;
}
function checkIncomeExpectation(value,scope,period,report,reportSourceVersion=2){validateIncomeExpectation(value,scope,period);const actualIncomeCents=incomeCents(report,period,reportSourceVersion);return{passed:actualIncomeCents===value.expectedIncomeCents,actualIncomeCents,expectedIncomeCents:value.expectedIncomeCents,openingIncomeCents:value.openingIncomeCents,managedIncomeCents:value.managedIncomeCents};}
module.exports={incomeCents,createIncomeExpectation,validateIncomeExpectation,checkIncomeExpectation};
