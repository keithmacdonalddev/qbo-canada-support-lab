'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const modules=process.env.OB_MODULE_ROOT || path.join(__dirname,'../src/modules');
const C=require(path.join(modules,'bank-settlement-contract'));
const {buildBankStatementEvidence}=require(path.join(modules,'bank-statement-evidence'));
const {generateBankStatementPackages}=require(path.join(modules,'bank-statement-package'));
const history=require('./fixtures/bank-settlement-history.json');
const retained=require('./fixtures/bank-opening-history-evidence.json');
const clone=v=>JSON.parse(JSON.stringify(v));
const rehash=v=>{delete v.evidenceHash;v.evidenceHash=C.hash(v);return v;};
const built=buildBankStatementEvidence(history,retained);

test('stored history replay: all 16 native openings proved, all 324 periods tie, 317 ready, seven explicit native blockers',()=>{
  const before=C.hash({history,retained}), result=generateBankStatementPackages(built.dataset,{balanceEvidence:built.evidence});
  assert.equal(C.hash({history,retained}),before);
  assert.equal(built.dataset.ledgerCrosswalk.length,3789);
  assert.equal(built.dataset.depositLinks.length,1385);
  assert.equal(built.dataset.unresolvedEvents.length,0);
  assert.equal(built.evidence.openingBalances.length,16);
  for(const opening of built.evidence.openingBalances) {
    assert.equal(opening.amountMinor,0);
    assert.equal(opening.crossCheck.derivedOpeningMinor+opening.crossCheck.retainedMovementMinor,opening.crossCheck.anchorMinor);
    assert.equal(opening.source.sourceSha256,'80d14fb4b16ca4107e73abcce40a675227dbfeb8ebc032429613864bf6daecc5');
    assert.match(opening.evidenceHash,/^[a-f0-9]{64}$/);
  }
  assert.equal(result.summary.externalPeriods,324);assert.equal(result.summary.cashPeriods,116);
  assert.equal(result.summary.readyPeriods,317);assert.equal(result.summary.blockedPeriods,7);
  assert.equal(result.summary.nativeStateVerified,false);
  for(const p of result.packages) {
    assert.equal(p.manifest.balanceCheck.differenceMinor,0);
    assert.equal(p.statement.closingMinor,p.envelope.closingMinor);
    const book=C.sum([p.envelope.closingMinor,...p.envelope.outstandingItems.map(e=>p.envelope.balanceConvention==='card-amount-owed'?-e.amountMinor:e.amountMinor)]);
    assert.equal(book,p.manifest.balanceCheck.bookClosingMinor);
  }
  assert.deepEqual(result.packages.filter(p=>!p.manifest.readyForNativeWork).map(p=>[p.envelope.accountId,p.envelope.period]),[
    ['60','2020-07'],['60','2020-08'],['60','2020-10'],['60','2021-01'],['66','2023-08'],['66','2024-02'],['85','2022-04']]);
  assert.ok(result.cashPeriods.every(p=>p.openingEvidence && p.bookClosingMinor!==null && !p.uploadRequired));
});

test('five actual adjustments get exactly one simulated line each, preserving unknown counterparts and native inspection',()=>{
  const result=generateBankStatementPackages(built.dataset,{balanceEvidence:built.evidence});
  const lines=result.packages.flatMap(p=>p.envelope.events).filter(e=>e.source.entity==='TaxAdjustment');
  assert.deepEqual(lines.map(e=>[e.source.id,e.amountMinor]).sort(),[['91',50000],['93',50000],['94',200000],['97',10000],['98',-5000]]);
  assert.equal(C.sum(lines.map(e=>e.amountMinor)),305000);
  for(const e of lines) {
    assert.equal(e.source.adjustmentEvidence.decision,'simulated-bank-line');
    assert.equal(e.source.adjustmentEvidence.counterpartAccountIds,null);
    assert.ok(e.resolution.nativeActionBlockers.includes('report-only-adjustment-requires-native-inspection'));
    assert.equal(e.resolution.nativeMatchVerified,false);
    assert.deepEqual(e.resolution.linkedQboIds,[{entity:'TaxAdjustment',id:e.source.id}]);
  }
  // September/December book entries post in October/January under BF1's
  // existing electronic lag. Outstanding items explain the book difference.
  const sep=result.packages.find(p=>p.envelope.accountId==='60'&&p.envelope.period==='2020-09');
  assert.equal(sep.envelope.outstandingItems.filter(e=>lines.some(l=>l.eventId===e.eventId)).length,3);
  assert.equal(sep.manifest.balanceCheck.differenceMinor,0);
});

