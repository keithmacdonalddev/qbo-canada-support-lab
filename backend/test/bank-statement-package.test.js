'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const moduleRoot=process.env.BF2_MODULE_ROOT || path.join(__dirname,'../src/modules');
const C=require(path.join(moduleRoot,'bank-settlement-contract'));
const {generateBankFeedCsv,formatMoney}=require(path.join(moduleRoot,'bank-feed-csv'));
const {generateBankStatementPdf}=require(path.join(moduleRoot,'bank-statement-pdf'));
const {generateBankStatementPackages}=require(path.join(moduleRoot,'bank-statement-package'));
const {buildSettlementEvents}=require('../src/modules/bank-settlement-engine');
const history=require('./fixtures/bank-settlement-history.json');
const clone=v=>JSON.parse(JSON.stringify(v));
const scope=history.scope;
function event(id,accountId='b',amountMinor=12345,date='2026-09-15') {
  const card=accountId==='c';
  return {contractVersion:1,eventId:'event_'+id,scope,accountId,accountCurrency:'CAD',accountType:card?'Credit Card':'Bank',
    evidenceType:'bank-or-card-statement',kind:'purchase',status:'resolved',amountMinor,bookAmountMinor:card?-amountMinor:amountMinor,
    cardDebtChangeMinor:card?-amountMinor:null,direction:amountMinor>0?'inflow':'outflow',settlementGroupId:'group_'+id,pairedEventId:null,
    bookDate:date,expectedPostingDate:date,actualPostingDate:null,statementPeriod:date.slice(0,7),source:{entity:'Purchase',id:String(id),sourceHash:C.hash(id),depositBreakdown:[]},
    resolution:{action:'Match',designatedCreator:'existing-qbo',linkedQboIds:[{entity:'Purchase',id:String(id)}],nativeActionBlockers:[]},
    policyVersion:'bank-settlement-v1',revision:1,supersededBy:null,generatedFileReferences:[]};
}
function dataset(events=[event('one')]) {
  return {kind:'bank-settlement-dataset',contractVersion:1,scope,sourceHash:C.hash('small'),asOf:'2026-10-31',policy:{version:'bank-settlement-v1'},
    accounts:[{id:'b',name:'Operating bank',type:'Bank',currency:'CAD',evidenceType:'bank-or-card-statement'},
      {id:'c',name:'Credit card',type:'Credit Card',currency:'CAD',evidenceType:'bank-or-card-statement'}],events,
    coverage:{retainedLedgerRows:events.length,representedLedgerRows:events.length,issues:[]},outstandingItems:[],
    provisionalRanges:['b','c'].map(accountId=>({accountId,evidenceType:'bank-or-card-statement',provisionalStartMonth:'2026-09',provisionalEndMonth:'2026-10',periods:2,basis:'fixture range'}))};
}
const openingBalances=['b','c'].map(accountId=>({accountId,period:'2026-09',amountMinor:10000,evidenceRef:'fixture-opening',basis:'explicit fixture opening'}));
const csvOptions={scope,accountId:'b',accountCurrency:'CAD'};
function bytesOf(p,kind) { return p.artifacts.find(a=>a.kind===kind).bytes; }

test('Canadian CSV uses exact signs, dates, CRLF and safe descriptions; splits at row and byte boundaries',()=>{
  const events=[event('a','b',100),event('b','b',-333)]; events[0].description='=2+cmd,\r\nUser 123';
  const csv=generateBankFeedCsv(events,{...csvOptions,maxRows:1});
  assert.equal(csv.files.length,2); assert.equal(csv.files[0].rowCount,1);
  const all=csv.files.map(f=>f.bytes.toString()).join('');
  assert.match(all,/15\/09\/2026,cmd User,1.00\r\n/); assert.match(all,/-3.33\r\n/);
  assert.ok(!all.includes('\n') || !all.replace(/\r\n/g,'').includes('\n'));
  const split=generateBankFeedCsv(Array.from({length:1000},(_,i)=>event('r'+i)),csvOptions);
  assert.deepEqual(split.files.map(f=>f.rowCount),[999,1]);
  const byBytes=generateBankFeedCsv(Array.from({length:8},(_,i)=>({...event('long'+i),description:'a'.repeat(100)})),{...csvOptions,maxBytes:160});
  assert.equal(byBytes.files.length,8); assert.ok(byBytes.files.every(f=>f.bytes.length<=160));
  assert.throws(()=>generateBankFeedCsv(events,{...csvOptions,maxRows:1000}),/limits/);
  assert.equal(formatMoney(Number.MAX_SAFE_INTEGER),'90071992547409.91');
});

