'use strict';
const { hash, canonical } = require('./business-calendar');
const { denied, scoped } = require('./qbo-write-contract');
const { draftView, validateDraftInput, MAPPINGS } = require('./blueprint-draft');
const { masterRequirements } = require('./business-master-data');
const { compileMasterEntry, verifyMasterReadback } = require('./business-master-preparation-plan');
const { verifiedParents } = require('./business-master-preparation-transport');
const { writeBlueprintDraft } = require('./blueprint-draft-write');
const { createMasterQboAccess } = require('./business-master-qbo-access');
const ZERO_KEY = '00000000-0000-0000-0000-000000000000';
function masterApplyReview(run, latest, ordinals, proofs, now = Date.now()) {
  const scope = scoped({ environment: run.environment, realmId: run.realmId, connectionId: String(run.connectionId) });
  if (!latest || latest.contractVersion !== 2 || latest.realmId !== scope.realmId || latest.environment !== scope.environment || String(latest.connectionId) !== scope.connectionId || hash(latest.definition) !== latest.contentHash || !Array.isArray(ordinals) || !ordinals.length || ordinals.length > 100 || ordinals.some((n, i) => !Number.isInteger(n) || n < 0 || (i && n <= ordinals[i-1])) || !Array.isArray(proofs) || proofs.length !== ordinals.length) throw denied('Review an exact ordered subset against the current saved business draft.');
  const view = draftView(latest, scope.connectionId), mappings = { ...view.mappings }, masterBindings = { ...view.masterBindings }, requirements = masterRequirements(view.business), parents = verifiedParents(run), entries = [];
  for (const [index, ordinal] of ordinals.entries()) {
    const row = run.records[ordinal], entry = run.plan.entries[ordinal];
    if (!row || row.state !== 'verified' || !row.qboId) throw denied('Only independently verified master IDs can be applied.');
    const compiled = compileMasterEntry(run.plan, ordinal, parents), observation = proofs[index], proof = observation?.proof;
    const observed = Date.parse(observation?.observedAt);
    if (!Number.isFinite(observed) || observed > now || now - observed > 300000 || new Date(observed).toISOString() !== observation.observedAt) throw denied('Fresh exact-ID master observations are required before applying a draft.');
    const actual = verifyMasterReadback(compiled, { ...proof?.fields, Id: proof?.qboId, SyncToken: proof?.syncToken }, row.qboId);
    if (canonical(actual) !== canonical(proof)) throw denied('The exact fresh master readback differs from its proof.');
    const destination = entry.target === 'mapping' ? mappings : masterBindings, role = entry.target === 'mapping' ? MAPPINGS[entry.key] : requirements.find(value => value.key === entry.key && value.entity === row.entity);
    if (!role || (role.itemType && role.itemType !== compiled.payload.Type) || (destination[entry.key] && destination[entry.key] !== row.qboId)) throw denied('A selected role is unavailable or already chooses a different record in the current draft.');
    destination[entry.key] = row.qboId; entries.push({ ordinal, key: row.key, entity: row.entity, qboId: row.qboId, provenance: row.attempts.at(-1)?.ownerAttribution ? 'owner-attributed-master-readback' : 'request-correlated-master-readback', proof });
  }
  let itemTaxes = mappings;
  if (run.plan.taxDefaults !== undefined && entries.some(entry => entry.entity === 'Item')) {
    const { bindDatedTax } = require('./business-dated-tax');
    if (canonical(bindDatedTax(view.business, mappings)) !== canonical(bindDatedTax(run.plan.source.business, run.plan.source.mappings))) throw denied('The current dated tax context differs from this prepared item.');
    itemTaxes = run.plan.taxDefaults;
  }
  for (const entry of entries.filter(value => value.entity === 'Item')) {
    const role = requirements.find(value => value.key === entry.key), fields = entry.proof.fields;
    for (const [reference, mapping] of Object.entries(role.accountMappings)) if (!mappings[mapping] || fields[reference]?.value !== mappings[mapping]) throw denied('The current product account choices differ from this prepared item. Select its verified accounts or retain it unassigned.');
    if (fields.Type === 'Inventory' && (typeof fields.InvStartDate !== 'string' || fields.InvStartDate > view.business.openingDate)) throw denied('This inventory item starts after the current business opening date. Retain it unassigned or choose compatible history.');
    if (fields.SalesTaxCodeRef?.value !== itemTaxes.salesTax || (fields.PurchaseTaxCodeRef && fields.PurchaseTaxCodeRef.value !== itemTaxes.purchaseTax)) throw denied('The current tax choices differ from this prepared item.');
  }
  const input = validateDraftInput({ requestKey: ZERO_KEY, connectionId: scope.connectionId, baseHash: latest.contentHash, business: view.business, mappings, masterBindings });
  const disposition = run.records.map(row => ({ ordinal: row.ordinal, key: row.key, entity: row.entity, state: row.state, qboId: row.qboId || null, selected: ordinals.includes(row.ordinal), attempt: row.attempts.at(-1)?.number || 0 }));
  const content = { version: 1, runRevision: run.revision, disposition, scope, ownerId: String(run.ownerId), runId: String(run._id), planHash: run.planHash, baseDraftId: String(latest._id), baseHash: latest.contentHash, baseVersion: latest.version, ordinals, entries, input };
  return { ...content, observationTimes: proofs.map(value => value.observedAt), reviewHash: hash(content), qboWrites: 0, publicationChanged: false };
}
function createMasterApply(d) {
  const { models, scope, transaction, authorize, load, coordination, touchPolicy, change, audit, recovery, now, ownerId, actorId, access, assertReady } = d;
  const latest = session => models.Versions.findOne({ environment: scope.environment, realmId: scope.realmId, contractVersion: 2 }).sort({ version: -1 }).session(session).maxTimeMS(3000).lean();
  const qbo = createMasterQboAccess({ scope, ownerId, authorize: access.authorize, clientFor: access.resolveClient });
  async function readable() {
    if (actorId !== ownerId) throw denied('Only the current company owner may review master application.');
    await assertReady(); await access.authorize(scope, 'operations.recover');
  }
  async function review(id, ordinals) {
    await readable(); const run = await load(id); recovery.inactive(run);
    if (!Array.isArray(ordinals) || !ordinals.length || ordinals.length > 100 || ordinals.some((n, i) => !Number.isInteger(n) || n < 0 || (i && n <= ordinals[i - 1]))) throw denied('Choose an ordered exact subset of verified ordinals.');
    const current = await latest(), proofs = [], started = now();
    for (const ordinal of ordinals) {
      const row = run.records[ordinal]; if (!row || row.state !== 'verified') throw denied('Only verified prepared IDs may be reviewed for application.');
      if (now() - started > 180000) throw denied('The apply review exceeded its read budget. Refresh it.');
      const body = await qbo.read('operations.recover', client => client.apiCall('GET', row.entity.toLowerCase() + '/' + row.qboId));
      proofs.push({ proof: verifyMasterReadback(compileMasterEntry(run.plan, ordinal, verifiedParents(run)), body?.[row.entity], row.qboId), observedAt: new Date(now()).toISOString() });
    }
    await readable(); const after = await load(id), draft = await latest();
    if (after.revision !== run.revision || draft?.contentHash !== current?.contentHash || String(draft?._id) !== String(current?._id)) throw denied('Master progress or the business draft changed during review.');
    return masterApplyReview(run, current, ordinals, proofs, now());
  }
  async function apply(id, requested, requestKey) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestKey || '')) throw denied('An exact apply request identifier is required.');
    await readable(); const before = await load(id);
    let observed;
    if (!before.applied) { observed = await review(id, requested?.ordinals); if (observed.reviewHash !== requested?.reviewHash) throw denied('Prepared IDs, their current fields or the retained disposition changed after review.'); }
    return transaction(async session => {
      await authorize('operations.recover', session); const run = await load(id, session);
      if (run.applied) {
        if (run.applied.requestKey !== requestKey.toLowerCase() || run.applied.reviewHash !== requested.reviewHash) throw denied('This master plan already has a different saved apply decision.');
        const draft = await models.Versions.findOne({ _id: run.applied.draftId, environment: scope.environment, realmId: scope.realmId, contractVersion: 2 }).session(session).lean();
        if (!draft || draft.contentHash !== run.applied.contentHash) throw denied('The original applied business draft needs recovery.');
        return { run, draft: draftView(draft, scope.connectionId), reused: true };
      }
      const decision = observed;
      validateDraftInput({ ...decision?.input, requestKey });
      recovery.inactive(run);
      const current = await latest(session), expected = masterApplyReview(run, current, decision.ordinals, decision.entries.map((value, index) => ({ proof: value.proof, observedAt: decision.observationTimes[index] })), now());
      if (canonical(expected) !== canonical(decision)) throw denied('Refresh the exact apply review against the current draft.');
      const { policy, writer } = await coordination(session); await touchPolicy(policy, session);
      await recovery.closeRecords(run, writer, session);
      const draft = await writeBlueprintDraft({ ...models, scope, actorId: ownerId, ownerId, input: { ...expected.input, requestKey }, session });
      const applied = { version: 1, requestKey: requestKey.toLowerCase(), reviewHash: decision.reviewHash, review: decision, draftId: String(draft._id), contentHash: draft.contentHash, draftVersion: draft.version, ordinals: decision.ordinals, appliedAt: new Date(now()).toISOString() };
      const disposition = { version: 1, kind: 'applied-subset', ids: run.records.filter(row => row.qboId).map(row => ({ ordinal: row.ordinal, entity: row.entity, qboId: row.qboId, applied: decision.ordinals.includes(row.ordinal), verified: row.state === 'verified' })) };
      const lastAuditId = await audit(run, 'Business master IDs applied to new draft', { ...applied, disposition, qboWrites: 0 }, session);
      const saved = await change(run, { applied, disposition, records: run.records, claim: 'closed', state: 'closed', stopRequested: true, leaseToken: null, leaseExpiresAt: null, lastAuditId }, session);
      return { run: saved, draft: draftView(draft, scope.connectionId), reused: false };
    });
  }
  return { apply, latest, review };
}
module.exports = { masterApplyReview, createMasterApply };
