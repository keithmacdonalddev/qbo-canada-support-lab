'use strict';
// General closes bind every run, current record and posting reference version. Historical
// edits are held by durable markers until downstream periods and opening evidence re-prove.
const { hash } = require('./business-calendar');
const { businessErrorDetail } = require('./business-error-detail');
const persistedHash = value => hash(JSON.parse(JSON.stringify(value)));
const { closeGeneralDay, ledgerEndpoint, generalRecordsFor, settlementEvidence, settlementLinks, SETTLEMENT_ENTITIES } = require('./general-write-day-close');
function fail(message, businessDetail = {}) { throw Object.assign(new Error(message), { status: 409, code: 'GENERAL_DAY_CLOSE_UNVERIFIED', businessDetail }); }
const TAX_SUBTYPES = ['GlobalTaxPayable', 'GlobalTaxSuspense', 'SalesTaxPayable', 'OtherCurrentLiabilities'];
function closeWindow(gathered) {
  const { accountingView } = require('./general-write-postings');
  return { ...gathered, records: gathered.records.map(row => ({ ...row, current: require('./general-write-close').accountingRecord(row.entity, row.current) })), ownSettlements: (gathered.ownSettlements || []).map(row => (row.record ? { ...row, record: accountingView(row.record) } : row)), settlementVersions: (gathered.settlementVersions || []).map(row => ({ ...row, current: accountingView(row.current) })) };
}
function postingContext(evidence) {
  const { accountingView } = require('./general-write-postings');
  return { ...evidence, items: evidence.items.map(([id, record]) => [id, accountingView(record)]), sources: evidence.sources.map(([id, record]) => [id, accountingView(record)]), taxAccounts: evidence.taxAccounts.map(row => ({ qboId: row.qboId, record: accountingView(row.record) })) };
}
function settlementWindow(rows) { return rows.map(row => ({ ...row, record: require('./general-write-postings').accountingView(row.record) })); }
function createGeneralCloseGate({ models = {}, copy, readValuation = null, now = () => Date.now() }) {
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun'), Closes = models.GeneralDayCloses || require('../models/GeneralDayClose'), Records = models.Records || require('../models/CompanySyncRecord');
  const company = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId });
  async function pending(scope, { fromDate, throughDate, verifiedThrough }) {
    const gathered = await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy, models, now });
    // Include current dates: an external move into this period must not escape close.
    const unresolved = gathered.dirty.filter(row => verifiedThrough && row.earliestDate <= verifiedThrough).map(row => ({ key: String(row.runId) + ':' + row.earliestDate, earliestDate: row.earliestDate }));
    return { hasRecords: gathered.records.length > 0, unresolved, gathered };
  }

  async function contextFor(scope, mappings, records) {
    const items = new Map(), wanted = new Set();
    for (const row of records) for (const record of [row.current, row.before]) for (const line of record?.Line || []) { const id = line?.[line?.DetailType]?.ItemRef?.value; if (id != null) wanted.add(String(id)); }
    for (const id of wanted) { const record = await copy.read(scope, 'Item', id); if (record) items.set(id, record); }
    const accounts = await Records.find({ ...company(scope), entity: 'Account', deleted: false }).select('qboId record').limit(501).maxTimeMS(3000).lean();
    if (accounts.length > 500) fail('Posting-account enumeration exceeds its proof budget; close is incomplete.');
    const tax = accounts.filter(row => TAX_SUBTYPES.includes(row.record?.AccountSubType) && (row.record.AccountSubType !== 'OtherCurrentLiabilities' || /\b(GST|HST|PST|QST|tax)\b/i.test(row.record?.Name || ''))).map(row => String(row.qboId));
    const sources = new Map();
    for (const row of records) for (const record of [row.current, row.before]) for (const line of record?.Line || []) for (const link of line.LinkedTxn || []) {
      if (!record?.CurrencyRef?.value || record.CurrencyRef.value === 'CAD' || !['Invoice', 'Bill', 'CreditMemo', 'VendorCredit', 'Payment', 'SalesReceipt'].includes(link.TxnType)) continue;
      const key = link.TxnType + ':' + link.TxnId;
      if (!sources.has(key)) { const source = await copy.read(scope, link.TxnType, String(link.TxnId)); if (!source) fail('Foreign posting source ' + key + ' is unavailable.'); sources.set(key, source); }
    }
    const currencyAccount = (type, currency) => { const matches = accounts.filter(row => row.record?.Active !== false && row.record.AccountType === type && (row.record.CurrencyRef?.value || 'CAD') === currency); if (matches.length !== 1) fail('The ' + currency + ' ' + type + ' account cannot be attributed uniquely.'); return String(matches[0].qboId); };
    const gains = accounts.filter(row => row.record?.Active !== false && row.record.AccountSubType === 'ExchangeGainOrLoss' && (row.record.CurrencyRef?.value || 'CAD') === 'CAD');
    const features = require('../config').features || {}, inventory = { enabled: features.generalWriteInventory === true, entities: features.generalWriteInventoryEntities || {} };
    let stock = null;
    if ([...items.values()].some(item => item.Type === 'Inventory')) {
      // Admission switches cannot erase or prevent verification of saved stock.
      inventory.enabled=true; inventory.entities=Object.fromEntries(['Invoice','SalesReceipt','Bill','Purchase','CreditMemo','RefundReceipt','VendorCredit'].map(e=>[e,true]));
      const stockModels = { ...require('./business-runtime').loadModels(), ...models, Records, Agents: models.Agents || require('../models/BusinessAgent'), Authorities: require('../models/BusinessAuthority'), Versions: require('../models/BlueprintVersion'), Baselines: require('../models/BusinessBaseline') };
      const active = await require('./business-authority').readPublishedBusiness({ ...stockModels, scope });
      const days = [...new Set(records.flatMap(row => [row.current?.TxnDate, row.before?.TxnDate]).filter(Boolean))];
      if (days.length !== 1) fail('Inventory close needs one complete open-day replay.');
      stock = await require('./business-stock-general').readGeneralStockContext({ models: stockModels, scope, active, day: days[0], readValuation, verifyValuation:true, observations: require('./business-observation-store').createBusinessObservationStore({ ...stockModels, now }) });
    }
    const evidence = { ...(stock ? { stockBasisHash: stock.basisHash, valuationChecks:stock.valuationChecks } : {}), mappings, sources: [...sources], items: [...items], taxAccountIds: [...tax].sort(), taxAccounts: accounts.map(row => ({ qboId: row.qboId, record: row.record })) };
    return { evidence, inventory, ...(stock ? { stockEvidence:{returns:stock.returnEvidence,checks:stock.valuationChecks,reportJson:require('./report-json').canonicalReport(stock.valuationReport)} } : {}), ...(stock ? { stockCost: (entity, record, lineIndex) => require('./business-stock-general').stockPostingCost(stock, entity, record, lineIndex) } : {}), homeCurrency: 'CAD', currencyAccount, exchangeGainLoss: gains.length === 1 ? String(gains[0].qboId) : null, get: (entity, id) => entity === 'Item' ? items.get(String(id)) || null : sources.get(entity + ':' + id) || null,
      receivables: mappings.accountsReceivable ? String(mappings.accountsReceivable) : null, payables: mappings.accountsPayable ? String(mappings.accountsPayable) : null, undepositedFunds: mappings.undepositedFunds ? String(mappings.undepositedFunds) : null,
      // Retain real account identities. Multiple agency accounts require an explicit
      // rate-to-account proof; guessing or collapsing them could hide a substitution.
      taxAccount: () => { if (tax.length !== 1) fail('The tax posting account cannot be attributed uniquely; retain a rate-to-account proof before close.'); return tax[0]; }, accountKey: id => String(id) };
  }
  async function retainStockReturns(scope,{day,mappings}) {
    const runs=await require('./general-write-day-close').readGeneralRuns(Runs,scope,{day});
    const records=[];
    for(const run of runs) for(const item of Object.values(run.items||{})) {
      if(!['CreditMemo','RefundReceipt','VendorCredit'].includes(item.entity)||item.op!=='create'||item.outcome!=='saved'||item.record?.TxnDate!==day)continue;
      let stock=false;
      for(const line of item.record.Line||[]) {const id=line[line.DetailType]?.ItemRef?.value;if(id && (await copy.read(scope,'Item',id))?.Type==='Inventory')stock=true;}
      if(!stock)continue;
      const current=await copy.read(scope,item.entity,item.qboId);
      if(!current || require('./business-stock-valuation').returnRecordHash(current)!==require('./business-stock-valuation').returnRecordHash(item.record)) fail('Saved stock return changed before its native cost proof.');
      records.push({entity:item.entity,id:item.qboId,current,before:null});
    }
    if(!records.length)return {required:false};
    if(records.length>100)fail('Stock return proof exceeds its complete-day return budget.');
    const ctx=await contextFor(scope,mappings,records);
    if(!ctx.stockEvidence?.returns)fail('Native stock return proof is unavailable.');
    const row={_id:hash({scope:company(scope),day,stock:ctx.stockEvidence,at:now()}).slice(0,24),contract:'general-write-v1',...company(scope),fromDate:day,throughDate:day,kind:'inventory',ok:true,ledgerHash:hash(null),recordCount:records.length,records:records.map(r=>({key:r.entity+':'+r.id})),stock:ctx.stockEvidence,verifiedAt:new Date(now())};
    await Closes.create([row]);
    return {required:true,recordCount:records.length};
  }
  async function fixedSettlementsFor(scope, gathered) {
    const trusted = new Map(settlementEvidence(gathered).map(row => [row.key, row])), wanted = new Map(), found = new Map();
    const add = (record, target) => { for (const key of settlementLinks(record)) {
      if (trusted.has(key) || !SETTLEMENT_ENTITIES.has(key.split(':')[0])) continue;
      if (!wanted.has(key)) wanted.set(key, new Set()); wanted.get(key).add(target);
    } };
    for (const row of gathered.records) add(row.current, row.entity + ':' + row.id);
    if (!wanted.size) return [];
    const Steps = models.Steps || require('../models/OperationStep');
    for (;;) {
      const keys = [...wanted.keys()].filter(key => !found.has(key)).sort();
      if (!keys.length) break;
      if (wanted.size > 1000) fail('Settlement graph exceeds its close proof budget.');
      const page = keys.slice(0, 100);
      const rows = await Steps.find({ ...company(scope), state: 'verified', $or: page.map(key => { const [entity, qboId] = key.split(':'); return { entity, qboId }; }) }).select('entity qboId state receipt dispatch compilation verification revision').sort({ _id: 1 }).limit(page.length + 1).maxTimeMS(3000).lean();
      if (rows.length > page.length || new Set(rows.map(row => row.entity + ':' + row.qboId)).size !== rows.length) fail('Settlement ownership evidence is duplicated; close is incomplete.');
      for (const key of page) found.set(key, null);
      for (const row of rows) {
        const key = row.entity + ':' + row.qboId, proof = row.verification;
        if (!page.includes(key) || row.state !== 'verified' || row.receipt?.qboId !== row.qboId || proof?.kind !== 'business-readback' || !proof.observedHash || !row.dispatch?.compilationHash || proof.compilationHash !== row.dispatch.compilationHash || !proof.relationships?.some(link => wanted.get(key).has(link.entity + ':' + link.qboId))) continue;
        const current = await copy.read(scope, row.entity, row.qboId);
        if (!current || !require('./general-write-postings').settlementConsistent(row.entity, current) || current.Id !== row.qboId || current.status === 'Voided' || current.PrivateNote?.startsWith?.('Voided')) continue;
        found.set(key, { row, proof, current }); add(current, key);
      }
    }
    const { accountingView } = require('./general-write-postings');
    const { matchesQboRequest } = require('./qbo-semantic-compare');
    const evidence = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, value] of found) {
        if (!value || trusted.has(key)) continue;
        const { row, proof, current } = value;
        let matches = hash(current) === proof.observedHash;
        if (!matches && row.compilation) {
          try {
            const compiled = require('./business-readback').validateCompilation(row.compilation);
            if (compiled.scope.environment !== scope.environment || compiled.scope.realmId !== scope.realmId || String(compiled.scope.connectionId) !== String(scope.connectionId) || row.compilation.compilationHash !== row.dispatch.compilationHash || compiled.requestHash !== row.dispatch.requestHash || row.receipt.requestHash !== compiled.requestHash || row.receipt.dispatchKey !== row.dispatch.key || !proof.syncToken || !/^(0|[1-9]\d{0,63})$/.test(current.SyncToken || '') || BigInt(current.SyncToken) < BigInt(proof.syncToken)) continue;
            const request = JSON.parse(compiled.body), view = { ...current };
            if (row.entity === 'Payment' && (current.LinkedTxn || []).some(link => link.TxnType === 'Deposit')) {
              const deposits = (current.LinkedTxn || []).filter(link => link.TxnType === 'Deposit');
              if (deposits.length !== 1) continue;
              const deposit = trusted.get('Deposit:' + deposits[0].TxnId)?.record;
              if (!deposit || (!require('./qbo-semantic-compare').sameQboValue(request.DepositToAccountRef || null, current.DepositToAccountRef || null) && deposit.DepositToAccountRef?.value !== current.DepositToAccountRef?.value) || require('./general-write-close').allocation(deposit, row.entity, row.qboId) !== Math.round(current.TotalAmt * 100)) continue;
              view.DepositToAccountRef = request.DepositToAccountRef;
            }
            matches = matchesQboRequest(accountingView(request), accountingView(view), { entity: row.entity });
          } catch { continue; }
        }
        if (!matches) continue;
        const targets = settlementLinks(current).filter(target => wanted.get(key).has(target) && proof.relationships.some(link => link.entity + ':' + link.qboId === target)).sort();
        if (!targets.length) continue;
        const entry = { key, targets, revision: row.revision, verification: proof, record: current };
        trusted.set(key, entry); evidence.push(entry); changed = true;
      }
    }
    return evidence.sort((a, b) => a.key.localeCompare(b.key));
  }
  async function verifyRange(scope, { fromDate, throughDate, readLedger, mappings, verifiedThrough, openingDate, gathered, force = false, retry = 0 }) {
    const preview = gathered || await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy, models, now }), ctx = await contextFor(scope, mappings, preview.records);
    const settlements = await fixedSettlementsFor(scope, preview);
    const snapshotHash = hash({ fromDate, throughDate, ...preview, settlements, context: ctx.evidence });
    const prior = await Closes.findOne({ ...company(scope), fromDate, throughDate, kind: 'period', ok: true, snapshotHash }).sort({ verifiedAt: -1 }).maxTimeMS(3000).lean();
    if (!force && prior?.snapshotHash === snapshotHash) {
      // Reuse its exact accounting proof without another report, but record this
      // successful attempt so a later transient failure does not stay current.
      const reused = { ...prior, _id: hash({ prior: prior._id, at: now(), snapshotHash }).slice(0, 24), verifiedAt: new Date(now()) };
      delete reused.createdAt; delete reused.updatedAt; delete reused.__v;
      await Closes.create([reused]);
      return reused;
    }
    const report = await readLedger(fromDate, throughDate);
    const after = await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy, models, now });
    const afterContext = await contextFor(scope, mappings, after.records), afterSettlements = await fixedSettlementsFor(scope, after);
    if (hash(closeWindow(preview)) !== hash(closeWindow(after)) || hash(postingContext(ctx.evidence)) !== hash(postingContext(afterContext.evidence)) || hash(settlementWindow(settlements)) !== hash(settlementWindow(afterSettlements))) {
      // Refresh current accounting evidence once. Durable run/receipt/dirty fences
      // and changed ownership revisions are never retried as harmless copy drift.
      if (!retry && hash(settlementWindow(preview.settlementVersions || [])) === hash(settlementWindow(after.settlementVersions || [])) && hash(preview.runVersions) === hash(after.runVersions) && hash(settlements.map(row => [row.key,row.revision,row.verification])) === hash(afterSettlements.map(row => [row.key,row.revision,row.verification]))) return verifyRange(scope, { fromDate, throughDate, readLedger, mappings, verifiedThrough, openingDate, gathered: after, force: true, retry: 1 });
      fail('General-write records or posting references changed while the ledger was read; close needs fresh evidence.');
    }
    const closed = await closeGeneralDay({ Runs, scope, day: fromDate, through: throughDate, copy, ledgerReport: report, ctx, verifiedThrough, openingDate, gathered: preview, ownSettlements: settlements });
    if (!closed.ok) {
      const first = closed.failures[0] || {};
      const error = Object.assign(new Error('General writes in ' + fromDate + ' to ' + throughDate + ' are not verified: ' + closed.failures.map(item => (item.key ? item.key + ': ' : '') + item.reason).slice(0, 10).join(' | ') + ' The calendar waits until they are corrected or explained.'), { status: 409, code: 'GENERAL_DAY_CLOSE_UNVERIFIED', businessDetail: { ...failureContext(first), fromDate, throughDate, recordCount: closed.records.length, failures: closed.failures.slice(0, 5) }, ...(first.errorDetail?.check ? { businessCheck: first.errorDetail.check } : {}) });
      throw error;
    }
    const row = { _id: hash({ scope: company(scope), fromDate, throughDate, snapshotHash, at: now(), ledger: hash(report) }).slice(0, 24), contract: 'general-write-v1', ...company(scope), fromDate, throughDate, kind: 'period', ok: closed.ok, snapshotHash, ledgerHash: hash(report), recordCount: closed.records.length, failures: closed.failures, records: closed.records.map(row => ({ key: row.key, kind: row.kind })), markers: [], ...(ctx.stockEvidence ? {stock:ctx.stockEvidence} : {}), verifiedAt: new Date(now()) };
    await Closes.create([row]);
    return row;
  }
  async function checkPeriodReady(scope, { fromDate, throughDate, verifiedThrough, openingDate, mappings, readLedger }) {
    const need = await pending(scope, { fromDate, throughDate, verifiedThrough });
    if (need.unresolved.length) fail('General history edits have unresolved accounting invalidation from ' + need.unresolved.map(row => row.earliestDate).sort()[0] + '. Historical completions, downstream movements' + (openingDate && need.unresolved.some(row => row.earliestDate < openingDate) ? ' and the opening baseline' : '') + ' must be re-proved; record-only ledger checks cannot clear these markers.');
    const results = need.hasRecords ? [await verifyRange(scope, { fromDate, throughDate, readLedger, mappings, verifiedThrough, openingDate, gathered: need.gathered })] : [];
    const failed = results.filter(row => !row.ok);
    if (failed.length) fail('General writes in ' + fromDate + ' to ' + throughDate + ' are not verified: ' + failed.flatMap(row => row.failures.map(item => (item.key ? item.key + ': ' : '') + item.reason)).slice(0, 10).join(' | ') + ' The calendar waits until they are corrected or explained.', { ...failureContext(failed[0].failures[0]), fromDate, throughDate, failures: failed.flatMap(row => row.failures).slice(0, 10) });
    return { required: results.length > 0, results: results.map(row => ({ fromDate: row.fromDate, throughDate: row.throughDate, kind: row.kind, ok: row.ok, recordCount: row.recordCount })) };
  }

  function failureContext(failure = {}) {
    const [entity, recordId] = (failure.key || '').split(':');
    return { entity: entity || null, recordId: recordId || null, differences: failure.differences || failure.errorDetail?.detail?.differences || [] };
  }
  // Preparation can fail before an OperationRun exists. Retain that failure as a
  // close attempt so blockers and the accountant see the same diagnostic.
  async function assertPeriodReady(scope, options) {
    let ledger = null;
    try { return await checkPeriodReady(scope, { ...options, readLedger: async (...args) => (ledger = await options.readLedger(...args)) }); }
    catch (error) {
      error.errorDetail = businessErrorDetail(error, { detail: { fromDate: options.fromDate, throughDate: options.throughDate } });
      const errorDetail = error.errorDetail;
      try { await Closes.create([{ _id: hash({ scope: company(scope), fromDate: options.fromDate, throughDate: options.throughDate, errorDetail, at: now() }).slice(0, 24), contract: 'general-write-v1', ...company(scope), fromDate: options.fromDate, throughDate: options.throughDate, kind: 'period', ok: false, ledgerHash: hash(ledger), recordCount: error.businessDetail?.recordCount || 0, failures: [{ key: errorDetail.entity && errorDetail.recordId ? errorDetail.entity + ':' + errorDetail.recordId : null, reason: errorDetail.message, errorDetail }], records: [], markers: [], errorDetail, verifiedAt: new Date(now()) }]); }
      catch { error.errorDetail = businessErrorDetail({ ...errorDetail, detail: { ...errorDetail.detail, diagnosticPersistence: 'unavailable' } }); }
      throw error;
    }
  }

  async function reverifyDirty(scope, { verifiedThrough, openingDate, mappings, readLedger, readReports, references, verifyFixedDay, guard, transaction }) {
    const { reverifyHistory } = require('./general-write-recovery'), { dirtyRange } = require('./general-write-close');
    const { readGeneralRuns } = require('./general-write-day-close');
    const unsent = require('./general-write-unsent').createGeneralUnsentRetirement({ models, Runs, now });
    let runs = await readGeneralRuns(Runs, scope);
    for (const run of runs) await unsent.retire(scope, run);
    runs = await readGeneralRuns(Runs, scope);
    const markers = runs.flatMap(run => (run.dirty || []).map(marker => ({ ...marker, earliestDate: marker.date, runId: String(run._id) })));
    const range = dirtyRange({ markers, verifiedThrough, openingDate });
    if (!range) return { ok: true, required: false };
    if (typeof transaction !== 'function' || typeof guard !== 'function') fail('History re-verification needs transactional company fences.');
    const original = persistedHash(runs), snapshots = [];
    const check = async session => {
      await guard(session);
      if (persistedHash(await readGeneralRuns(Runs, scope)) !== original) fail('General history changed during re-verification; dirty markers remain.');
    };
    await check();
    const earliest = markers.map(row => row.earliestDate).sort()[0];
    const changed = await generalRecordsFor({ Runs, scope, day: earliest, through: verifiedThrough, copy, models, now });
    const ctx = await contextFor(scope, mappings, changed.records);
    const result = await reverifyHistory({ scope: company(scope), range, runs, references, readReports, context: ctx, now, guard: check,
      verifyDay: async day => {
        const from = range.baseline && day < openingDate ? earliest : day;
        const preview = await generalRecordsFor({ Runs, scope, day: from, through: day, copy, models, now }), dayCtx = await contextFor(scope, mappings, preview.records);
        const ledgerReport = await readLedger(from, day);
        const after = await generalRecordsFor({ Runs, scope, day: from, through: day, copy, models, now });
        if (hash(closeWindow(preview)) !== hash(closeWindow(after)) || hash(postingContext(dayCtx.evidence)) !== hash(postingContext((await contextFor(scope, mappings, after.records)).evidence))) fail('History records changed during ledger verification.');
        const settlements = await fixedSettlementsFor(scope, preview);
        if (typeof verifyFixedDay !== 'function') fail('Historical fixed-record re-verification is unavailable.');
        const fixed = await verifyFixedDay(from, day, preview.records);
        const closed = await closeGeneralDay({ Runs, scope, day: from, through: day, copy, ledgerReport, ctx: dayCtx, gathered: preview, ownSettlements: settlements });
        if (closed.fixedWorkflowKeys.some(key => !fixed.some(row => row.key === key))) fail('A historical ledger record has no re-verified original ownership proof.');
        return { ...closed, fixedRecords: fixed, ledgerReport };
      },
      save: async proof => {
        // One bounded document per day; an interruption keeps the original dirty
        // markers, and no partially collected history can authorize new work.
        const id = hash({ scope: company(scope), original, proof }).slice(0, 24);
        if (!await Closes.findOne({ _id: id }).maxTimeMS(3000).lean()) await Closes.create([{ _id: id, contract: 'general-write-v1', ...company(scope), fromDate: proof.day, throughDate: proof.day, kind: 'reverify', ok: true, snapshotHash: original, ledgerHash: proof.ledgerHash, recordCount: proof.records.length, failures: [], records: proof.records, markers: [], history: proof, verifiedAt: new Date(now()) }]);
        snapshots.push({ id, day: proof.day, sourceHash: proof.sourceHash, ledgerHash: proof.ledgerHash, recordCount: proof.records.length });
      },
    });
    // Persist proof and clear only the exact markers whose original settled runs were
    // observed. Transaction failure leaves all dirty markers in force for the next pass.
    await transaction(async session => {
      await check(session);
      const id = hash({ scope: company(scope), original, result }).slice(0, 24);
      await Closes.create([{ _id: id, contract: 'general-write-v1', ...company(scope), fromDate: range.from, throughDate: range.through, kind: 'reverify', ok: true, snapshotHash: original, ledgerHash: hash(snapshots.map(row => row.ledgerHash)), recordCount: snapshots.reduce((n, row) => n + row.recordCount, 0), failures: [], records: [], markers: markers.filter(row => row.date <= range.through).map(row => row.runId + ':' + row.date), history: { baseline: range.baseline, days: snapshots }, verifiedAt: new Date(now()) }], { session });
      for (const run of runs.filter(run => run.dirty?.length)) {
        const saved = await Runs.findOneAndUpdate({ _id: run._id, ...company(scope), revision: run.revision, dirty: run.dirty }, { $set: { dirty: run.dirty.filter(marker => marker.date > range.through) }, $inc: { revision: 1 } }, { new: true, session }).lean();
        if (!saved) fail('A history marker changed before its proof committed.');
      }
    });
    return { ...result, required: true };
  }
  async function retryFailed(scope, options) {
    const rows = await Closes.find({ ...company(scope), kind: 'period' }).sort({ verifiedAt: -1 }).limit(20).maxTimeMS(3000).lean(), seen = new Set(), results = [];
    for (const row of rows) {
      const key = row.fromDate + ':' + row.throughDate;
      if (seen.has(key)) continue; seen.add(key);
      if (row.ok) continue;
      try { results.push(await verifyRange(scope, { ...options, fromDate: row.fromDate, throughDate: row.throughDate, force: true })); }
      catch (error) { results.push({ ok: false, reason: error.message }); }
      if (results.length === 3) break;
    }
    return results;
  }
  return { pending, assertPeriodReady, reverifyDirty, retryFailed, ledgerEndpoint, retainStockReturns };

}
module.exports = { createGeneralCloseGate };