test('rejects scope, currency, duplicates, unresolved, superseded and unsafe arithmetic',()=>{
  for(const patch of [{scope:{...scope,realmId:'different'}},{accountCurrency:'USD'},{status:'unresolved',resolution:{action:'investigate',reason:{code:'unproved'}}},{supersededBy:'later'}]) {
    assert.throws(()=>generateBankFeedCsv([{...event('bad'),...patch}],csvOptions));
  }
  assert.throws(()=>generateBankFeedCsv([event('same'),event('same')],csvOptions),/unique/);
  assert.throws(()=>generateBankStatementPackages(dataset([event('big','b',Number.MAX_SAFE_INTEGER)]),{openingBalances}),/safe integer/);
});

test('one canonical dataset ties CSV, PDF model, manifest, carry-forward and quiet months',()=>{
  const input=dataset([event('in','b',10001),event('out','b',-2500),event('charge','c',-15000),event('pay','c',5000)]);
  const result=generateBankStatementPackages(input,{openingBalances});
  assert.equal(result.packages.length,4); assert.equal(result.summary.readyPeriods,4);
  for(const p of result.packages) {
    const e=p.envelope, total=C.sum(e.events.map(x=>x.amountMinor));
    assert.equal(e.closingMinor,C.sum([e.openingMinor,e.balanceConvention==='card-amount-owed'?-total:total]));
    assert.equal(p.statement.closingMinor,e.closingMinor);
    const csvTotal=C.sum(p.artifacts.filter(a=>a.kind==='csv').flatMap(a=>a.bytes.toString().trim().split('\r\n').slice(1).map(line=>C.minor(line.split(',')[2]))));
    assert.equal(total,csvTotal); assert.equal(p.manifest.statementTotals.rowCount,e.rows.length);
    assert.ok(bytesOf(p,'statement').subarray(0,8).equals(Buffer.from('%PDF-1.4')));
    const parsed=JSON.parse(bytesOf(p,'manifest')); assert.equal(parsed.packageId,p.packageId);
    for(const a of p.artifacts) assert.equal(require('node:crypto').createHash('sha256').update(a.bytes).digest('hex'),a.sha256);
    assert.ok(p.artifacts.every(a=>a.path.startsWith(C.hash(scope)+'/'+e.accountId+'/')));
  }
  for(const a of ['b','c']) {
    const [first,quiet]=result.packages.filter(p=>p.envelope.accountId===a);
    assert.equal(quiet.envelope.openingMinor,first.envelope.closingMinor); assert.equal(quiet.envelope.closingMinor,first.envelope.closingMinor);
    assert.equal(quiet.manifest.uploadRequired,false); assert.equal(quiet.artifacts.filter(a=>a.kind==='csv').length,0);
  }
  assert.equal(result.packages.find(p=>p.envelope.accountId==='c').statement.closingMinor,20000);
});

test('immutable deterministic revisions preserve original bytes and request later review',()=>{
  const input=dataset(), first=generateBankStatementPackages(input,{openingBalances});
  const prior=first.packages, bytes=Buffer.from(bytesOf(prior[0],'statement'));
  const repeated=generateBankStatementPackages(clone(input),{openingBalances,previousPackages:prior});
  assert.equal(repeated.packages[0].packageId,prior[0].packageId);
  assert.deepEqual(repeated.packages.map(p=>p.artifacts.map(a=>a.sha256)),prior.map(p=>p.artifacts.map(a=>a.sha256)));
  assert.throws(()=>{prior[0].envelope.closingMinor=1;},TypeError);
  const changed=clone(input); changed.events[0].amountMinor++; changed.events[0].bookAmountMinor++;
  const next=generateBankStatementPackages(changed,{openingBalances,previousPackages:prior}).packages[0];
  assert.equal(next.envelope.revision,2); assert.equal(next.envelope.previousPackageId,prior[0].packageId);
  assert.notEqual(next.envelope.files[0].path,prior[0].envelope.files[0].path);
  assert.deepEqual(next.manifest.laterPeriodsRequiringReview,['2026-10']);
  assert.ok(bytes.equals(bytesOf(prior[0],'statement')));
  assert.throws(()=>generateBankStatementPackages(input,{openingBalances,previousPackages:[{...prior[0],envelope:{...prior[0].envelope,scope:{...scope,realmId:'other'}}}]}));
});

