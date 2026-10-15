'use strict';
const {hash,canonical}=require('./business-calendar');
const {rowsOf,money,explicitZeroReport}=require('./book-evidence');
function fail(message){throw Object.assign(new Error(message),{status:409,code:'BUSINESS_INCOME_EVIDENCE_REQUIRED'});}
function incomeCents(report,period){
 const h=report?.Header;if(h?.ReportName!=='ProfitAndLoss'||h.Currency!=='CAD'||h.ReportBasis!=='Accrual'||h.StartPeriod!==period.fromDate||h.EndPeriod!==period.throughDate)fail('Profit and loss needs the exact CAD accrual period.');
 if(explicitZeroReport(report))return 0;
 const rows=rowsOf(report).filter(row=>row.group==='Income'&&row.Summary?.ColData);if(rows.length!==1)fail('An unambiguous income total is required.');const value=money(rows[0].Summary.ColData.at(-1)?.value);if(!Number.isSafeInteger(value))fail('The income total is unavailable.');return value;
}
function createIncomeExpectation(scope,period,entries,report,observedAt){
 const openingIncomeCents=incomeCents(report,period),managedIncomeCents=entries.filter(row=>row.kind==='create'&&['Invoice','SalesReceipt'].includes(row.step.entity)).reduce((sum,row)=>sum+row.step.details.lines.reduce((value,line)=>value+line.amountCents,0),0),source={version:1,scope,period,report,observedAt};
 const expectation={version:1,scope,period,openingIncomeCents,managedIncomeCents,expectedIncomeCents:openingIncomeCents+managedIncomeCents,source,sourceHash:hash(source)};validateIncomeExpectation(expectation,scope,period,entries);return expectation;
}
function validateIncomeExpectation(value,scope,period,entries){
 if(!value||value.version!==1||canonical(value.scope)!==canonical(scope)||canonical(value.period)!==canonical(period)||value.sourceHash!==hash(value.source)||canonical(value.source.scope)!==canonical(scope)||canonical(value.source.period)!==canonical(period)||incomeCents(value.source.report,period)!==value.openingIncomeCents||!Number.isFinite(Date.parse(value.source.observedAt)))fail('The retained starting income observation changed.');
 const delta=entries?entries.filter(row=>row.kind==='create'&&['Invoice','SalesReceipt'].includes(row.step.entity)).reduce((sum,row)=>sum+row.step.details.lines.reduce((value,line)=>value+line.amountCents,0),0):value.managedIncomeCents;
 if(![value.openingIncomeCents,value.managedIncomeCents,value.expectedIncomeCents,delta].every(Number.isSafeInteger)||delta!==value.managedIncomeCents||value.expectedIncomeCents!==value.openingIncomeCents+delta)fail('The income expectation differs from the original planned sales.');return value;
}
function checkIncomeExpectation(value,scope,period,report){validateIncomeExpectation(value,scope,period);const actualIncomeCents=incomeCents(report,period);return{passed:actualIncomeCents===value.expectedIncomeCents,actualIncomeCents,expectedIncomeCents:value.expectedIncomeCents,openingIncomeCents:value.openingIncomeCents,managedIncomeCents:value.managedIncomeCents};}
module.exports={incomeCents,createIncomeExpectation,validateIncomeExpectation,checkIncomeExpectation};
