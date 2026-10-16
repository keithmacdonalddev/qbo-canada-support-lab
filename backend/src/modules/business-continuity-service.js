'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { assertPublishedBusiness, assertAuthorityDocument } = require('./business-authority');
const { MAX_AUTHORITIES, stableBusiness, readAuthorityLineage } = require('./business-authority-lineage');
const { draftView, proposalView, readDraftSetup } = require('./blueprint-draft');
const { activityDefinition, activityTemplateVersion } = require('./business-activity-preview');
const { readBusinessMasters, inspectBusinessMasters, masterRequirements } = require('./business-master-data');
const { checkBlueprintMappings } = require('./blueprint-mapping-check');
const { readCanadianCompany } = require('./business-country');
const { companyActiveWork } = require('./company-active-work');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_CONTINUITY_REQUIRED' }); }
function exact(input, keys) { if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) fail('Use the exact saved business revision and reviewed change.', 400); }
function createBusinessContinuityService({ models, connection, transaction, now, bind, fence, coordination, touchCoordination, readSetup = readDraftSetup, readMasters = readBusinessMasters }) {
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const check = signal => { if (signal?.aborted) fail('Business revision review was cancelled.'); };
  function selection(input) { if (!ID.test(input.blueprintId || '') || !HASH.test(input.blueprintHash || '')) fail('Choose the exact saved business version.', 400); try { date(input.effectiveFrom); } catch { fail('Choose a valid occurrence date.', 400); } }
  async function idle(bound, active, session) {
    const company = { environment: bound.scope.environment, realmId: bound.scope.realmId };
    if (active.calendar.currentOperationId !== null || active.calendar.pendingCommit || !active.calendar.verifiedThrough) fail('Verify an initial business period and finish current work before changing the business.');
    if (await read(models.Runs, { ...company, status: { $nin: ['verified', 'retired'] } }, session)) fail('Finish or explicitly retire every outstanding business plan before changing its definition.');
    if (await read(models.Steps, { ...company, state: { $nin: ['verified'] } }, session)) fail('Unfinished or uncertain business records need recovery before a business revision.');
    if (await read(models.Receipts, { ...company, state: { $in: ['possibly-sent', 'unknown'] } }, session)) fail('Settle every uncertain company request before changing the business.');
    if ((await companyActiveWork(connection.db, bound.scope, { session })).length) fail('Finish other company workers before changing the business.');
  }
  async function completedPeriod(bound, active, lineage, session) {
    const { scope, ownerId } = bound, operationId = String(active.calendar.lastVerifiedOperationId || '');
    if (!ID.test(operationId)) fail('The last verified business period needs its original completion receipt.');
    const run = await read(models.Runs, { _id: operationId, ...scope, status: 'verified' }, session);
    const plan = run && await read(models.Plans, { _id: run.planId, ...scope, operationId, planHash: run.planHash }, session);
    const evidence = run && await read(models.Evidence, { ...scope, operationId, planHash: run.planHash, evidenceRevision: run.evidenceRevision, evidenceHash: run.verificationCandidateHash }, session);
    if (!run || !plan || !evidence || hash(plan.manifest) !== run.planHash || hash(evidence.proof) !== evidence.evidenceHash || run.verification?.evidenceHash !== evidence.evidenceHash || run.throughDate !== active.calendar.verifiedThrough || run.baselineHash !== active.value.baselineHash || !lineage.entries.some(entry => entry.authority.contentHash === run.authorityHash)) fail('The original completed business period is unavailable or differs from the calendar.');
    const { sourceHash, ...source } = evidence.sources || {};
    if (evidence.proof.assertions.some(check => check.sourceHash !== (check.evidenceType === 'record-readback' ? hash(evidence.proof.records) : sourceHash))) fail('The original completed report sources differ from their immutable proof.');
    if (hash(source) !== sourceHash || canonical(source.scope) !== canonical(scope) || canonical(source.period) !== canonical({ fromDate: run.fromDate, throughDate: run.throughDate })) fail('The original completed report sources changed.');
    // Validate at the original observation time: this is retained historical
    // evidence, not a claim that old balances or record versions are current.
    require('./business-period-store').validatePeriodProof(run, evidence.proof, Date.parse(evidence.proof.observedAt));
    const audit = await read(models.Audits, { _id: run.verification.completionAuditId, userId: ownerId, realmId: scope.realmId, action: 'Business operation evidence recorded', outcome: 'success', 'inputParams.eventKey': 'business-period:' + operationId + ':committed' }, session);
    if (!audit || audit.inputParams?.details?.evidenceHash !== evidence.evidenceHash || audit.inputParams.details.throughDate !== run.throughDate || audit.inputParams.details.operationId !== operationId || canonical({ realmId: audit.inputParams.realmId, environment: audit.inputParams.environment, connectionId: audit.inputParams.connectionId }) !== canonical(scope)) fail('The original business completion audit is unavailable.');
    return { operationId, planHash: run.planHash, evidenceHash: evidence.evidenceHash, evidenceRevision: run.evidenceRevision, completionAuditId: String(run.verification.completionAuditId) };
  }
  async function observations(bound, signal) {
    check(signal); const startedAt = now(), client = await bound.access.resolveClient(bound.scope, { signal });
    const setup = await readSetup(client, bound.scope, now); check(signal);
    const masters = await readMasters(client, bound.scope, now); check(signal);
    const { observedAt, ...country } = await readCanadianCompany(client, bound.scope, now); check(signal);
    if (now() < startedAt || now() - startedAt > 180000) fail('Company observations exceeded their review time budget.');
    return { setup, masters, country, startedAt, observedAt: now() };
  }
  async function inspect(bound, input, { session, observed, signal } = {}) {
    selection(input); check(signal);
    const { scope, ownerId } = bound, active = await assertPublishedBusiness({ ...models, scope, session });
    await idle(bound, active, session);
    const state = await coordination(bound, session);
    if (state.policy.state !== 'active') fail('Enable company write coordination before reviewing a continuing business change.');
    const lineage = await readAuthorityLineage({ ...models, scope, head: active.authority, session, verifyBaseline: true });
    const completion = await completedPeriod(bound, active, lineage, session);
    if (lineage.entries.length >= MAX_AUTHORITIES) fail('The complete business revision history has reached its reviewed storage budget.');
    const blueprint = await read(models.Versions, { _id: input.blueprintId, ...scope, contractVersion: 2, contentHash: input.blueprintHash, status: 'draft' }, session);
    if (!blueprint || !blueprint.auditId || hash(blueprint.definition) !== input.blueprintHash || !Number.isSafeInteger(blueprint.version) || blueprint.version <= lineage.entries.at(-1).blueprint.version || input.blueprintHash === active.value.blueprintHash) fail('Choose a newer, changed saved business draft.');
    const draftAudit = await read(models.Audits, { _id: blueprint.auditId, userId: ownerId, realmId: scope.realmId, action: 'Business plan draft saved', outcome: 'success', 'afterState.blueprintId': input.blueprintId, 'afterState.contentHash': input.blueprintHash, 'afterState.environment': scope.environment }, session);
    if (!draftAudit) fail('The original saved business revision audit is unavailable.');
    const view = draftView(blueprint, scope.connectionId); stableBusiness(active.view, view);
    const previousFrom = lineage.segments.at(-1).effectiveFrom;
    if (input.effectiveFrom <= active.calendar.verifiedThrough || input.effectiveFrom <= previousFrom) fail('Choose an occurrence date after verified activity and every earlier business change.');
    if (session && !observed) fail('Retain fresh company observations before accepting the revision.');
    observed ||= await observations(bound, signal); check(signal);
    if (now() < observed.startedAt || now() - observed.startedAt > 180000 || observed.observedAt > now()) fail('Company review observations are stale. Review the change again.');
    const { setup, masters, country } = observed;
    for (const source of [setup, masters, country]) if (['realmId', 'environment', 'connectionId'].some(key => source[key] !== scope[key] && source.scope?.[key] !== scope[key])) fail('Company revision observations differ from the current connection.');
    const mapped = checkBlueprintMappings({ ...scope, draft: view, proposal: proposalView() }, setup, { connectionId: scope.connectionId, baseHash: view.contentHash });
    if (mapped.currency.status !== 'compatible' || !setup.complete || mapped.rows.some(row => { if (!['salesTax', 'purchaseTax'].includes(row.key)) return row.status !== 'compatible'; const code = setup.options.taxCodes.find(value => value.id === row.id), direction = row.key === 'salesTax' ? 'sales' : 'purchases'; return !setup.completeness.taxCodes || code?.active !== true || (code[direction] !== true && code.taxable !== false); }) || inspectBusinessMasters({ ...scope, draft: view, proposal: proposalView() }, masters).unresolved) fail('Resolve all selected accounts, tax codes and business records before reviewing this revision.');
    if (!setup.observations.closingDateVerified) fail('Current QuickBooks closing preferences must be readable.');
    const closing = setup.observations.closedThrough; if (closing) date(closing);
    const cutoff = [state.policy.periodControl.closedThrough, state.policy.periodControl.reconciledThrough, closing].filter(Boolean).sort().at(-1);
    if (cutoff && input.effectiveFrom <= cutoff) fail('This occurrence date is inside a closed or reconciled period through ' + cutoff + '.');
    const review = { version: 1, scope, previousAuthorityHash: active.authority.contentHash, lineageHash: lineage.lineageHash, rootAuthorityHash: lineage.root.authority.contentHash, sequence: lineage.entries.length,
      blueprintId: input.blueprintId, blueprintHash: input.blueprintHash, blueprintVersion: blueprint.version, effectiveFrom: input.effectiveFrom,
      completion, verifiedThrough: active.calendar.verifiedThrough, calendarRevision: active.calendar.revision, calendarWriterRevision: active.calendar.writerRevision, authorityRevision: active.calendar.authorityRevision,
      policyRevision: state.policy.revision, writerRevision: state.writer.revision, periodControlHash: state.policy.periodControl.contentHash, setupHash: setup.sourceHash, masterHash: masters.sourceHash, countryHash: hash(country), qboClosedThrough: closing || null,
      changes: { displayName: { from: active.view.business.displayName, to: view.business.displayName }, volumeProfile: { from: active.view.business.volumeProfile, to: view.business.volumeProfile }, historicalMonths: { from: active.view.business.historicalMonths, to: view.business.historicalMonths }, addedMasterRoles: Object.keys(view.masterBindings || {}).filter(key => !active.view.masterBindings?.[key]).sort().map(key => { const role = masterRequirements(view.business).find(row => row.key === key); if (!role) fail('A newly selected role is outside this business revision.'); const id = view.masterBindings[key], record = masters.options[role.entity].find(row => row.id === id); return { key, entity: role.entity, id, name: record?.name || role.entity + ' #' + id }; }) } };
    return { active, lineage, state, blueprint, view, observed, review, reviewHash: hash(review) };
  }
  async function review(user, input, { signal } = {}) {
    exact(input, ['blueprintId', 'blueprintHash', 'effectiveFrom']); selection(input);
    const bound = await bind(user, 'operations.execute', true), selected = await inspect(bound, input, { signal });
    return { ...bound.scope, review: selected.review, reviewHash: selected.reviewHash, qboWrites: 0, preservesEarlierObligations: true, advancesBusinessCursor: false };
  }
  async function repeated(bound, input, session) {
    const requestHash = hash({ kind: 'business-continuity-v1', input });
    const rows = await models.Authorities.find({ ...bound.scope, 'payload.requestHash': requestHash }).limit(2).session(session).maxTimeMS(3000).lean();
    if (rows.length > 1) fail('The exact business-change request has conflicting terminal receipts.');
    const row = rows[0]; if (!row) return null;
    if (row.payload?.kind === 'continuity-withdrawal') {
      const value = row.payload;
      if (row.contractVersion !== 2 || value.version !== 2 || hash(value) !== row.contentHash || canonical(value.scope) !== canonical(bound.scope) || value.ownerId !== bound.ownerId || String(row.actorId) !== bound.ownerId || value.requestHash !== requestHash || canonical(value.request) !== canonical(input) || typeof value.reason !== 'string' || value.reason.length < 20) fail('The original withdrawal decision changed.');
      const audit = await read(models.Audits, { _id: row.auditId, userId: bound.ownerId, realmId: bound.scope.realmId, action: 'Future business revision withdrawn', outcome: 'success' }, session);
      const expected = { ...bound.scope, requestHash, withdrawalHash: row.contentHash, blueprintHash: input.blueprintHash, effectiveFrom: input.effectiveFrom, qboWrites: 0 };
      if (!audit || audit.actionType !== 'manual' || canonical(audit.afterState) !== canonical(expected)) fail('The original withdrawal audit is unavailable.');
      return { ...bound.scope, applied: false, withdrawn: true, withdrawalHash: row.contentHash, reviewHash: input.reviewHash, effectiveFrom: input.effectiveFrom, reused: true, qboWrites: 0 };
    }
    const value = assertAuthorityDocument(row, bound.scope);
    if (value.version !== 2 || value.ownerId !== bound.ownerId || value.blueprintId !== input.blueprintId || value.blueprintHash !== input.blueprintHash || value.continuity.effectiveFrom !== input.effectiveFrom || value.continuity.reviewHash !== input.reviewHash || value.reviewNote !== input.reason.trim()) fail('The original revision decision differs from this retry.');
    await readAuthorityLineage({ ...models, scope: bound.scope, head: row, session });
    const calendar = await read(models.Calendars, { ...bound.scope }, session);
    if (!calendar) fail('The saved business calendar is unavailable.');
    return { ...bound.scope, applied: true, authorityHash: row.contentHash, reviewHash: input.reviewHash, effectiveFrom: input.effectiveFrom, reused: true, current: calendar.authorityHash === row.contentHash, qboWrites: 0 };
  }
  async function apply(user, input, { signal } = {}) {
    exact(input, ['blueprintId', 'blueprintHash', 'effectiveFrom', 'reviewHash', 'reason']); selection(input);
    if (!HASH.test(input.reviewHash || '') || typeof input.reason !== 'string' || input.reason.trim().length < 30 || input.reason.length > 2000) fail('Record the exact revision review and a reason of at least thirty characters.', 400);
    const bound = await bind(user, 'operations.execute', true), { scope, ownerId, actorId } = bound;
    if (await repeated(bound, input)) return transaction(async session => { await fence(bound, session, 'operations.execute'); return repeated(bound, input, session); });
    try {
    const selected = await inspect(bound, input, { signal });
    if (selected.reviewHash !== input.reviewHash) fail('The reviewed business, calendar or company observations changed. Review the revision again.');
    return await transaction(async session => {
      await fence(bound, session, 'operations.execute'); check(signal);
      const prior = await repeated(bound, input, session); if (prior) return prior;
      const current = await inspect(bound, input, { session, observed: selected.observed, signal });
      if (current.reviewHash !== input.reviewHash) fail('Company authority or work changed after the revision review.');
      const payload = { ...current.active.value, version: 2, blueprintId: input.blueprintId, blueprintHash: input.blueprintHash, activityTemplateVersion: activityTemplateVersion(current.view.business), activityRulesHash: hash(activityDefinition(current.view.business)), requestHash: hash({ kind: 'business-continuity-v1', input }), reviewNote: input.reason.trim(), reviewedAt: new Date(now()).toISOString(),
        continuity: { version: 1, sequence: current.lineage.entries.length, parentAuthorityHash: current.active.authority.contentHash, rootAuthorityHash: current.lineage.root.authority.contentHash, effectiveFrom: input.effectiveFrom, reviewHash: input.reviewHash, review: current.review } };
      const contentHash = hash(payload), auditId = hash({ businessContinuity: contentHash }).slice(0, 24);
      if (Buffer.byteLength(canonical(payload)) > 1000000) fail('The business revision exceeds its retained evidence budget.');
      await touchCoordination(bound, current.state, session);
      const calendar = current.active.calendar;
      const saved = await models.Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, authorityHash: calendar.authorityHash, authorityRevision: calendar.authorityRevision, revision: calendar.revision, writerRevision: calendar.writerRevision, verifiedThrough: calendar.verifiedThrough, currentOperationId: null, pendingCommit: null, 'baseline.evidenceHash': calendar.baseline.evidenceHash, 'baseline.observedAt': calendar.baseline.observedAt }, { $set: { blueprintId: input.blueprintId, blueprintHash: input.blueprintHash, authorityHash: contentHash }, $inc: { revision: 1, writerRevision: 1, authorityRevision: 1 } }, { new: true, session }).lean();
      if (!saved) fail('The exact reviewed calendar changed during the business revision.');
      await models.Authorities.create([{ _id: hash({ scope, contentHash }).slice(0, 24), contractVersion: 2, ...scope, contentHash, payload, actorId, auditId }], { session });
      await models.Audits.create([{ _id: auditId, userId: ownerId, realmId: scope.realmId, action: 'Future business revision accepted', actionType: 'manual', outcome: 'success', beforeState: current.review,
        afterState: { ...scope, authorityHash: contentHash, parentAuthorityHash: current.active.authority.contentHash, blueprintHash: input.blueprintHash, baselineHash: payload.baselineHash, inventoryHash: payload.inventoryHash, reviewHash: input.reviewHash, effectiveFrom: input.effectiveFrom, verifiedThrough: calendar.verifiedThrough, qboWrites: 0 } }], { session });
      return { ...scope, applied: true, authorityHash: contentHash, reviewHash: input.reviewHash, effectiveFrom: input.effectiveFrom, reused: false, current: true, qboWrites: 0 };
    });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Another browser may withdraw or finish this exact request while its
      // observations are running. Prefer its durable terminal receipt.
      const terminal = await transaction(async session => { await fence(bound, session, 'operations.execute'); return repeated(bound, input, session); });
      if (terminal) return terminal;
      throw error;
    }
  }
  async function withdraw(user, input) {
    exact(input, ['request', 'reason']);
    const request = input.request; exact(request, ['blueprintId', 'blueprintHash', 'effectiveFrom', 'reviewHash', 'reason']); selection(request);
    if (!HASH.test(request.reviewHash || '') || typeof request.reason !== 'string' || request.reason.trim().length < 30 || request.reason.length > 2000 || typeof input.reason !== 'string' || input.reason.trim().length < 20 || input.reason.length > 2000) fail('Choose the exact pending request and explain its withdrawal.', 400);
    const bound = await bind(user, 'operations.execute', true), { scope, ownerId, actorId } = bound;
    return transaction(async session => {
      await fence(bound, session, 'operations.execute');
      const prior = await repeated(bound, request, session); if (prior) return prior;
      // No idle/head requirement: an obsolete unconfirmed request still needs
      // a terminal decision. This shared revision fence prevents late apply.
      const policy = await read(models.Policies, { ...scope }, session);
      if (!policy || policy.contractVersion !== 1 || !['active', 'preparing'].includes(policy.state) || !Number.isSafeInteger(policy.revision) || policy.revision < 0 || policy.revision >= Number.MAX_SAFE_INTEGER) fail('Restore the current company coordination before withdrawing this request.');
      const fenced = await models.Policies.findOneAndUpdate({ _id: policy._id, ...scope, state: policy.state, revision: policy.revision }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!fenced) fail('Company decisions changed during withdrawal. Retry the exact request.');
      const requestHash = hash({ kind: 'business-continuity-v1', input: request }), payload = { version: 2, kind: 'continuity-withdrawal', scope, ownerId, requestHash, request, reason: input.reason.trim(), withdrawnAt: new Date(now()).toISOString() }, contentHash = hash(payload), auditId = hash({ businessContinuityWithdrawal: contentHash }).slice(0, 24);
      await models.Authorities.create([{ _id: hash({ scope, businessContinuityWithdrawal: requestHash }).slice(0, 24), contractVersion: 2, ...scope, contentHash, payload, actorId, auditId }], { session });
      await models.Audits.create([{ _id: auditId, userId: ownerId, realmId: scope.realmId, action: 'Future business revision withdrawn', actionType: 'manual', outcome: 'success', beforeState: { requestHash, reason: input.reason.trim() }, afterState: { ...scope, requestHash, withdrawalHash: contentHash, blueprintHash: request.blueprintHash, effectiveFrom: request.effectiveFrom, qboWrites: 0 } }], { session });
      return { ...scope, applied: false, withdrawn: true, withdrawalHash: contentHash, reviewHash: request.reviewHash, effectiveFrom: request.effectiveFrom, reused: false, qboWrites: 0 };
    });
  }
  return { review, apply, withdraw };
}
module.exports = { createBusinessContinuityService };