test('unknown movement blocks its period and subsequent balances; no balancing plug or empty upload',()=>{
  const unknown={...event('unknown'),status:'unresolved',amountMinor:null,bookAmountMinor:null,resolution:{action:'investigate',reason:{code:'unknown-native-money'}}};
  const result=generateBankStatementPackages(dataset([unknown]),{openingBalances});
  const affected=result.packages.filter(p=>p.envelope.accountId==='b');
  assert.ok(affected.every(p=>p.envelope.blockers.some(b=>b.includes('unknown-native-money'))));
  assert.ok(affected.every(p=>p.envelope.events.length===0 && !p.manifest.uploadRequired));
  assert.ok(result.packages.filter(p=>p.envelope.accountId==='c').every(p=>p.manifest.readyForNativeWork));
  const noOpening=generateBankStatementPackages(dataset());
  assert.ok(noOpening.packages.every(p=>p.envelope.blockers.some(b=>b.includes('opening-balance-unproved'))));
});

test('posting lag, paired settlements, native R blockers and separate duplicate scenarios are retained',()=>{
  const a=event('from','b',-10000,'2026-09-30'), b=event('to','c',10000,'2026-10-01');
  a.source.entity=b.source.entity='Transfer'; a.pairedEventId=b.eventId; b.pairedEventId=a.eventId; b.settlementGroupId=a.settlementGroupId;
  a.expectedPostingDate='2026-10-02'; a.statementPeriod='2026-10'; a.resolution.nativeActionBlockers=['existing-reconciled-mark-requires-native-inspection'];
  const dupe=event('duplicate'); dupe.resolution.action='Exclude';
  const result=generateBankStatementPackages(dataset([a,b,dupe]),{openingBalances});
  const sep=result.packages.find(p=>p.envelope.accountId==='b' && p.envelope.period==='2026-09');
  assert.equal(sep.envelope.outstandingItems.length,1); assert.equal(sep.envelope.events.length,0);
  const oct=result.packages.find(p=>p.envelope.accountId==='b' && p.envelope.period==='2026-10');
  assert.equal(oct.manifest.crosswalk[0].pairedEventId,b.eventId); assert.ok(oct.envelope.blockers.some(b=>b.includes('native-inspection')));
  const broken=generateBankStatementPackages(dataset([a]),{openingBalances});
  assert.ok(broken.packages.some(p=>p.envelope.blockers.some(b=>b.includes('paired-settlement-unproved'))));
  assert.equal(sep.manifest.excludedEvents.length,1);
});

test('date validation and PDF pagination keep every row and exact xref offsets',()=>{
  assert.throws(()=>generateBankFeedCsv([{...event('bad-date'),expectedPostingDate:'2026-02-30'}],csvOptions),/date/);
  const input=dataset(Array.from({length:55},(_,i)=>event('multi'+i)));
  const result=generateBankStatementPackages(input,{openingBalances});
  const pdf=result.packages[0].artifacts.find(a=>a.kind==='statement').bytes.toString('ascii');
  assert.match(pdf,/\/Count 3/); assert.match(pdf,/Page 3 \/ 3/);
  const start=Number(pdf.match(/startxref\n(\d+)/)[1]); assert.equal(pdf.slice(start,start+4),'xref');
  const offsets=pdf.slice(start).split('\n').filter(l=>/^\d{10} 00000 n/.test(l)).map(l=>Number(l.slice(0,10)));
  offsets.forEach((offset,i)=>assert.equal(pdf.slice(offset,offset+String(i+1).length+6),(i+1)+' 0 obj'));
  assert.throws(()=>generateBankStatementPdf({...result.packages[0].envelope,closingMinor:1}),/disagree/);
});

