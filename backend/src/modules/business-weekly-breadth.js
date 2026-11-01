'use strict';
// Pure analysis of a supplied CompanySyncRecord snapshot; never contacts QBO/Mongo.
const {SITUATIONS,accountSituations,VERSION,AREA_NAMES,settings,settingText,helpers:h}=require('./business-situation-catalog');
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const dateOf=v => typeof v==='string' && DAY.test(v.slice(0,10)) ? v.slice(0,10) : null;
function localDay(now) { return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Halifax',year:'numeric',month:'2-digit',day:'2-digit'}).format(now); }
function before(day,n) { const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10); }
function sourceStatus(source,now) {
  if (!source) return 'not-mirrored';
  const at=Date.parse(source.lastSuccessAt), window=Math.max(Number(source.everyMs)||300000,60000)*2;
  if (source.phase!=='incremental') return 'incomplete';
  if (source.status!=='current') return source.status||'incomplete';
  return Number.isFinite(at) && at<=now && now-at<=window ? 'current':'stale';
}
const transactionDate = row => row.entity === 'TaxPayment' ? row.record.PaymentDate : row.record.TxnDate;
const example=row => row ? {entity:row.entity,id:String(row.qboId ?? row.record.Id),deleted:h.deleted(row),href:h.deleted(row)?null:'/explorer?type='+encodeURIComponent(row.entity)+'&id='+encodeURIComponent(row.qboId ?? row.record.Id)}:null;
function prepare(snapshot,{now=new Date(),today=localDay(now)}={}) {
  if (!DAY.test(today) || Number.isNaN(Date.parse(today))) throw new TypeError('Coverage needs a valid date.');
  const records=snapshot.records||[],sources=snapshot.sources||{};
  const live=records.filter(r=>!h.deleted(r) && (!dateOf(transactionDate(r)) || transactionDate(r)<=today)),byId=new Map(live.map(r=>[r.entity+':'+r.qboId,r.record]));
  const preferences=live.find(r=>r.entity==='Preferences')?.record||{},info=live.find(r=>r.entity==='CompanyInfo')?.record||{};
  const ctx={today,byId,preferences,homeCurrency:preferences.CurrencyPrefs?.HomeCurrency?.value||'CAD',province:info.CompanyAddr?.CountrySubDivisionCode||null,creditApplied:new Set(),estimateInvoiced:new Set(),poReceived:new Map()};
  for(const row of live) {
    const r=row.record,links=h.links(r);
    if(['Payment','BillPayment'].includes(row.entity) && !h.voided(r)) {
      const credit=row.entity==='Payment'?'CreditMemo':'VendorCredit',obligation=row.entity==='Payment'?'Invoice':'Bill';
      if(links.some(l=>l.TxnType===credit)) for(const l of links.filter(l=>l.TxnType===obligation)) ctx.creditApplied.add(obligation+':'+l.TxnId);
    }
    if(row.entity==='Invoice' && !h.voided(r)) for(const l of links.filter(l=>l.TxnType==='Estimate')) ctx.estimateInvoiced.add(String(l.TxnId));
    if(row.entity==='Bill') for(const l of h.line(r)) {
      const qty=Number(l.ItemBasedExpenseLineDetail?.Qty)||0;
      for(const link of l.LinkedTxn||[]) if(link.TxnType==='PurchaseOrder') ctx.poReceived.set(String(link.TxnId),(ctx.poReceived.get(String(link.TxnId))||0)+qty);
    }
  }
  return {records,live,sources,ctx,now:new Date(now).getTime(),today,start:before(today,6),truncated:snapshot.truncated===true};
}
function availability(def,p) {
  if(def.owner) return {reachability:'needs-owner-setting',needed:def.owner};
  if(def.setting && !settings[def.setting](p.ctx.preferences)) return {reachability:'needs-owner-setting',needed:settingText[def.setting]+'.'+(def.tool?' Then '+def.tool:' Use governed tools after the setting is enabled.')};
  if(def.tool || !p.sources[def.entity]) return {reachability:'needs-tool',needed:def.tool||'Add a supported governed '+def.entity+' tool and mirror evidence.'};
  return {reachability:'reachable-now',needed:def.need||'Use current governed tools on eligible records; retain saved links and accounting evidence.'};
}
function evaluate(def,p) {
  const dependencies=[...new Set([...(def.entities||[def.entity]),...(def.dependencies||[])])];
  const incomplete=dependencies.filter(e=>sourceStatus(p.sources[e],p.now)!=='current');
  const candidates=p.records.filter(row=>(def.entities||[def.entity]).includes(row.entity) && (def.tombstone?h.deleted(row):!h.deleted(row)));
  const matches=candidates.filter(row=> {
    const date=dateOf(transactionDate(row));
    return (!date || date<=p.today) && def.match(row.record,p.ctx,row);
  });
  // List creation dates measure setup added that week. Observation/sync timestamps never
  // substitute for business dates. Only native dated deletion events establish deletion time.
  const date=row=>def.tombstone ? (row.record.status==='Deleted'?dateOf(row.record.MetaData?.LastUpdatedTime):null) : def.kind==='activity'?dateOf(transactionDate(row)):dateOf(row.record.MetaData?.CreateTime);
  matches.sort((a,b)=>(date(b)||'').localeCompare(date(a)||'') || String(a.qboId).localeCompare(String(b.qboId)));
  const recent=matches.filter(row=>date(row)>=p.start && date(row)<=p.today);
  const complete=!p.truncated && !incomplete.length && def.observable!==false && !(def.historyLimited && !matches.length);
  const weeklyComplete=complete && !matches.some(row=>!date(row));
  const status=!complete?'unknown':!matches.length?'missing':def.kind==='activity'&&weeklyComplete&&!matches.some(row=>date(row)>=before(p.today,(def.freshDays||7)-1))?'stale':'present';
  return {key:def.key,entity:def.entity,label:def.label,area:def.area,group:def.group,kind:def.kind,...(def.freshDays?{freshDays:def.freshDays}:{}),
    ...(def.accountId?{accountId:def.accountId}:{}),...(def.checklist?{checklist:def.checklist(p.today)}:{}),
    status,presentAtAll:matches.length?true:complete?false:null,presentLast7Days:recent.length?true:weeklyComplete?false:null,
    count:matches.length,recentCount:recent.length,last:matches.length?date(matches[0]):null,
    example:example(matches[0]),recentExample:example(recent[0]),...availability(def,p),...(def.checklist?{needed:availability(def,p).needed+' '+def.checklist(p.today).steps.join(' ')}:{}),
    evidence:{complete,weeklyComplete,source:'CompanySyncRecord',incompleteSources:incomplete,reason:incomplete.length?'Mirror sources are unavailable, incomplete or stale.':p.truncated?'Mirror scan cap reached.':def.observable===false?'The mirror cannot establish this native state.':def.historyLimited&&!matches.length?'Historical deletions before mirror capture are unknown.':null}};
}
function summarize(rows) {
  return rows.reduce((a,r)=>{a.total++;a[r.status]=(a[r.status]||0)+1;if(['missing','stale'].includes(r.status)){a.gaps++;a[r.reachability]=(a[r.reachability]||0)+1;}return a;},{total:0,present:0,missing:0,stale:0,unknown:0,gaps:0});
}
const rank={missing:0,stale:1,unknown:2,present:3};
function situations(snapshot,options={}) {
  const p=prepare(snapshot,options),accounts=require('./business-account-coverage').measureAccounts(p.records,p.today).map(a=>{const incomplete=['Account',...require('./business-account-coverage').TRANSACTIONS].filter(e=>sourceStatus(p.sources[e],p.now)!=='current');return {...a,balanceObservedAt:a.balanceObservedAt||p.sources.Account?.lastSuccessAt||null,evidence:{complete:!p.truncated&&!incomplete.length,incompleteSources:incomplete,truncated:p.truncated,meaning:'Observed account-reference counts, not GL entry counts. Incomplete or stale sources cannot establish absence; the mirrored balance is not an external statement.'}};}),rows=[...SITUATIONS,...accountSituations(accounts,p.ctx.homeCurrency)].map(d=>evaluate(d,p)).sort((a,b)=>rank[a.status]-rank[b.status] || a.entity.localeCompare(b.entity) || a.label.localeCompare(b.label));
  return {version:VERSION,accounts,asOf:p.today,from:p.start,through:p.today,summary:summarize(rows),rows,
    groups:[...new Set(rows.map(r=>r.group))].map(group=>({key:group,name:group,summary:summarize(rows.filter(r=>r.group===group))})),
    source:'synced-copy',meaning:'Current retained states across all mirrored history. Seven-day activity uses TxnDate (PaymentDate for TaxPayment), setup uses creation date, deletion requires a dated native deletion event. Unknown is not a gap. This inventory is extensible and does not claim every possible combination.'};
}
function weekly(snapshot,options={}) {
  const p=prepare(snapshot,options),scored=options.situations||situations(snapshot,options);
  const rows=scored.rows.filter(r=>r.kind==='activity'&&(!r.freshDays||r.freshDays<=7)).map(r=>({...r,status:r.evidence.weeklyComplete?(r.recentCount?'present':'missing'):'unknown',count:r.recentCount,retainedCount:r.count,example:r.recentExample||r.example,evidence:{...r.evidence,complete:r.evidence.weeklyComplete,reason:r.evidence.reason||(!r.evidence.weeklyComplete?'Matching records lack a reliable business or native deletion date.':null)}}));
  // Every active class/location must occur on saved activity, not merely in setup.
  const activities=p.live.filter(r=>!!transactionDate(r) && transactionDate(r)>=p.start && transactionDate(r)<=p.today && !h.voided(r.record));
  const activityEntities=[...new Set(SITUATIONS.filter(d=>d.kind==='activity').map(d=>d.entity))].filter(e=>e !== 'InventoryAdjustment');
  for(const [entity,ref,setting] of [['Class','ClassRef','classes'],['Department','DepartmentRef','locations']]) {
    for(const dimension of p.live.filter(r=>r.entity===entity && r.record.Active===true)) {
      const matches=activities.filter(r=>h.refs(r.record,ref).includes(String(dimension.qboId)));
      const incomplete=[entity,...activityEntities].filter(e=>sourceStatus(p.sources[e],p.now)!=='current');
      const complete=!p.truncated&&!incomplete.length;
      const def={entity,setting};
      rows.push({key:'weekly.'+entity+'.'+dimension.qboId,entity,label:dimension.record.Name||entity+' '+dimension.qboId,area:'company.dimensions',group:entity==='Class'?'Every class':'Every location',kind:'dimension',
        status:complete?(matches.length?'present':'missing'):'unknown',count:matches.length,recentCount:matches.length,example:example(matches[0]),setupExample:example(dimension),
        ...availability(def,p),evidence:{complete,incompleteSources:incomplete,source:'CompanySyncRecord'}});
    }
  }
  rows.sort((a,b)=>rank[a.status]-rank[b.status]||a.group.localeCompare(b.group)||a.label.localeCompare(b.label));
  return {version:VERSION,from:p.start,through:p.today,days:7,summary:summarize(rows),rows,source:'synced-copy',meaning:'Each activity situation and every active bank/card/cash account and class/location needs dated evidence in this inclusive seven-day window. Setup existence is not weekly use; a missing weekly state is a breadth target, not permission to alter protected history.'};
}
module.exports={situations,weekly,sourceStatus,localDay,AREA_NAMES};
