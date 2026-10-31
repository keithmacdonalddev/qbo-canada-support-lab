'use strict';
// General closes bind every run, current record and posting reference version. Historical
// edits remain unavailable until downstream periods and opening evidence can be re-proved.
const { hash } = require('./business-calendar');
const { closeGeneralDay, ledgerEndpoint, generalRecordsFor, settlementLinks, SETTLEMENT_ENTITIES } = require('./general-write-day-close');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'GENERAL_DAY_CLOSE_UNVERIFIED' }); }
const TAX_SUBTYPES = ['GlobalTaxPayable', 'GlobalTaxSuspense', 'SalesTaxPayable', 'OtherCurrentLiabilities'];
function createGeneralCloseGate({ models = {}, copy, now = () => Date.now() }) {
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun'), Closes = models.GeneralDayCloses || require('../models/GeneralDayClose'), Records = models.Records || require('../models/CompanySyncRecord');
  const company = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId });
  async function pending(scope, { fromDate, throughDate, verifiedThrough }) {
    const gathered = await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy });
    // Include current dates: an external move into this period must not escape close.
    const unresolved = gathered.dirty.filter(row => verifiedThrough && row.earliestDate <= verifiedThrough).map(row => ({ key: String(row.runId) + ':' + row.earliestDate, earliestDate: row.earliestDate }));
    return { hasRecords: gathered.records.length > 0, unresolved, gathered };
  }

  async function contextFor(scope, mappings, records) {
    const items = new Map(), wanted = new Set();
    for (const row of records) for (const record of [row.current, row.before]) for (const line of record?.Line || []) { const id = line?.[line?.DetailType]?.ItemRef?.value; if (id != null) wanted.add(String(id)); }
    for (const id of wanted) { const record = await copy.read(scope, 'Item', id); if (record) items.set(id, record); }
    const accounts = await Records.find({ ...company(scope), entity: 'Account', deleted: false, 'record.AccountSubType': { $in: TAX_SUBTYPES } }).select('qboId record').limit(201).maxTimeMS(3000).lean();
    if (accounts.length > 200) fail('Tax-account enumeration exceeds its proof budget; close is incomplete.');
    const tax = accounts.filter(row => row.record?.AccountSubType !== 'OtherCurrentLiabilities' || /\b(GST|HST|PST|QST|tax)\b/i.test(row.record?.Name || '')).map(row => String(row.qboId));
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
    const evidence = { ...(stock ? { stockBasisHash: stock.basisHash } : {}), mappings, items: [...items], taxAccounts: accounts.map(row => ({ qboId: row.qboId, record: row.record })) };
    return { evidence, inventory, ...(stock ? { stockCost: (entity, record, lineIndex) => require('./business-stock-general').stockPostingCost(stock, entity, record, lineIndex) } : {}), get: (entity, id) => entity === 'Item' ? items.get(String(id)) || null : null,
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
  async function verifyRange(scope, { fromDate, throughDate, readLedger, mappings, verifiedThrough, openingDate, gathered }) {
    const preview = gathered || await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy }), ctx = await contextFor(scope, mappings, preview.records);
    const settlements = await fixedSettlementsFor(scope, preview);
    const snapshotHash = hash({ fromDate, throughDate, ...preview, settlements, context: ctx.evidence });
    const prior = await Closes.findOne({ ...company(scope), fromDate, throughDate, kind: 'period', ok: true, snapshotHash }).sort({ verifiedAt: -1 }).maxTimeMS(3000).lean();
    if (prior?.snapshotHash === snapshotHash) return prior;
    const report = await readLedger(fromDate, throughDate);
    const after = await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy });
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
  return { pending, assertPeriodReady, ledgerEndpoint };
}
module.exports = { createGeneralCloseGate };
