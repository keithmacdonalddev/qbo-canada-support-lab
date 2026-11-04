'use strict';
const C = require('./bank-settlement-contract');
const {validateBankStatementEvidence} = require('./bank-statement-evidence');
const {generateBankFeedCsv,eventDate,sha256,CSV_PROFILE} = require('./bank-feed-csv');
const {generateBankStatementPdf} = require('./bank-statement-pdf');
const clone = value => JSON.parse(JSON.stringify(value));
function month(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01') throw new TypeError('A valid statement month from 1900 onward is required.');
  return value;
}
function nextMonth(value) { month(value); const y=+value.slice(0,4), m=+value.slice(5); if (y===9999 && m===12) throw new TypeError('Month exceeds the supported calendar.'); return m===12?(y+1)+'-01':value.slice(0,5)+String(m+1).padStart(2,'0'); }
function endOfMonth(value) { const d=new Date(C.date(month(value)+'-01')+'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth()+1); d.setUTCDate(0); return d.toISOString().slice(0,10); }
function months(start,end) {
  month(start); month(end); if (end<start) throw new TypeError('Reversed period range.');
  const out=[]; for(let m=start;;m=nextMonth(m)) { out.push(m); if (m===end) break; if(out.length>1200) throw new TypeError('Statement range exceeds 100 years.'); } return out;
}
function freeze(value) { if (value && typeof value==='object' && !Buffer.isBuffer(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
/** Pure BF2 entry point. Returns bytes plus a BF4 v1 persistence envelope; never
 * writes files, calls QBO, opens a database or records native completion.
 * openingBalances: [{accountId,period,amountMinor,evidenceRef,basis}]. Amounts
 * use bank balances or card debt. Without evidence, zero is an explicitly
 * provisional reconstruction baseline and every dependent package is blocked.
 * balanceEvidence: buildBankStatementEvidence(history, retained).evidence; bound
 * to the exact BF1 dataset, with native book/settled/outstanding balance checks.
 * previousPackages: prior BF2 results (or {packageId,manifest,envelope}), retained
 * unchanged. Repeating identical inputs is byte-for-byte stable; changed inputs
 * create a new revision and require later-period review after native use.
 */
function generateBankStatementPackages(dataset, options={}) {
  if (dataset?.kind!==C.SETTLEMENT_CONTRACT.kind || dataset.contractVersion!==C.CONTRACT_VERSION || !/^[a-f0-9]{64}$/.test(dataset.sourceHash || '')) throw new TypeError('A versioned BF1 settlement dataset with a source fingerprint is required.');
  const scope=C.validateScope(dataset.scope), asOf=C.date(dataset.asOf), sourceSnapshotHash=C.hash(dataset);
  const balanceEvidence=options.balanceEvidence ? validateBankStatementEvidence(dataset,options.balanceEvidence) : null;
  if (balanceEvidence && options.openingBalances) throw new TypeError('Use the opening balances bound to the statement evidence.');
  const accounts=new Map(), events=new Map(), ranges=new Map(), packages=[], cashPeriods=[], openingMap=new Map();
  for(const a of dataset.accounts) {
    if (!/^[A-Za-z0-9_-]+$/.test(a.id || '') || accounts.has(a.id)) throw new TypeError('Distinct safe account ids are required.');
    accounts.set(a.id,a);
  }
  for(const e of dataset.events) {
    C.validateEvent(e); C.assertScope(e.scope,scope);
    const a=accounts.get(e.accountId);
    if (!a || (e.accountCurrency!==a.currency && e.accountCurrency!==null) || events.has(e.eventId)) throw new TypeError('Settlement dataset has a duplicate or cross-account event.');
    if(e.status==='resolved') { const d=eventDate(e); if(e.statementPeriod!==d.slice(0,7)) throw new TypeError('Settlement period and posting date disagree.'); C.date(e.bookDate); }
    events.set(e.eventId,e);
  }
  for(const o of balanceEvidence?.openingBalances || options.openingBalances || []) {
    if(!accounts.has(o.accountId) || openingMap.has(o.accountId) || !o.evidenceRef || !o.basis) throw new TypeError('Opening evidence requires a unique account, period, reference and basis.');
    month(o.period); C.integer(o.amountMinor); openingMap.set(o.accountId,clone(o));
  }
  for(const r of options.ranges || dataset.provisionalRanges || []) {
    const a=accounts.get(r.accountId); if(!a || ranges.has(a.id)) throw new TypeError('Period range has a missing or duplicate account.');
    const periods=months(r.provisionalStartMonth,r.provisionalEndMonth);
    if(r.periods!==undefined && r.periods!==periods.length) throw new TypeError('Provisional period count disagrees with its range.');
    if(r.evidenceType!==a.evidenceType) throw new TypeError('Cash and external-bank evidence must remain separate.');
    ranges.set(a.id,{...clone(r),periods});
  }
  for(const e of events.values()) if(!ranges.has(e.accountId)) throw new TypeError('Every settlement account requires a period range.');
  for(const o of openingMap.values()) if(!ranges.has(o.accountId) || o.period!==ranges.get(o.accountId).periods[0]) throw new TypeError('Opening balance must start at the first requested period.');
  const previous=options.previousPackages || [];
  for(const p of previous) {
    C.assertScope(p.envelope?.scope,scope);
    if(p.envelope.accountCurrency!==accounts.get(p.envelope.accountId)?.currency || !Number.isInteger(p.envelope.revision) || p.envelope.revision<1 || !/^[a-f0-9]{64}$/.test(p.packageId || '') || !p.manifest?.contentFingerprint) throw new TypeError('Previous revision requires its original BF2 identity, scope and fingerprint.');
  }
  const globalBlockers=(dataset.coverage?.issues || []).map(issue=>'coverage: '+C.canonical(issue));
  if(!dataset.coverage || dataset.coverage.retainedLedgerRows!==dataset.coverage.representedLedgerRows) globalBlockers.push('coverage: retained ledger rows are not fully represented');
  for(const [accountId,range] of [...ranges].sort(([a],[b])=>a.localeCompare(b))) {
    const account=accounts.get(accountId);
    if(account.evidenceType==='cash-count-or-cashbook') {
      for(const period of range.periods) {
        const opening=openingMap.get(accountId), book=balanceEvidence?.periodBookBalances.find(b=>b.accountId===accountId && b.period===period);
        cashPeriods.push({accountId,accountCurrency:account.currency,period,evidenceType:account.evidenceType,uploadRequired:false,basis:range.basis,
          openingEvidence:opening || null,bookClosingMinor:book?.bookClosingMinor ?? null,balanceEvidenceHash:balanceEvidence?.evidenceHash || null});
      }
      continue;
    }
    if(!['Bank','Credit Card'].includes(account.type) || !/^[A-Z]{3}$/.test(account.currency || '')) throw new TypeError('External statements require a proved account type and currency.');
    const own=[...events.values()].filter(e=>e.accountId===accountId && !e.supersededBy), isCard=account.type==='Credit Card';
    const opening=openingMap.get(accountId), baseBlockers=[...globalBlockers];
    if(!opening) baseBlockers.push('opening-balance-unproved: zero is a provisional reconstruction baseline, not an observed opening balance');
    if(own.some(e=>e.status==='resolved' && eventDate(e)<range.periods[0]+'-01')) baseBlockers.push('settlements-before-range: provide an opening balance that explicitly accounts for earlier retained movements');
    let balance=opening?.amountMinor ?? 0;
    for(const period of range.periods) {
      const cutoff=endOfMonth(period), start=period+'-01', blockers=[...baseBlockers];
      if(cutoff>asOf) blockers.push('posting-cutoff-not-reached: '+cutoff);
      const unresolved=own.filter(e=>e.status!=='resolved' && (!e.bookDate || e.bookDate<=cutoff));
      for(const e of unresolved) blockers.push(e.eventId+': '+C.canonical(e.resolution.reason));
      const selected=own.filter(e=>e.status==='resolved' && e.resolution.action!=='Exclude' && eventDate(e)>=start && eventDate(e)<=cutoff);
      for(const e of selected) {
        for(const b of e.resolution.nativeActionBlockers || []) blockers.push(e.eventId+': '+b);
        if(e.pairedEventId || ['Transfer','CreditCardPayment'].includes(e.source.entity)) {
          const pair=events.get(e.pairedEventId);
          if(!pair || pair.supersededBy || pair.status!=='resolved' || pair.pairedEventId!==e.eventId || pair.accountId===e.accountId || pair.settlementGroupId!==e.settlementGroupId || (pair.accountCurrency===e.accountCurrency && C.sum([pair.amountMinor,e.amountMinor])!==0) || !(Math.sign(pair.amountMinor)===-Math.sign(e.amountMinor))) blockers.push(e.eventId+': paired-settlement-unproved');
        }
      }
      const outstandingItems=own.filter(e=>e.status==='resolved' && e.resolution.action!=='Exclude' && e.bookDate<=cutoff && eventDate(e)>cutoff).map(e=>({
        kind:e.amountMinor>0?'deposit-in-transit':'outstanding-payment',eventId:e.eventId,accountId,currency:e.accountCurrency,
        amountMinor:e.amountMinor,bookDate:e.bookDate,expectedPostingDate:eventDate(e),pairedEventId:e.pairedEventId}));
      // Undeposited receipts are not assigned to an external bank by BF1. They
      // remain in the run-level schedule, never cloned into every bank statement.
      const openingMinor=balance, closingMinor=C.sum([openingMinor,...selected.map(e=>isCard?-e.amountMinor:e.amountMinor)]);
      const book=balanceEvidence?.periodBookBalances.find(b=>b.accountId===accountId && b.period===period);
      const reconstructedBookClosingMinor=C.sum([closingMinor,...outstandingItems.map(e=>isCard?-e.amountMinor:e.amountMinor)]);
      if (balanceEvidence && (!book || book.bookClosingMinor!==reconstructedBookClosingMinor)) blockers.push('book-statement-balance-mismatch: retained book balance does not equal settled balance plus outstanding items');
      const balanceCheck=balanceEvidence ? {bookClosingMinor:book?.bookClosingMinor ?? null,reconstructedBookClosingMinor,
        differenceMinor:book ? C.sum([book.bookClosingMinor,-reconstructedBookClosingMinor]) : null,evidenceHash:balanceEvidence.evidenceHash} : null;
      const uniqueBlockers=[...new Set(blockers)].sort(), balanceConvention=isCard?'card-amount-owed':'bank-balance';
      const openingBasis=opening?.basis || 'Provisional zero before earliest retained activity; unverified';
      const core={scope,accountId,accountCurrency:account.currency,period,sourceSnapshotHash,policyVersion:dataset.policy.version,
        openingMinor,closingMinor,balanceConvention,events:clone(selected),outstandingItems:clone(outstandingItems),blockers:uniqueBlockers};
      const metadata={accountName:account.name || accountId,openingBasis,openingEvidence:opening || null,
        ...(balanceEvidence ? {balanceCheck} : {}),
        csvProfile:{...CSV_PROFILE,maxRows:options.maxRows ?? CSV_PROFILE.maxRows,maxBytes:options.maxBytes ?? CSV_PROFILE.maxBytes},
        dueDate:options.cardDueDates?.[accountId]?.[period] || null,rangeBasis:range.basis || 'provisional',
        unresolvedEvents:clone(unresolved),excludedEvents:clone(own.filter(e=>e.resolution.action==='Exclude' && e.statementPeriod===period))};
      const contentFingerprint=C.hash({core,metadata});
      const family=previous.filter(p=>p.envelope.accountId===accountId && p.envelope.period===period).sort((a,b)=>b.envelope.revision-a.envelope.revision);
      if(family.length>1 && family[0].envelope.revision===family[1].envelope.revision) throw new TypeError('Ambiguous previous package revision.');
      const prior=family[0], unchanged=prior?.manifest.contentFingerprint===contentFingerprint;
      const revision=prior?(unchanged?prior.envelope.revision:prior.envelope.revision+1):1;
      const previousPackageId=unchanged?prior.envelope.previousPackageId || null:prior?.packageId || null;
      // BF4 stores revisions under this identity; content belongs in immutable artifact paths.
      const packageId=C.hash({scope,accountId,period,revision});
      if(unchanged && packageId!==prior.packageId) throw new TypeError('Previous package identity is inconsistent.');
      const directory=C.hash(scope)+'/'+accountId+'/'+period+'/r'+revision+'-'+contentFingerprint.slice(0,24);
      const csv=generateBankFeedCsv(selected,{scope,accountId,accountCurrency:account.currency,maxRows:options.maxRows,maxBytes:options.maxBytes});
      const artifacts=[], rows=[];
      function artifact(kind,name,bytes,rowCount) {
        const fileId=C.hash({packageId,kind,name}), file={fileId,kind,path:directory+'/'+name,sha256:sha256(bytes),rowCount};
        artifacts.push({...file,bytes}); return file;
      }
      for(const file of csv.files) {
        const meta=artifact('csv',file.fileName,file.bytes,file.rowCount);
        for(const row of file.rows) rows.push({rowId:C.hash({packageId,eventId:row.eventId,revision:row.eventRevision}),eventId:row.eventId,eventRevision:row.eventRevision,fileId:meta.fileId,rowNumber:row.rowNumber});
      }
      const pdf=generateBankStatementPdf({...core,...metadata});
      artifact('statement','statement.pdf',pdf.bytes,selected.length);
      const manifest={version:1,kind:'simulated-bank-statement-package',packageId,revision,previousPackageId,contentFingerprint,
        ...core,...metadata,csvProfile:csv.profile,rows,files:artifacts.map(({bytes,...file})=>file),statementTotals:{
          openingMinor,closingMinor,positiveMinor:pdf.model.positiveMinor,negativeMinor:pdf.model.negativeMinor,rowCount:selected.length,pageCount:pdf.pageCount},
        uploadRequired:selected.length>0,readyForNativeWork:uniqueBlockers.length===0,
        evidenceLabel:'generated simulated evidence',nativeStateVerified:false,
        revisionPolicy:'Never overwrite retained or uploaded artifacts. A revision requires native delta review and review of every later period in this account.',
        laterPeriodsRequiringReview:previousPackageId?range.periods.filter(p=>p>period):[],
        crosswalk:csv.files.flatMap(f=>f.rows.map(row=>({...row,...rows.find(r=>r.eventId===row.eventId),
          qboRefs:events.get(row.eventId).resolution.linkedQboIds,source:events.get(row.eventId).source,
          settlementGroupId:events.get(row.eventId).settlementGroupId,pairedEventId:events.get(row.eventId).pairedEventId}))),
        manifestHashRule:'The manifest file hash is external in envelope.files; the manifest lists CSV/PDF hashes only to avoid a self-referential hash.'};
      const manifestBytes=Buffer.from(C.canonical(manifest)+'\n','utf8');
      artifact('manifest','manifest.json',manifestBytes,selected.length);
      const envelope={...core,revision,previousPackageId,rows,files:artifacts.map(({bytes,...file})=>file)};
      packages.push({packageId,manifest:freeze(manifest),envelope:freeze(envelope),artifacts,statement:freeze(pdf.model)});
      balance=closingMinor;
    }
  }
  return {version:1,scope,sourceSnapshotHash,packages,cashPeriods,
    outstandingItems:clone(dataset.outstandingItems || []),
    beyondRangeEvents:[...events.values()].filter(e=>e.status==='resolved' && eventDate(e).slice(0,7)>ranges.get(e.accountId).periods.at(-1)).map(e=>({eventId:e.eventId,accountId:e.accountId,postingDate:eventDate(e),amountMinor:e.amountMinor})),
    summary:{externalPeriods:packages.length,cashPeriods:cashPeriods.length,readyPeriods:packages.filter(p=>p.manifest.readyForNativeWork).length,
      blockedPeriods:packages.filter(p=>!p.manifest.readyForNativeWork).length,quietPeriods:packages.filter(p=>!p.envelope.rows.length).length,
      csvFiles:packages.reduce((n,p)=>n+p.envelope.files.filter(f=>f.kind==='csv').length,0),nativeStateVerified:false}};
}
function generateIndependentBankStatementPackage(p) {
  if (p?.kind !== 'independent-monthly-statement-plan' || p.rendererVersion !== 2 || !/^[a-f0-9]{64}$/.test(p.statementId || '')) throw new TypeError('Frozen independent monthly plan required.');
  const scope = C.validateScope(p.scope),
    period = month(p.period),
    card = p.balanceConvention === 'card-amount-owed';
  if (!['bank-balance', 'card-amount-owed'].includes(p.balanceConvention) || !Array.isArray(p.rows) || p.rows.length > 10000 || !/^[A-Z]{3}$/.test(p.currency)) throw new TypeError('Native monthly statement identity required.');
  let balance = C.integer(p.openingMinor);
  const ids = new Set();
  const rows = p.rows.map(r => {
    C.assertScope(r.scope, scope);
    if (ids.has(r.eventId) || r.accountId !== p.accountId || r.accountCurrency !== p.currency || r.postingDate.slice(0, 7) !== period || !Number.isSafeInteger(r.amountMinor) || !/^[a-f0-9]{64}$/.test(r.financialHash || '')) throw new TypeError('Monthly row changed its bound identity.');
    const financial = Object.fromEntries(['scope', 'eventId', 'eventRevision', 'accountId', 'accountCurrency', 'amountMinor', 'postingDate', 'postingProofHash', 'pairProofHash'].filter(k => r[k] !== undefined).map(k => [k, r[k]]));
    if (C.hash(financial) !== r.financialHash || r.amountMinor === 0) throw new TypeError('Frozen monthly row money hash changed.');
    C.date(r.postingDate);
    ids.add(r.eventId);
    balance = C.sum([balance, card ? -r.amountMinor : r.amountMinor]);
    return {
      eventId: r.eventId,
      date: r.postingDate,
      description: r.description,
      sourceEntity: r.source.entity,
      sourceId: r.source.id,
      amountMinor: r.amountMinor,
      balanceMinor: balance
    };
  });
  if (C.hash(p.rows.map(r => ({
    id: r.eventId,
    hash: r.financialHash
  }))) !== p.financialHash || !Array.isArray(p.pending) || p.pending.length > 10000 || p.pending.some(x => x.expectedPostingDate <= endOfMonth(period) || ids.has(x.eventId))) throw new TypeError('Frozen monthly membership or pending schedule changed.');
  if (balance !== p.closingMinor) throw new TypeError('Monthly closing does not equal exact movements.');
  const model = {
    kind: 'independent-monthly-statement-model',
    rendererVersion: 2,
    label: 'Maple Harbour Bank - simulated monthly statement',
    scope,
    accountId: p.accountId,
    accountName: p.accountName,
    currency: p.currency,
    accountCurrency: p.currency,
    period,
    balanceConvention: p.balanceConvention,
    openingMinor: p.openingMinor,
    closingMinor: balance,
    positiveMinor: C.sum(rows.filter(r => r.amountMinor > 0).map(r => r.amountMinor)),
    negativeMinor: C.sum(rows.filter(r => r.amountMinor < 0).map(r => -r.amountMinor)),
    rows,
    blockers: [],
    openingBasis: p.openingBasis,
    outstandingItems: p.pending,
    dueDate: null,
    evidenceLabel: 'Independent simulated bank activity; historical opening evidence remains identified.',
    nativeStatus: 'Publishing does not prove QuickBooks import, matching or reconciliation.'
  };
  const pdf = require('./bank-statement-pdf').generateIndependentBankStatementPdf(model),
    directory = C.hash(scope) + '/' + p.accountId + '/monthly-statements/' + p.statementId,
    artifacts = [],
    add = (kind, name, bytes, rowCount) => {
      const file = {
        fileId: C.hash({
          statementId: p.statementId,
          kind,
          name
        }),
        kind,
        path: directory + '/' + name,
        sha256: sha256(bytes),
        byteCount: bytes.length,
        rowCount
      };
      artifacts.push({
        ...file,
        bytes
      });
      return file;
    };
  if (p.rows.length) {
    const csv = require('./bank-feed-csv').generatePostedBankFeedCsv(p.rows, {
      scope,
      accountId: p.accountId,
      accountCurrency: p.currency
    });
    for (const part of csv.files) add('csv', part.fileName, part.bytes, part.rowCount);
  }
  add('statement', 'statement.pdf', pdf.bytes, rows.length);
  const manifest = {
    version: 1,
    kind: 'independent-monthly-bank-statement',
    statementId: p.statementId,
    scope,
    ownerId: p.ownerId,
    originalActorId: p.originalActorId,
    accountId: p.accountId,
    accountCurrency: p.currency,
    period,
    revision: 1,
    rendererVersion: 2,
    openingMinor: p.openingMinor,
    closingMinor: p.closingMinor,
    openingBasis: p.openingBasis,
    predecessor: p.predecessor,
    coverageHash: p.coverageHash,
    baselineHash: p.baselineHash,
    financialHash: p.financialHash,
    rows: p.rows,
    pending: p.pending,
    overlap: p.overlap,
    referenceOnly: true,
    warning: 'Full-month reference CSV may overlap incremental imports. Do not import it as the next incremental file.',
    nativeStateVerified: false,
    files: artifacts.map(({
      bytes,
      ...f
    }) => f),
    statementTotals: {
      openingMinor: p.openingMinor,
      closingMinor: p.closingMinor,
      rowCount: rows.length,
      pageCount: pdf.pageCount
    }
  };
  add('manifest', 'manifest.json', Buffer.from(C.canonical(manifest) + '\n'), rows.length);
  return {
    artifacts,
    model,
    manifest
  };
}
module.exports={generateBankStatementPackages,generateIndependentBankStatementPackage,months,endOfMonth};