test('offline production replay: all retained history periods, real source ids and 1385 deposit links',()=>{
  const data=buildSettlementEvents(history), before=C.hash(data), result=generateBankStatementPackages(data);
  assert.equal(result.summary.externalPeriods,324); assert.equal(result.summary.cashPeriods,116);
  assert.equal(C.hash(data),before); assert.equal(data.depositLinks.length,1385);
  const selected=result.packages.flatMap(p=>p.envelope.events);
  assert.equal(new Set(selected.map(e=>e.eventId)).size,selected.length);
  assert.equal(selected.find(e=>e.source.entity==='Invoice' && e.source.id==='486').amountMinor,5000);
  assert.equal(selected.find(e=>e.source.entity==='Payment' && e.source.id==='26').amountMinor,342349);
  for(const id of ['343','345']) assert.equal(selected.filter(e=>e.source.entity==='Transfer' && e.source.id===id).length,2);
  assert.equal(selected.filter(e=>e.source.entity==='CreditCardPayment' && e.source.id==='483').length,2);
  assert.equal(selected.filter(e=>e.source.entity==='JournalEntry' && e.source.id==='200').length,0);
  const cashIds=new Set(result.cashPeriods.map(p=>p.accountId));
  const unexportedCash=data.events.filter(e=>e.status==='resolved' && cashIds.has(e.accountId) && !result.beyondRangeEvents.some(x=>x.eventId===e.eventId));
  assert.equal(selected.length + result.beyondRangeEvents.length + unexportedCash.length,data.summary.resolvedEvents);
  assert.equal(selected.length,3722); assert.equal(result.beyondRangeEvents.length,56);
  assert.ok(result.packages.some(p=>p.envelope.blockers.some(b=>b.includes('report-only-adjustment-economic-meaning-unclassified'))));
  for(const p of result.packages) {
    assert.equal(p.statement.closingMinor,p.envelope.closingMinor);
    assert.ok(p.artifacts.filter(a=>a.kind==='csv').every(a=>a.rowCount<=999 && a.bytes.length<=340000));
  }
  const usd=result.packages.filter(p=>p.envelope.accountId==='1150040002').at(-1);
  assert.equal(usd.envelope.closingMinor,3000);
  assert.equal(result.outstandingItems.filter(i=>i.kind==='undeposited-receipt').length,7);
  if(process.env.BF2_PREVIEW_DIR) {
    fs.mkdirSync(process.env.BF2_PREVIEW_DIR,{recursive:true});
    const picks={cad:result.packages.filter(p=>p.envelope.accountId==='123').sort((a,b)=>b.envelope.rows.length-a.envelope.rows.length)[0],
      usd:result.packages.find(p=>p.envelope.accountId==='1150040002' && p.envelope.rows.length),
      card:result.packages.find(p=>p.envelope.accountId==='85' && p.envelope.rows.length),
      quiet:result.packages.find(p=>p.envelope.accountId==='1150040000' && !p.envelope.rows.length)};
    for(const [name,p] of Object.entries(picks)) fs.writeFileSync(path.join(process.env.BF2_PREVIEW_DIR,name+'.pdf'),bytesOf(p,'statement'));
    fs.writeFileSync(path.join(process.env.BF2_PREVIEW_DIR,'summary.json'),JSON.stringify(result.summary,null,2));
  }
});

test('BF2 envelopes register and revise through the existing BF4 service, with no database or network',async()=>{
  const {createBankingWorkspaceService,hash}=require('../src/modules/banking-workspace-service');
  const stored=new Map(), artifacts=new Map(), user={id:'2'.repeat(24)};
  const input=dataset(), accountId='b';
  const store={assertReady:async()=>{},transaction:async fn=>fn('memory'),fenceAccount:async()=>{},
    get:async(_s,id)=>stored.get(id) && clone(stored.get(id)),
    list:async(_s,filter)=>[...stored.values()].filter(p=>Object.entries(filter).every(([k,v])=>p[k]===v)).map(clone),
    putEvent:async()=>{},insert:async row=>stored.set(row._id,clone(row)),
    replace:async(_s,id,_v,state)=>{stored.get(id).state=clone(state);return true;}};
  const service=createBankingWorkspaceService({store,now:()=>new Date('2026-11-01T00:00:00Z'),
    resolveContext:async()=>({environment:scope.environment,connection:{connected:true,connectionId:scope.connectionId,realmId:scope.realmId}}),
    authorize:async()=>{},getAccount:async(_s,id)=>[...input.accounts,...history.accounts].find(a=>(a.id || a.Id)===id),
    readArtifact:async f=>{const bytes=artifacts.get(f.path);assert.ok(bytes);assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),f.sha256);return bytes;}});
  function retain(p) {p.artifacts.forEach(a=>artifacts.set(a.path,a.bytes));}
  const first=generateBankStatementPackages(input,{openingBalances}).packages[0]; retain(first);
  assert.equal(first.packageId,hash({scope,accountId,period:first.envelope.period,revision:1}));
  const saved=await service.register(user,first.envelope); assert.equal(saved.id,first.packageId);
  assert.equal(saved.summary.uploaded,false);assert.equal(saved.summary.reconciled,false);
  const changed=clone(input); changed.events[0].amountMinor++;changed.events[0].bookAmountMinor++;changed.events[0].revision++;
  const next=generateBankStatementPackages(changed,{openingBalances,previousPackages:[first]}).packages[0];retain(next);
  const revised=await service.register(user,next.envelope);assert.equal(revised.revision,2);assert.equal(revised.previousPackageId,saved.id);
  assert.ok(stored.get(saved.id).state.supersededBy);
  const replay=generateBankStatementPackages(buildSettlementEvents(history));
  const real=replay.packages.find(p=>p.envelope.events.some(e=>e.source.entity==='Payment' && e.source.id==='26'));retain(real);
  const savedReal=await service.register(user,real.envelope);assert.equal(savedReal.id,real.packageId);
  assert.equal(savedReal.snapshot.events.find(e=>e.source.entity==='Payment' && e.source.id==='26').amountMinor,342349);
});
