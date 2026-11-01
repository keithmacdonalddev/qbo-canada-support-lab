'use strict';
// General closes bind every run, current record and posting reference version. Historical
// edits are held by durable markers until downstream periods and opening evidence re-prove.
const { hash } = require('./business-calendar');
const persistedHash = value => hash(JSON.parse(JSON.stringify(value)));
const { closeGeneralDay, ledgerEndpoint, generalRecordsFor, settlementLinks, SETTLEMENT_ENTITIES } = require('./general-write-day-close');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'GENERAL_DAY_CLOSE_UNVERIFIED' }); }
const TAX_SUBTYPES = ['GlobalTaxPayable', 'GlobalTaxSuspense', 'SalesTaxPayable', 'OtherCurrentLiabilities'];
function createGeneralCloseGate({ models = {}, copy, now = () => Date.now() }) {
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
      if (!inventory.enabled) fail('Inventory close proof is disabled on this server.');
      const stockModels = { ...require('./business-runtime').loadModels(), ...models, Records, Agents: models.Agents || require('../models/BusinessAgent'), Authorities: require('../models/BusinessAuthority'), Versions: require('../models/BlueprintVersion'), Baselines: require('../models/BusinessBaseline') };
      const active = await require('./business-authority').readPublishedBusiness({ ...stockModels, scope });
      const days = [...new Set(records.flatMap(row => [row.current?.TxnDate, row.before?.TxnDate]).filter(Boolean))];
      if (days.length !== 1) fail('Inventory close needs one complete open-day replay.');
      stock = await require('./business-stock-general').readGeneralStockContext({ models: stockModels, scope, active, day: days[0], observations: require('./business-observation-store').createBusinessObservationStore({ ...stockModels, now }) });
    }
    const evidence = { ...(stock ? { stockBasisHash: stock.basisHash } : {}), mappings, sources: [...sources], items: [...items], taxAccounts: accounts.map(row => ({ qboId: row.qboId, record: row.record })) };
    return { evidence, inventory, ...(stock ? { stockCost: (entity, record, lineIndex) => require('./business-stock-general').stockPostingCost(stock, entity, record, lineIndex) } : {}), homeCurrency: 'CAD', currencyAccount, exchangeGainLoss: gains.length === 1 ? String(gains[0].qboId) : null, get: (entity, id) => entity === 'Item' ? items.get(String(id)) || null : sources.get(entity + ':' + id) || null,
      receivables: mappings.accountsReceivable ? String(mappings.accountsReceivable) : null, payables: mappings.accountsPayable ? String(mappings.accountsPayable) : null, undepositedFunds: mappings.undepositedFunds ? String(mappings.undepositedFunds) : null,
      // Retain real account identities. Multiple agency accounts require an explicit
      // rate-to-account proof; guessing or collapsing them could hide a substitution.
      taxAccount: () => { if (tax.length !== 1) fail('The tax posting account cannot be attributed uniquely; retain a rate-to-account proof before close.'); return tax[0]; }, accountKey: id => String(id) };
  }
  async function fixedSettlementsFor(scope, gathered) {
    const own = new Set((gathered.settlementVersions || []).map(row => row.key)), wanted = new Map();
    for (const row of gathered.records) for (const key of settlementLinks(row.current)) {
      if (own.has(key) || !SETTLEMENT_ENTITIES.has(key.split(':')[0])) continue;
      if (!wanted.has(key)) wanted.set(key, new Set());
      wanted.get(key).add(row.entity + ':' + row.id);
    }
    const evidence = [];
    if (!wanted.size) return evidence;
    const Steps = models.Steps || require('../models/OperationStep');
    // Only the linked IDs are needed; no broad workflow scan or live operation occurs.
    const keys = [...wanted.keys()].sort();
    for (let offset = 0; offset < keys.length; offset += 100) {
      const page = keys.slice(offset, offset + 100);
      const rows = await Steps.find({ ...company(scope), state: 'verified', $or: page.map(key => { const [entity, qboId] = key.split(':'); return { entity, qboId }; }) }).select('entity qboId state receipt dispatch verification revision').sort({ _id: 1 }).limit(page.length + 1).maxTimeMS(3000).lean();
      if (rows.length > page.length) fail('Settlement ownership evidence is duplicated; close is incomplete.');
      for (const row of rows) {
        const key = row.entity + ':' + row.qboId, proof = row.verification;
        if (!wanted.has(key) || row.state !== 'verified' || row.receipt?.qboId !== row.qboId || proof?.kind !== 'business-readback' || !proof.observedHash || !row.dispatch?.compilationHash || proof.compilationHash !== row.dispatch.compilationHash || !proof.relationships?.some(link => wanted.get(key).has(link.entity + ':' + link.qboId))) continue;
        const current = await copy.read(scope, row.entity, row.qboId);
        if (!current || hash(current) !== proof.observedHash) continue;
        evidence.push({ key, targets: settlementLinks(current).filter(target => wanted.get(key).has(target) && proof.relationships.some(link => link.entity + ':' + link.qboId === target)).sort(), revision: row.revision, verification: proof, record: current });
      }
    }
    return evidence.sort((a, b) => a.key.localeCompare(b.key));
  }
  async function verifyRange(scope, { fromDate, throughDate, readLedger, mappings, verifiedThrough, openingDate, gathered, force = false }) {
    const preview = gathered || await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy, models, now }), ctx = await contextFor(scope, mappings, preview.records);
    const settlements = await fixedSettlementsFor(scope, preview);
    const snapshotHash = hash({ fromDate, throughDate, ...preview, settlements, context: ctx.evidence });
    const prior = await Closes.findOne({ ...company(scope), fromDate, throughDate, kind: 'period', ok: true, snapshotHash }).sort({ verifiedAt: -1 }).maxTimeMS(3000).lean();
    if (!force && prior?.snapshotHash === snapshotHash) return prior;
    const report = await readLedger(fromDate, throughDate);
    const after = await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy, models, now });
    const afterContext = await contextFor(scope, mappings, after.records), afterSettlements = await fixedSettlementsFor(scope, after);
    if (hash(preview) !== hash(after) || hash(ctx.evidence) !== hash(afterContext.evidence) || hash(settlements) !== hash(afterSettlements)) fail('General-write records or posting references changed while the ledger was read; close needs fresh evidence.');
    const closed = await closeGeneralDay({ Runs, scope, day: fromDate, through: throughDate, copy, ledgerReport: report, ctx, verifiedThrough, openingDate, gathered: preview, ownSettlements: settlements });
    const row = { _id: hash({ scope: company(scope), fromDate, throughDate, snapshotHash, at: now(), ledger: hash(report) }).slice(0, 24), contract: 'general-write-v1', ...company(scope), fromDate, throughDate, kind: 'period', ok: closed.ok, snapshotHash, ledgerHash: hash(report), recordCount: closed.records.length, failures: closed.failures.map(row => ({ key: row.key, reason: row.reason })), records: closed.records.map(row => ({ key: row.key, kind: row.kind })), markers: [], verifiedAt: new Date(now()) };
    await Closes.create([row]);
    return row;
  }
  async function assertPeriodReady(scope, { fromDate, throughDate, verifiedThrough, openingDate, mappings, readLedger }) {
    const need = await pending(scope, { fromDate, throughDate, verifiedThrough });
    if (need.unresolved.length) fail('General history edits have unresolved accounting invalidation from ' + need.unresolved.map(row => row.earliestDate).sort()[0] + '. Historical completions, downstream movements' + (openingDate && need.unresolved.some(row => row.earliestDate < openingDate) ? ' and the opening baseline' : '') + ' must be re-proved; record-only ledger checks cannot clear these markers.');
    const results = need.hasRecords ? [await verifyRange(scope, { fromDate, throughDate, readLedger, mappings, verifiedThrough, openingDate, gathered: need.gathered })] : [];
    const failed = results.filter(row => !row.ok);
    if (failed.length) fail('General writes in ' + fromDate + ' to ' + throughDate + ' are not verified: ' + failed.flatMap(row => row.failures.map(item => (item.key ? item.key + ': ' : '') + item.reason)).slice(0, 10).join(' | ') + ' The calendar waits until they are corrected or explained.');
    return { required: results.length > 0, results: results.map(row => ({ fromDate: row.fromDate, throughDate: row.throughDate, kind: row.kind, ok: row.ok, recordCount: row.recordCount })) };
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
        if (hash(preview) !== hash(after) || hash(dayCtx.evidence) !== hash((await contextFor(scope, mappings, after.records)).evidence)) fail('History records changed during ledger verification.');
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
  return { pending, assertPeriodReady, reverifyDirty, retryFailed, ledgerEndpoint };

}
module.exports = { createGeneralCloseGate };
