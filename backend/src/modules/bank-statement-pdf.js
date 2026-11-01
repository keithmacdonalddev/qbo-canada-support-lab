'use strict';
const C = require('./bank-settlement-contract');
const {formatMoney,formatDate,eventDate,description,sha256} = require('./bank-feed-csv');
const LABEL = 'Simulated statement - Test Data Lab';
function buildStatementModel(input) {
  const isCard = input.balanceConvention === 'card-amount-owed';
  if (!['bank-balance','card-amount-owed'].includes(input.balanceConvention)) throw new TypeError('Statement balance convention is required.');
  const scope = C.validateScope(input.scope), openingMinor = C.integer(input.openingMinor);
  let balance = openingMinor;
  const rows = [...input.events].sort((a,b) => eventDate(a).localeCompare(eventDate(b)) || a.eventId.localeCompare(b.eventId)).map(event => {
    C.validateEvent(event); C.assertScope(event.scope,scope);
    if (event.status !== 'resolved' || event.supersededBy || event.resolution.action === 'Exclude' || event.accountId !== input.accountId || event.accountCurrency !== input.accountCurrency || eventDate(event).slice(0,7) !== input.period) throw new TypeError('Statement event is outside its account, currency or period.');
    balance = C.sum([balance,isCard ? -event.amountMinor : event.amountMinor]);
    return {eventId:event.eventId,date:eventDate(event),description:description(event),sourceEntity:event.source.entity,sourceId:event.source.id,
      amountMinor:event.amountMinor,balanceMinor:balance,settlementGroupId:event.settlementGroupId,pairedEventId:event.pairedEventId,
      adviceLines:event.source.depositBreakdown?.length || 0};
  });
  if (new Set(rows.map(r=>r.eventId)).size !== rows.length) throw new TypeError('Statement contains a duplicate event.');
  const positiveMinor = C.sum(rows.filter(r=>r.amountMinor>0).map(r=>r.amountMinor));
  const negativeMinor = C.sum(rows.filter(r=>r.amountMinor<0).map(r=>-r.amountMinor));
  if (balance !== input.closingMinor) throw new TypeError('Statement and package balances disagree.');
  return {label:LABEL,scope,accountId:input.accountId,accountName:input.accountName || input.accountId,accountCurrency:input.accountCurrency,
    period:input.period,balanceConvention:input.balanceConvention,openingMinor,closingMinor:balance,positiveMinor,negativeMinor,
    rows,blockers:[...(input.blockers || [])],openingBasis:input.openingBasis,
    outstandingItems:input.outstandingItems || [],dueDate:input.dueDate ? C.date(input.dueDate) : null,
    evidenceLabel:'Reconstructed simulated evidence; not independent bank confirmation.',
    nativeStatus:'No upload, matching or reconciliation is proved by this statement.'};
}
// Deterministic, text-based PDF using standard PDF fonts. No runtime service,
// Python installation, external font, wall clock or randomized document id.
function generateBankStatementPdf(input) {
  const model = buildStatementModel(input), perPage = 26;
  const chunks = Array.from({length:Math.max(1,Math.ceil(model.rows.length/perPage))},(_,i)=>model.rows.slice(i*perPage,(i+1)*perPage));
  const isCard = model.balanceConvention === 'card-amount-owed';
  function ascii(value) { return String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g,'?'); }
  function literal(value) { return '(' + ascii(value).replace(/([\\()])/g,'\\$1') + ')'; }
  function text(x,y,value,size=10,bold=false) { return 'BT /' + (bold?'F2':'F1') + ' ' + size + ' Tf 1 0 0 1 ' + x + ' ' + y + ' Tm ' + literal(value) + ' Tj ET\n'; }
  function right(x,y,value,size=10) { const v=ascii(value); size=Math.min(size,60/Math.max(1,v.length)/0.6); return text(x-v.length*size*0.6,y,v,size); }
  const objects = [null,'<< /Type /Catalog /Pages 2 0 R >>',null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
  const pageIds=[];
  for (const [pageIndex,rows] of chunks.entries()) {
    let stream = '0.12 0.20 0.26 rg\n' + text(40,754,LABEL,18,true) + text(40,731,model.evidenceLabel,9) +
      text(40,706,ascii(model.accountName).slice(0,65) + ' | Account ' + model.accountId,12,true) +
      text(40,686,model.period + ' | ' + model.accountCurrency + ' | ' + (isCard?'Card amount owed':'Bank balance'),11) +
      text(40,665,model.blockers.length?'DRAFT - BLOCKED: resolve the reasons listed in the manifest.':'SIMULATED - native preview and evidence still required.',9,true) +
      text(40,642,'Opening ' + formatMoney(model.openingMinor) + '    ' + (isCard?'Charges ':'Outflows ') + formatMoney(model.negativeMinor) +
        '    ' + (isCard?'Payments/credits ':'Inflows ') + formatMoney(model.positiveMinor),10) +
      text(40,622,'Closing ' + formatMoney(model.closingMinor) + ' ' + model.accountCurrency,12,true) +
      text(40,603,isCard?'Due date: ' + (model.dueDate?formatDate(model.dueDate):'not provided; no card terms inferred.'):'Opening basis: ' + ascii(model.openingBasis || 'see manifest').slice(0,88),9);
    stream += '0.90 0.94 0.95 rg 40 568 532 22 re f 0.12 0.20 0.26 rg\n' +
      text(44,576,'Posting date',9,true) + text(120,576,'Description / QBO reference',9,true) +
      text(368,576,isCard?'Charge':'Outflow',9,true) + text(432,576,isCard?'Payment':'Inflow',9,true) + text(514,576,'Balance',9,true);
    let y=552;
    if (!rows.length) stream += text(44,y,'No settled movements this month. The opening balance carries forward.',10);
    for (const row of rows) {
      const label = (row.description + ' / ' + row.sourceEntity + ' ' + row.sourceId).slice(0,48);
      stream += text(44,y,formatDate(row.date),9) + text(120,y,label,8) +
        right(414,y,row.amountMinor<0?formatMoney(-row.amountMinor):'',8) +
        right(482,y,row.amountMinor>0?formatMoney(row.amountMinor):'',8) + right(568,y,formatMoney(row.balanceMinor),8);
      y-=17;
    }
    stream += '0.75 0.81 0.84 RG 40 96 m 572 96 l S\n' + text(40,80,'Outstanding items: ' + model.outstandingItems.length + '. Full details and settlement advice are retained in the manifest.',8) +
      text(40,66,model.nativeStatus,8) + text(40,51,'Provisional history. Currency amounts are exact hundredths. Dates follow simulated posting policy unless evidenced.',7) +
      text(510,35,'Page ' + (pageIndex+1) + ' / ' + chunks.length,8);
    const pageId=objects.length; pageIds.push(pageId); objects.push(null);
    const contentId=objects.length; objects.push('<< /Length ' + Buffer.byteLength(stream,'ascii') + ' >>\nstream\n' + stream + 'endstream');
    objects[pageId]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + contentId + ' 0 R >>';
  }
  objects[2]='<< /Type /Pages /Count ' + pageIds.length + ' /Kids [' + pageIds.map(n=>n+' 0 R').join(' ') + '] >>';
  let pdf='%PDF-1.4\n', offsets=[0];
  for(let i=1;i<objects.length;i++) { offsets.push(Buffer.byteLength(pdf,'ascii')); pdf+=i+' 0 obj\n'+objects[i]+'\nendobj\n'; }
  const start=Buffer.byteLength(pdf,'ascii');
  pdf+='xref\n0 '+objects.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+
    'trailer\n<< /Size '+objects.length+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';
  const bytes=Buffer.from(pdf,'ascii');
  return {bytes,sha256:sha256(bytes),pageCount:chunks.length,model};
}
module.exports = { LABEL, buildStatementModel, generateBankStatementPdf };
