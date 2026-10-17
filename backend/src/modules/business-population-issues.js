'use strict';
const { hash, canonical } = require('./business-calendar');
const { denied } = require('./qbo-write-contract');
const DEFINITIONS = [
  { code: 'estimate-invoice-conversion-unverified', title: 'Estimate conversion', impact: 'The estimate may still appear open even though an invoice exists.', expected: 'The invoice links to the exact estimate, and the estimate links back to that invoice and is Closed.', steps: ['Open the listed invoice and estimate in QuickBooks.', 'Review their linked transactions and the estimate status. Compare the exact record IDs below.', 'Use a supported QuickBooks workflow or obtain support guidance for linking existing records. Do not create another invoice merely to remove this warning.', 'Return here and recheck. The app clears the warning only after confirming the relationship.'] },
  { code: 'time-invoice-billing-unverified', title: 'Time still marked billable', impact: 'Time already included on an invoice may still appear in unbilled-time reports.', expected: 'The invoice links to the exact time entry, and that entry is marked HasBeenBilled.', steps: ['Open the listed invoice and time entry in QuickBooks.', 'Review the invoice source link and whether the time entry is still billable.', 'Use a supported QuickBooks workflow or obtain support guidance for the existing records. Do not bill the same time again.', 'Return here and recheck. A recorded limitation keeps the warning visible and does not count as verification.'] },
  { code: 'record-verification-failed', title: 'Record could not be verified', impact: 'The latest check could not confirm the saved record or its original evidence.', expected: 'The exact saved identity, original receipt and current financial content agree.', steps: ['Review the affected record and its related IDs below.', 'Check company access and the displayed verification message.', 'Recheck after the underlying issue is resolved. Existing warnings and creation evidence are retained.'] },
];
const CODES = new Set(DEFINITIONS.map(value => value.code));
const HASH = /^[a-f0-9]{64}$/;
function recordQuery(scope, job) { return { ...scope, authorityHash: job.authorityHash, txnDate: { $gte: job.fromDate, $lte: job.throughDate } }; }
function issueCodes(row) { return [...new Set([...(row.coverageGaps || []).filter(code => CODES.has(code)), ...((row.relationshipCheck?.outcome === 'error'||(row.state==='saved'&&!row.financialProof)) ? ['record-verification-failed'] : [])])]; }
function sourceOf(row) { const json = row.financialProof?.sourceJson; if (typeof json !== 'string' || Buffer.byteLength(json) > 8000000 || hash(json) !== row.financialProof.sourceHash) return null; try { return JSON.parse(json); } catch { return null; } }
function recordEvidence(row) { const source = sourceOf(row); return hash({ fingerprint: row.fingerprint, receiptHash: row.receipt ? hash(row.receipt) : null, observedHash: source?.observed?.recordHash || null, neighbors: (source?.parents || []).map(value => ({ entity: value.entity, id: value.record?.Id, hash: value.recordHash })), children: (source?.children || []).map(value => ({ entity: value.entity, id: value.observed?.record?.Id, hash: value.observed?.recordHash })), error: row.relationshipCheck?.outcome === 'error' ? row.relationshipCheck.runId : null }); }
function issueView(row, code) {
  const source = sourceOf(row), observed = row.relationshipCheck?.snapshot || (source ? snapshot(source) : { entity: row.entity, qboId: row.qboId, status: 'Evidence unavailable', related: [], links: [] }), evidenceHash = recordEvidence(row), decision = row.issueDecisions?.[code];
  return { recordId: String(row._id), logicalKey: row.logicalKey, entity: row.entity, qboId: row.qboId, txnDate: row.txnDate, code, evidenceHash, observed, lastCheckedAt: row.relationshipCheck?.checkedAt || row.financialProof?.observedAt || null, message: row.relationshipCheck?.outcome === 'error' ? row.relationshipCheck.message : null, limitation: decision?.evidenceHash === evidenceHash ? { reason: decision.reason, recordedAt: decision.recordedAt } : null };
}
function snapshot(source) {
  if (!source) return { status: 'Evidence unavailable', related: [] };
  const clean = (entity, record) => ({ entity, qboId: record?.Id || null, status: record?.TxnStatus || record?.BillableStatus || null, totalAmount:Number.isFinite(record?.TotalAmt)?record.TotalAmt:null, currency:record?.CurrencyRef?.value || null, lineAmounts:(record?.Line || []).filter(line=>line.DetailType!=='SubTotalLineDetail'&&Number.isFinite(line.Amount)).slice(0,20).map(line=>line.Amount), links: (record?.LinkedTxn || []).slice(0,20).map(link => ({ entity: link.TxnType, qboId: link.TxnId })) });
  return { ...clean(source.compiled?.entity, source.observed?.record), related: [...(source.parents || []).map(parent => clean(parent.entity, parent.record)), ...(source.children || []).map(child => clean(child.entity, child.observed?.record))].slice(0,20) };
}
// Only callers with freshly replayed financial/creation evidence may use this facet.
// Estimate conversion is independent: time can be billed while its quote stays open.
function hasBilledTime(financialProof, expectedTimeId = null) {
  const source = sourceOf({ financialProof });
  if (!source || financialProof.matchesFinancialIntent !== true || source.compiled?.entity !== 'Invoice') return false;
  const bindings = (source.compiled.relationships || []).filter(link => link.entity === 'TimeActivity');
  if (bindings.length !== 1) return false;
  const binding = bindings[0], parents = (source.parents || []).filter(parent => parent.entity === 'TimeActivity' && parent.logicalKey === binding.logicalKey && parent.fingerprint === binding.fingerprint && parent.record?.Id === binding.qboId);
  if (parents.length !== 1 || parents[0].record.BillableStatus !== 'HasBeenBilled' || (expectedTimeId !== null && binding.qboId !== expectedTimeId)) return false;
  const invoice = source.observed?.record;
  return invoice?.Id === source.receipt?.qboId && (invoice.LinkedTxn || []).filter(link => link.TxnType === 'TimeActivity' && link.TxnId === binding.qboId).length === 1;
}
function isConversion(row) { return row.entity === 'Invoice' && (row.step?.dependencies || row.compilation?.relationships || []).some(link => link.entity === 'Estimate'); }
function strictConversion(financialProof, now) {
  if (!financialProof || financialProof.matchesFinancialIntent !== true || financialProof.coverageGaps?.length || typeof financialProof.sourceJson !== 'string' || hash(financialProof.sourceJson) !== financialProof.sourceHash) return false;
  const source = JSON.parse(financialProof.sourceJson);
  if (source.compiled.relationships.some(link => link.entity === 'Estimate' && link.representation === 'whole-estimate-header')) return require('./business-estimate-conversion').verifyWholeEstimateCreation({ ...source, now });
  return strictLegacyConversion(source);

}
function strictLegacyConversion(source) {
  const {compiled,receipt,observed,parents}=source,quoteBinding=compiled.relationships.find(link=>link.entity==='Estimate'),timeBinding=compiled.relationships.find(link=>link.entity==='TimeActivity');
  if(compiled.entity!=='Invoice'||compiled.relationships.length!==2||!quoteBinding||!timeBinding||quoteBinding.representation!==undefined||!quoteBinding.links.some(link=>/^Line[.][0-9]+[.]LinkedTxn$/.test(link.path)))return false;
  const quote=parents.find(parent=>parent.logicalKey===quoteBinding.logicalKey)?.record,time=parents.find(parent=>parent.logicalKey===timeBinding.logicalKey)?.record,invoice=observed.record,payload=JSON.parse(compiled.request.body);
  if(!quote||!time||quote.Id!==quoteBinding.qboId||time.Id!==timeBinding.qboId||quote.TxnStatus!=='Closed'||time.BillableStatus!=='HasBeenBilled'||quote.LinkedTxn?.length!==1||quote.LinkedTxn[0].TxnType!=='Invoice'||quote.LinkedTxn[0].TxnId!==receipt.qboId)return false;
  const at=(value,path)=>path.split('.').reduce((current,key)=>current?.[key],value);
  for(const binding of compiled.relationships)for(const link of binding.links){if(link.path!=='LinkedTxn'&&!/^Line[.][0-9]+[.]LinkedTxn$/.test(link.path))return false;const requested=at(payload,link.path)?.filter(value=>value.TxnType===binding.entity&&value.TxnId===binding.qboId),actual=at(invoice,link.path);if(requested?.length!==1||!Array.isArray(actual)||!actual.some(value=>canonical(value)===canonical(requested[0])))return false;if(requested[0].TxnLineId&&quote.Line?.filter(line=>line.Id===requested[0].TxnLineId&&line.DetailType==='SalesItemLineDetail').length!==1)return false;}
  const lines=record=>(record.Line||[]).filter(line=>line.DetailType!=='SubTotalLineDetail'),billed=lines(invoice),quoted=lines(quote);if(billed.length!==1||quoted.length!==1||payload.Line?.length!==1)return false;
  const economy=line=>({amount:line.Amount,type:line.DetailType,item:line.SalesItemLineDetail?.ItemRef?.value||null,quantity:line.SalesItemLineDetail?.Qty??null,price:line.SalesItemLineDetail?.UnitPrice??null,tax:line.SalesItemLineDetail?.TaxCodeRef?.value||null});
  const tax=record=>({total:record.TxnTaxDetail?.TotalTax??null,lines:(record.TxnTaxDetail?.TaxLine||[]).map(line=>({amount:line.Amount,type:line.DetailType,rate:line.TaxLineDetail?.TaxRateRef?.value||null,percent:line.TaxLineDetail?.TaxPercent??null,net:line.TaxLineDetail?.NetAmountTaxable??null,based:line.TaxLineDetail?.PercentBased??null}))});
  return canonical(economy(billed[0]))===canonical(economy(quoted[0]))&&canonical(tax(invoice))===canonical(tax(quote))&&invoice.TotalAmt===quote.TotalAmt&&invoice.CurrencyRef?.value==='CAD'&&quote.CurrencyRef?.value==='CAD'&&(invoice.ExchangeRate??null)===(quote.ExchangeRate??null)&&invoice.GlobalTaxCalculation===quote.GlobalTaxCalculation&&invoice.CustomerRef?.value===quote.CustomerRef?.value&&time.CustomerRef?.value===invoice.CustomerRef?.value&&time.ItemRef?.value===billed[0].SalesItemLineDetail?.ItemRef?.value&&time.Hours+time.Minutes/60===billed[0].SalesItemLineDetail?.Qty;
}
function relationshipProof(row, financialProof, now) {
  const matches = strictConversion(financialProof, now), validatedAt=new Date(now).toISOString();
  return { version: 1, kind: 'population-estimate-time-relationship', logicalKey: row.logicalKey, fingerprint: row.fingerprint, qboId: row.qboId, receiptHash: hash(row.receipt), financialEvidenceHash: financialProof.evidenceHash, observedAt: financialProof.observedAt, validatedAt, matches, evidenceHash: hash({ logicalKey: row.logicalKey, fingerprint: row.fingerprint, qboId: row.qboId, financialEvidenceHash: financialProof.evidenceHash, validatedAt, matches }) };
}
function validRelationshipProof(row) {
  try {
    const proof=row.relationshipProof,financial=row.financialProof,source=sourceOf(row);
    if(!proof||!financial||!source||proof.version!==1||proof.kind!=='population-estimate-time-relationship'||proof.matches!==true||proof.logicalKey!==row.logicalKey||proof.fingerprint!==row.fingerprint||proof.qboId!==row.qboId||proof.receiptHash!==hash(row.receipt)||proof.financialEvidenceHash!==financial.evidenceHash||!/^[a-f0-9]{24}$/.test(proof.auditId||''))return false;
    if(row.fingerprint!==hash(row.step)||row.intentHash!==hash({step:row.step,policy:row.policy})||hash(source.compiled)!==hash(row.compilation)||hash(source.receipt)!==hash(row.receipt))return false;
    const expected=require('./business-verification-runtime').taxExpectation(row.policy,row.compilation),scope=row.compilation.request.scope;
    const taxPolicy=expected?{...expected,status:'approved',scope,compilationHash:row.compilation.compilationHash,evidenceHash:hash({policyHash:hash(row.policy),compilationHash:row.compilation.compilationHash,expected})}:null;
    if(canonical(taxPolicy)!==canonical(source.taxPolicy))return false;
    const observedAt=Date.parse(proof.validatedAt);if(!Number.isFinite(observedAt)||!strictConversion(financial,observedAt))return false;
    const replayed=require('./business-readback').verifyPopulationFinancialContent({...source,now:observedAt});
    return canonical(replayed)===canonical(financial)&&proof.evidenceHash===hash({logicalKey:row.logicalKey,fingerprint:row.fingerprint,qboId:row.qboId,financialEvidenceHash:financial.evidenceHash,validatedAt:proof.validatedAt,matches:true});
  }catch{return false;}
}
async function assertRelationshipAudit(models,scope,row,session,ownerId,actorId){
  if(!validRelationshipProof(row))throw denied('The strict relationship evidence changed.');
  const proof=row.relationshipProof,audit=await models.Audits.findOne({_id:proof.auditId,realmId:scope.realmId}).session(session).maxTimeMS(5000).lean(),state=audit?.afterState;
  if(String(audit?.userId)!==ownerId||String(audit?.actorUserId||audit?.userId)!==actorId||audit?.action!=='Business population relationship-evidence-observed'||audit.outcome!=='success'||state?.environment!==scope.environment||String(state.connectionId)!==String(scope.connectionId)||state.realmId!==scope.realmId||state.logicalKey!==row.logicalKey||state.qboId!==row.qboId||state.receiptHash!==proof.receiptHash||state.financialEvidenceHash!==proof.financialEvidenceHash||state.relationshipEvidenceHash!==proof.evidenceHash||state.matches!==true||state.observedAt!==proof.observedAt||state.validatedAt!==proof.validatedAt||state.qboWrites!==0)throw denied('The original relationship observation audit changed.');
}
function assertIssueCode(code) { if (!CODES.has(code)) throw denied('Choose an existing relationship issue.'); }
module.exports = { DEFINITIONS, CODES, recordQuery, issueCodes, issueView, recordEvidence, snapshot, sourceOf, hasBilledTime, isConversion, strictConversion, relationshipProof, validRelationshipProof, assertRelationshipAudit, assertIssueCode };
