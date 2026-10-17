'use strict';
const { hash, canonical, date, shift } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
const { prepareBusinessOperation } = require('./business-operation-preview');
const { bindBusinessReference, createBusinessReferenceReader } = require('./business-reference');
const { deriveBusinessPolicies } = require('./business-tax-policy');
const { denied } = require('./qbo-write-contract');
function monthEnd(day) { const stamp = new Date(day + 'T12:00:00Z'); return new Date(Date.UTC(stamp.getUTCFullYear(),stamp.getUTCMonth()+1,0)).toISOString().slice(0,10); }
async function preparePopulationPlan({ active, scope, throughDate, setup, masters, access, originalIntents = [], existingRecords = [], now = Date.now() }) {
  date(throughDate);
  const fromDate = active.value.openingDate;
  if (throughDate < fromDate || throughDate > businessDate(new Date(now)) || date(throughDate)-date(fromDate) > 3660*86400000 || active.lineage) throw denied('Population supports the published single business schedule over elapsed dates, up to ten years.');
  const view = { ...scope, draft: active.view }, proposed = new Map(), bindings = new Map();
  for (let from = fromDate; from <= throughDate;) {
    const to = [monthEnd(from),throughDate].sort()[0];
    const prepared = prepareBusinessOperation(view,{ connectionId:scope.connectionId,baseHash:active.value.blueprintHash,fromDate:from,throughDate:to },setup,masters,new Date(now));
    for (const input of prepared.steps) {
      if(!['Estimate','Invoice','TimeActivity','Payment','Deposit','PurchaseOrder','Bill','SalesReceipt','BillPayment'].includes(input.entity))throw denied('This population version supports the core continuing accounting schedule. Other lifecycle cases require their separate validated workflow.');
      for (const ref of input.references) {
        if (ref.entity === 'TaxCode') { const code = setup.options.taxCodes.find(row => row.id === ref.id), direction = ref.key === 'salesTax' ? 'sales' : 'purchases'; if (setup.completeness.taxCodes && code?.active === true && (code[direction] === true || code.taxable === false) && typeof code.syncToken === 'string') ref.status = 'resolved'; }
        if (ref.status !== 'resolved') throw denied('Resolve every published master/account/tax choice before population.');
        bindings.set(ref.entity + ':' + ref.id,ref);
      }
      if (proposed.has(input.logicalKey)) throw denied('The published population schedule repeats a logical identity.');
      proposed.set(input.logicalKey,input);
    }
    if (proposed.size > 40000) throw denied('The population schedule exceeds 40000 records.');
    from = shift(to,1);
  }
  const reader = createBusinessReferenceReader({ ...access, now:()=>now }), observations = new Map();
  const queue = [...bindings.entries()]; let index = 0;
  let observationFailure=null;await Promise.allSettled(Array.from({length:Math.min(3,queue.length)},async()=>{ while(!observationFailure && index < queue.length){ const [key,ref]=queue[index++];try{observations.set(key,await reader(scope,ref.entity,ref.id));}catch(error){observationFailure ||= error;} } }));if(observationFailure)throw observationFailure;
  const originals = new Map();
  for (const original of [...originalIntents,...existingRecords.map(row=>({step:row.step,policy:row.policy}))]) {
    const step = original.step, current = proposed.get(step.logicalKey);
    if (!current || current.entity !== step.entity || current.txnDate !== step.txnDate || current.calendarFingerprint !== step.calendarFingerprint || current.detailsHash !== step.detailsHash || canonical(current.references.map(ref=>({key:ref.key,entity:ref.entity,id:ref.id})).sort((a,b)=>(a.entity+a.key).localeCompare(b.entity+b.key))) !== canonical(step.references.map(ref=>({key:ref.key,entity:ref.entity,id:ref.id})).sort((a,b)=>(a.entity+a.key).localeCompare(b.entity+b.key)))) throw denied('The original native activity differs from the published population schedule.');
    if (originals.has(step.logicalKey) && hash(originals.get(step.logicalKey)) !== hash({step:original.step,policy:original.policy})) throw denied('Conflicting original population intents exist.');
    originals.set(step.logicalKey,{step:original.step,policy:original.policy});
  }
  const retained = new Map(), visiting = new Set();
  function visit(key) {
    if (retained.has(key)) return retained.get(key);
    if (visiting.has(key)) throw denied('Population dependencies contain a cycle.');
    const input = proposed.get(key), original = originals.get(key); if (!input) throw denied('The population schedule omitted an earlier dependency.');
    visiting.add(key);
    const dependencies = input.dependencies.map(link => { const parent = visit(link.logicalKey); if (parent.step.entity !== link.entity || parent.step.txnDate > input.txnDate) throw denied('Population source identity/date differs.'); return {logicalKey:link.logicalKey,entity:link.entity,fingerprint:hash(parent.step)}; }).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey));
    let step;
    if (original) { step = original.step; if (canonical(step.dependencies) !== canonical(dependencies)) throw denied('Original native population dependencies changed.'); }
    else {
      const references = input.references.map(ref => ({ ...bindBusinessReference({scope,key:ref.key,entity:ref.entity,observed:observations.get(ref.entity+':'+ref.id),now}),status:'resolved' })).sort((a,b)=>(a.entity+':'+a.key).localeCompare(b.entity+':'+b.key));
      step = {logicalKey:key,entity:input.entity,txnDate:input.txnDate,calendarFingerprint:input.calendarFingerprint,detailsHash:input.detailsHash,details:input.details,references,dependencies};
    }
    const entry = {kind:'create',step,...(original ? {policy:original.policy}: {})};
    visiting.delete(key); retained.set(key,entry); return entry;
  }
  for (const key of proposed.keys()) visit(key);
  const client = await access.resolveClient(scope);
  const derived = await deriveBusinessPolicies({candidate:{scope,fromDate,throughDate,entries:[...retained.values()].filter(entry=>!entry.policy)}},client,active.authority.contentHash,now);
  const policies = new Map(derived.map(row=>[row.logicalKey,row.policy]));
  const records = [...retained.values()].map(entry=>{ const {step}=entry, policy=entry.policy || policies.get(step.logicalKey); if (!policy || policy.stepHash !== hash(step) || policy.authorityHash !== active.authority.contentHash) throw denied('The exact published population policy is unavailable.'); return {logicalKey:step.logicalKey,entity:step.entity,txnDate:step.txnDate,step,fingerprint:hash(step),policy,intentHash:hash({step,policy})}; }).sort((a,b)=>a.txnDate.localeCompare(b.txnDate)||a.logicalKey.localeCompare(b.logicalKey));
  const manifest = records.map(({logicalKey,fingerprint,intentHash,entity,txnDate})=>({logicalKey,fingerprint,intentHash,entity,txnDate}));
  return {fromDate,throughDate,records,manifest,manifestHash:hash(manifest)};
}
module.exports = { preparePopulationPlan, monthEnd };
