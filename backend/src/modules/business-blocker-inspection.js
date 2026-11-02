'use strict';
// Diagnostic reads only. No QBO client, observation-store reader (which can retain
// records), repair, authority amendment or state transition is used here.
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const ID = /^[a-f0-9]{24}$/;
const QID = /^\d{1,30}$/;
const sameScope = (a, b) => ['environment', 'realmId', 'connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
const SECRET = /password|secret|authorization|cookie|api.?key|access.?token|refresh.?token|id.?token|jwt|private.?key|client.?credential|^credentials?$|^token$/i;
function safeText(value) {
  return String(value).slice(0, 6000).replace(/((?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?)(?:Basic|Bearer)\s+[^\s,;"'}]+/gi, '$1[redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk)-(?:proj-|ant-)?[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:password|secret|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[redacted]')
    .replace(/(\b[a-z][a-z0-9+.-]{0,20}:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@').slice(0, 6000);
}
function clean(value, depth = 0) {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') return safeText(value);
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 150).map(row => clean(row, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, 150).map(([key, entry]) => [safeText(key), SECRET.test(key) ? '[redacted]' : /^(?:observation|observations|referenceEvidence|record)$/.test(key) ? '[record omitted; see scoped comparisons]' : clean(entry, depth + 1)]));
}
// Show accounting definitions, never credentials, contact details or arbitrary
// provider payloads. Reference labels and SyncToken are intentionally included,
// even where the definition verifier ignores them.
const FIELDS = new Set(['Id', 'SyncToken', 'Name', 'DisplayName', 'CompanyName', 'GivenName', 'MiddleName', 'FamilyName', 'FullyQualifiedName', 'Description', 'PurchaseDesc', 'Type', 'AccountType', 'AccountSubType', 'Classification', 'Active', 'UnitPrice', 'PurchaseCost', 'Taxable', 'SalesTaxIncluded', 'PurchaseTaxIncluded', 'SalesTaxCodeRef', 'PurchaseTaxCodeRef', 'SalesTaxRateList', 'PurchaseTaxRateList', 'RateValue', 'EffectiveTaxRate', 'SpecialTaxType', 'TaxReturnLineRef', 'PrintGroupCode', 'TaxGroup', 'TaxRateDisplayType']);
function bounded(value, max = 12000) {
  const result = clean(value);
  if (Buffer.byteLength(JSON.stringify(result) || '') <= max) return result;
  return { truncated: true, retainedExcerpt: safeText(JSON.stringify(result)).slice(0, Math.max(100, max - 100)) };
}
function fields(record) {
  return record ? clean(Object.fromEntries(Object.entries(record).filter(([key]) => FIELDS.has(key) || /Ref$/.test(key) && !SECRET.test(key)))) : null;
}
function flatten(value, path = '', out = {}) {
  if (value && typeof value === 'object' && Object.keys(value).length) {
    for (const [key, entry] of Object.entries(value)) flatten(entry, path ? path + (Array.isArray(value) ? '[' + key + ']' : '.' + key) : key, out);
  } else out[path] = value;
  return out;
}
function differences(approved, current) {
  const a = flatten(approved || {}), b = flatten(current || {});
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter(key => canonical(a[key] ?? null) !== canonical(b[key] ?? null) || Object.hasOwn(a, key) !== Object.hasOwn(b, key)).map(field => ({ field, approved: a[field] ?? null, current: b[field] ?? null, approvedPresent: Object.hasOwn(a, field), currentPresent: Object.hasOwn(b, field) }));
}
function createBlockerInspection({ models, scope, signal, now = () => Date.now() }) {
  scope = scoped(scope);
  const one = (Model, filter) => Model.findOne({ ...filter, ...scope }).maxTimeMS(3000).lean();
  const many = (Model, filter, limit, sort) => Model.find({ ...filter, ...scope }).sort(sort).limit(limit).maxTimeMS(3000).lean();
  const check = () => signal?.throwIfAborted();
  function liveObservations(run, step) {
    const diagnostic = run.executionRequest?.result?.diagnostic;
    const candidates = [diagnostic?.observation, step?.verification?.observation, ...(Array.isArray(diagnostic?.observations) ? diagnostic.observations : []), ...(Array.isArray(diagnostic?.referenceEvidence) ? diagnostic.referenceEvidence : [])];
    return candidates.filter(obs => { try { return obs?.record && QID.test(obs.record.Id || '') && sameScope(obs.scope, scope) && sameScope(obs.source?.scope, scope) && obs.source?.kind === 'qbo-full-entity-get' && obs.source.entity === obs.entity && obs.source.id === obs.record?.Id && obs.recordHash === hash(obs.record) && obs.source.recordHash === obs.recordHash && Number.isFinite(Date.parse(obs.observedAt)) && Date.parse(obs.observedAt) <= now(); } catch { return false; } });
  }
  return async function inspectBlocker(operationId) {
    if (!ID.test(operationId || '')) throw Object.assign(new Error('Choose an exact saved operation identifier.'), { status: 400 });
    check();
    const run = await one(models.Runs, { _id: operationId });
    if (!run) {
      const general = models.GeneralWriteRuns && await one(models.GeneralWriteRuns, { _id: operationId, contract: 'general-write-v1' });
      if (!general) return { success: false, notFound: true, error: 'No saved accounting operation has this identifier in the selected company.' };
      const recovery = [];
      for (const [ref,item] of Object.entries(general.items || {}).slice(0,60)) {
        check();
        if (item.outcome !== 'mismatch' || item.entity !== 'Invoice') continue;
        const batch = general.batches?.find(row => row.attempt === item.attempt && row.items?.some(sent => sent.ref === ref));
        const receipt = batch?.transport?.receiptId && models.Receipts ? await one(models.Receipts, { _id: batch.transport.receiptId, kind: 'general-write', state: 'saved' }) : null;
        const helper = require('./general-estimate-recovery'), source = helper.sourceOf(general,ref,receipt);
        if (source) recovery.push(helper.packetOf(general,source));
      }
      return { success:true, data:{ operationId,contract:general.contract,status:general.status,readOnly:true,qboRequests:0,estimateRecovery:recovery,capabilityKey:recovery.length?'general-native-estimate-conversion':null,...require('./business-error-detail').generalAttention(general),limitations:['Inspection authenticates retained saves only. Native execution and current accounting proof remain separate.'],nextAction:recovery.length?'Keep the exact saved Invoice IDs. Use one general-native-estimate-conversion capability request for the missing governed native operator; do not resubmit these creates. Continue independent work.':'Use the recorded general-write error; inspection grants no retry or write authority.' } };
    }
    const result = run.executionRequest?.result || {}, diagnostic = bounded(result.diagnostic && typeof result.diagnostic === 'object' ? Object.fromEntries(Object.entries(result.diagnostic).filter(([key]) => ['name', 'code', 'message', 'error', 'stack', 'source', 'file', 'line', 'column', 'status', 'qboStatus', 'intuit_tid', 'operationId', 'logicalKey', 'ordinal', 'entity', 'qboId', 'reason', 'cause', 'expectedSyncToken', 'actualSyncToken'].includes(key))) : result.diagnostic || null);
    // A refusal before claim has no OperationStep yet; nextOrdinal still names
    // its immutable intent. Needs-check work may have been deferred past it.
    const failed = await many(models.Steps, { operationId, planHash: run.planHash, state: { $in: ['needs-check', 'rejected', 'unknown', 'saved', 'claimed', 'dispatched'] } }, 21, { updatedAt: -1, logicalKey: 1 });
    const deferred = Array.isArray(run.deferredSteps) ? run.deferredSteps : [];
    const cursorIntent = await one(models.Intents, { planId: run.planId, planHash: run.planHash, ordinal: run.nextOrdinal ?? 0 });
    const foundIntents = await many(models.Intents, { planId: run.planId, planHash: run.planHash, $or: [
      { ordinal: run.nextOrdinal ?? 0 }, { logicalKey: { $in: [...failed.map(row => row.logicalKey), ...deferred.slice(0, 20).map(row => row.logicalKey)] } }
    ] }, 21, { ordinal: 1 });
    const intents = [...(cursorIntent ? [cursorIntent] : []), ...foundIntents.filter(row => row.logicalKey !== cursorIntent?.logicalKey)];
    check();
    const data = { operationId, status: run.status, readOnly: true, qboRequests: 0, lastError: clean(run.lastError || null), recordedResult: clean({ state: result.state, error: result.error, code: result.code }), diagnostic, ...((result.errorDetail || run.errorDetail) ? { errorDetail: require('./business-error-detail').businessErrorDetail(result.errorDetail || run.errorDetail) } : {}),
      cursor: { nextOrdinal: run.nextOrdinal ?? 0, recordCount: run.recordCount, deferredCount: deferred.length }, steps: [], limitations: [], nextAction: 'Use this exact recorded cause and the differing fields in requestCapability; retain saved records and receipts. Inspection grants no retry or write authority.' };
    const mirrors = new Map();
    async function mirrored(entity, id) {
      const key = entity + ':' + id;
      if (!mirrors.has(key)) {
        if (mirrors.size >= 100) { if (!data.limitations.includes('Synced-record read budget reached (100 records).')) data.limitations.push('Synced-record read budget reached (100 records).'); return null; }
        mirrors.set(key, await one(models.Records, { entity, qboId: id }));
      }
      return mirrors.get(key);
    }
    const reference = require('./business-reference'), policyCache = new Map();
    for (const intent of intents.slice(0, 20)) {
      check();
      const saved = failed.find(row => row.logicalKey === intent.logicalKey) || await one(models.Steps, { logicalKey: intent.logicalKey });
      let policy = intent.policy, policyError = null;
      if (run.policyAmendmentHash) {
        try { policy = await require('./business-policy-amendment').effectiveBusinessPolicy(models, scope, run, intent, undefined, policyCache); }
        catch (error) { policy = null; policyError = bounded({ code: error.code, error: error.message }, 2000); }
      }
      const entry = { ordinal: intent.ordinal, logicalKey: intent.logicalKey, entity: intent.step?.entity, txnDate: intent.step?.txnDate, atCursor: intent.ordinal === run.nextOrdinal,
        state: saved?.state || 'not-claimed', deferred: deferred.some(row => row.logicalKey === intent.logicalKey), rejection: bounded(saved?.rejection || null, 2000), verification: bounded(saved?.verification || null, 2000), policyAmendmentHash: run.policyAmendmentHash || null, policyError, references: [], taxSources: [], recordVersion: null };
      const live = liveObservations(run, saved);
      async function compare(entity, id, approvedRecord, approvedBinding = null) {
        const mirror = await mirrored(entity, id), current = mirror?.record?.Id === id ? mirror.record : null;
        const observed = live.filter(obs => obs.entity === entity && obs.record.Id === id).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
        // Authenticate a full approved witness against the saved definition hash.
        // A matching current definition proves its fields, not its original version.
        let baseline = approvedRecord, baselineSource = approvedRecord ? 'retained-approved-record' : null;
        if (approvedBinding) {
          baseline = null;
          for (const [candidate, source] of [[approvedRecord, 'retained-approved-record'], [current, 'matching-synced-definition'], [observed?.record, 'matching-live-definition']]) {
            try { if (candidate && reference.referenceDefinition(scope, entity, candidate, approvedBinding.definition?.version).hash === approvedBinding.definition?.hash) { baseline = candidate; baselineSource = source; break; } } catch { /* Invalid or absent historical record is not an approved baseline. */ }
          }
        }
        const inferred = baselineSource === 'matching-synced-definition' || baselineSource === 'matching-live-definition';
        const unboundApprovedFields = inferred && approvedBinding?.definition?.version === 2 ? [...new Set([...Object.keys(flatten(fields(current) || {})), ...Object.keys(flatten(fields(observed?.record) || {}))])].filter(field => /Ref\.name$/.test(field)) : [];
        const approved = fields(inferred && approvedBinding?.definition?.version === 2 ? reference.definitionFields(entity, baseline) : baseline) || (approvedBinding ? { Id: id, SyncToken: approvedBinding.syncToken } : null);
        if (approvedBinding && approved) approved.SyncToken = approvedBinding.syncToken;
        let currentDefinition = null;
        if (approvedBinding && current) { try { currentDefinition = reference.referenceDefinition(scope, entity, current, approvedBinding.definition?.version); } catch { /* Inactive/incomplete records remain visible below. */ } }
        return { entity, id, ...(approvedBinding ? { key: approvedBinding.key, approvedBinding: clean(approvedBinding), currentDefinition } : {}), approved, approvedFieldsAvailable: Boolean(baseline), approvedSource: baselineSource, unboundApprovedFields,
          missingApprovedFields: baseline ? null : 'Only the saved binding/hash is retained; original field values cannot be reconstructed. Unavailable fields below are not proven differences.',
          synced: { available: Boolean(current), deleted: mirror?.deleted ?? null, observedAt: mirror?.lastObservedAt || null, generation: mirror?.generation || null, freshness: 'Retained synced record; this inspection does not certify current sync.', fields: fields(current) },
          differences: approved && current ? differences(approved, fields(current)).filter(row => !unboundApprovedFields.includes(row.field) && (baseline || row.field === 'Id' || row.field === 'SyncToken')) : [],
          latestLiveObservation: observed ? { observedAt: observed.observedAt, source: 'retained-qbo-full-entity-get', fields: fields(observed.record), differences: approved ? differences(approved, fields(observed.record)).filter(row => !unboundApprovedFields.includes(row.field) && (baseline || row.field === 'Id' || row.field === 'SyncToken')) : [] } : null };
      }
      for (const binding of (intent.step?.references || []).slice(0, 100)) {
        if (!QID.test(binding.id || '') || !['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'TaxCode'].includes(binding.entity)) continue;
        const taxSource = policy?.taxSources?.find(source => source.entity === binding.entity && source.id === binding.id && source.record && hash(source.record) === source.recordHash);
        const amendment = policy?.taxReferenceDefinitions?.find(choice => choice.id === binding.id && choice.key === binding.key);
        const effectiveBinding = amendment ? { ...binding, definition: amendment.definition } : binding;
        entry.references.push({ ...await compare(binding.entity, binding.id, binding.record || taxSource?.record, effectiveBinding), ...(amendment ? { originalApprovedBinding: clean(binding) } : {}) });
      }
      for (const source of (policy?.taxSources || []).slice(0, 25)) {
        if (!['TaxCode', 'TaxRate'].includes(source.entity) || !QID.test(source.id || '')) continue;
        const authentic = source.record && hash(source.record) === source.recordHash;
        entry.taxSources.push({ ...await compare(source.entity, source.id, authentic ? source.record : null), approvedEvidenceMatchesHash: Boolean(authentic) });
      }
      if (saved?.qboId) {
        const mirror = await mirrored(saved.entity, saved.qboId), current = mirror?.record;
        const expected = saved.verification?.syncToken || saved.receipt?.syncToken || null;
        const expectedHash = saved.verification?.observedHash || null;
        entry.recordVersion = { entity: saved.entity, id: saved.qboId, receiptVersion: saved.receipt?.syncToken || null, verifiedVersion: saved.verification?.syncToken || null, currentSyncedVersion: current?.SyncToken ?? null, versionMismatch: expected !== null && current ? expected !== current.SyncToken : null, verifiedRecordHash: expectedHash, currentSyncedRecordHash: current ? hash(current) : null, recordHashMismatch: expectedHash && current ? expectedHash !== hash(current) : null, reason: clean(saved.verification?.reason || null) };
        entry.recordVersion.note = 'A difference is diagnostic evidence, not proof of an invalid write. If the verifier did not retain its exact mismatch, its cause remains unavailable.';
      }
      if (saved?.errorDetail || saved?.verification?.errorDetail) entry.errorDetail = require('./business-error-detail').businessErrorDetail(saved.errorDetail || saved.verification.errorDetail);
      data.steps.push(entry);
    }
    if (failed.length > 20 || intents.length > 20 || deferred.length > 20) data.limitations.push('Only the first 20 relevant saved steps are shown; more blocked/deferred evidence exists.');
    if (!data.steps.length) data.limitations.push('No matching intent/step was retained at the cursor; use the recorded run diagnostic.');
    if (data.steps.some(row => row.references.some(ref => !ref.approvedFieldsAvailable))) data.limitations.push('Some approved bindings retain only hashes, so exact historical field differences are unavailable for those records.');
    // Bound model output while preserving run error, cursor and step identities.
    for (const entry of [...data.steps].reverse()) {
      if (Buffer.byteLength(JSON.stringify(data)) <= 85000) break;
      if (entry !== data.steps[0] && entry.errorDetail) { delete entry.errorDetail; if (!data.limitations.includes('Additional step diagnostics omitted to fit the result budget; retained details remain available from business blockers.')) data.limitations.push('Additional step diagnostics omitted to fit the result budget; retained details remain available from business blockers.'); }
      entry.references = []; entry.taxSources = []; entry.verification = bounded(entry.verification, 500); entry.rejection = bounded(entry.rejection, 500); entry.evidenceOmitted = 'Field comparisons omitted to fit the result budget.';
      if (!data.limitations.includes('Some field comparisons exceeded the result budget.')) data.limitations.push('Some field comparisons exceeded the result budget.');
    }
    check(); return { success: true, data };
  };
}
module.exports = { createBlockerInspection };