test('USD uses native USD, cards use debt, quiet pre-activity months carry the first known balance',()=>{
  const result=generateBankStatementPackages(built.dataset,{balanceEvidence:built.evidence});
  const usd=result.packages.filter(p=>p.envelope.accountId==='1150040002');
  assert.equal(usd.at(-1).envelope.closingMinor,3000);
  assert.ok(usd.every(p=>p.envelope.accountCurrency==='USD'));
  const card=result.packages.filter(p=>p.envelope.accountId==='1150040005');
  assert.equal(card.at(-1).envelope.closingMinor,12400);
  const savings=result.packages.filter(p=>p.envelope.accountId==='1150040007');
  assert.deepEqual(savings.slice(0,4).map(p=>[p.envelope.openingMinor,p.envelope.closingMinor,p.manifest.uploadRequired]),Array(4).fill([0,0,false]));
  assert.equal(savings.at(-1).envelope.closingMinor,100000);
  // Mirror 123 was observed later while the accountant continued writing.
  // Its newer balance never replaces the frozen retained cutoff balance.
  const operating=built.evidence.openingBalances.find(o=>o.accountId==='123');
  assert.equal(operating.crossCheck.mirrorBalanceAgrees,false);
  assert.equal(operating.crossCheck.anchorMinor,129956373);
  assert.equal(operating.amountMinor,0);
});

test('anchor reversal supports a nonzero opening without manufacturing a settlement',()=>{
  const input=clone(retained), anchor=input.accounts.find(a=>a.accountId==='1150040007');
  anchor.storedNativeBookBalanceMinor+=12500;rehash(anchor);
  const b=buildBankStatementEvidence(history,input), opening=b.evidence.openingBalances.find(o=>o.accountId==='1150040007');
  assert.equal(opening.amountMinor,12500);
  const result=generateBankStatementPackages(b.dataset,{balanceEvidence:b.evidence});
  const savings=result.packages.filter(p=>p.envelope.accountId==='1150040007');
  assert.equal(savings[0].envelope.closingMinor,12500);
  assert.equal(savings[0].envelope.events.length,0);
  assert.equal(savings.at(-1).envelope.closingMinor,112500);
  assert.ok(savings.every(p=>p.manifest.balanceCheck.differenceMinor===0));
});

test('changed ledger, hash, currency, cutoff, adjustment amount and missing anchors fail closed',()=>{
  for(const change of [x=>x.ledgerRowsHash='0'.repeat(64),x=>x.accounts[0].storedNativeBookBalanceMinor++,
    x=>{x.accounts[0].currency='USD';rehash(x.accounts[0]);},x=>x.asOf='2026-09-30',
    x=>{x.adjustments[0].amountMinor++;rehash(x.adjustments[0]);},x=>x.accounts.pop(),
    x=>{x.adjustments[0].nativeInspectionRequired=false;rehash(x.adjustments[0]);}]) {
    const bad=clone(retained);change(bad);assert.throws(()=>buildBankStatementEvidence(history,bad));
  }
  const badHistory=clone(history);badHistory.ledger.rows[0].bankAccountAmountCents++;
  assert.throws(()=>buildBankStatementEvidence(badHistory,retained));
});

test('evidence cannot move across scopes or snapshots, or be overridden by unbound openings',()=>{
  const bad=clone(built.evidence);bad.scope.realmId='other';rehash(bad);
  assert.throws(()=>generateBankStatementPackages(built.dataset,{balanceEvidence:bad}),/scope/);
  const changed=clone(built.dataset);changed.events[0].amountMinor++;
  assert.throws(()=>generateBankStatementPackages(changed,{balanceEvidence:built.evidence}),/snapshot/);
  assert.throws(()=>generateBankStatementPackages(built.dataset,{balanceEvidence:built.evidence,openingBalances:[]}),/bound/);
});

test('missing/incorrect monthly balance evidence blocks readiness; unclassified adjustment is never cleared implicitly',()=>{
  const bad=clone(built.evidence);bad.periodBookBalances.find(b=>b.accountId==='1150040007').bookClosingMinor++;rehash(bad);
  const mismatch=generateBankStatementPackages(built.dataset,{balanceEvidence:bad}).packages.find(p=>p.envelope.accountId==='1150040007');
  assert.equal(mismatch.manifest.readyForNativeWork,false);
  assert.equal(mismatch.manifest.balanceCheck.differenceMinor,1);
  assert.ok(mismatch.envelope.blockers.some(b=>b.startsWith('book-statement-balance-mismatch')));
  const partial=clone(retained);partial.adjustments=partial.adjustments.filter(a=>a.id!=='91');
  const b=buildBankStatementEvidence(history,partial);
  assert.equal(b.dataset.unresolvedEvents.length,1);assert.equal(b.dataset.unresolvedEvents[0].source.id,'91');
  const result=generateBankStatementPackages(b.dataset,{balanceEvidence:b.evidence});
  assert.ok(result.packages.filter(p=>p.envelope.accountId==='60'&&p.envelope.period>='2020-09').every(p=>!p.manifest.readyForNativeWork));
});
