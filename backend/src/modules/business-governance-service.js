'use strict';
const { hash, canonical, date, shift } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { createContextService } = require('./rebuild-context');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessStorageReadiness } = require('./business-runtime-storage');
const { createBusinessTransaction } = require('./business-transaction');
const { createBusinessAuditWriter } = require('./business-runtime-audit');
const { createBusinessOperationPlanStore } = require('./business-operation-plan-store');
const { validateBaselineObservation } = require('./business-baseline');
const { evaluateReportSources } = require('./book-evidence');
const { unpackReport, unpackReports } = require('./business-report-source');
const { canonicalReportCollection } = require('./report-json');
const { retainApprovalReports, readApprovalReports } = require('./business-approval-report-evidence');
const { createBusinessInventoryReader, validateInventoryObservation } = require('./business-record-inventory');
const { createBusinessReportReader } = require('./business-report-evidence');
const { assertPeriodControl } = require('./qbo-write-period');
const { financialSummary, reportComplete } = require('./business-financial-summary');
const { createIncomeExpectation } = require('./business-income-evidence');
const { createFinancialExpectation } = require('./business-financial-movements');
const { readCanadianCompany } = require('./business-country');
const { assertPublishedBusiness, assertAuthorityDocument, readPublishedBusiness } = require('./business-authority');
const { draftView, proposalView, readDraftSetup } = require('./blueprint-draft');
const { activityDefinition, activityTemplateVersion, assertActivityTemplateAccepted, businessDate } = require('./business-activity-preview');
const { readBusinessMasters, inspectBusinessMasters } = require('./business-master-data');
const { checkBlueprintMappings } = require('./blueprint-mapping-check');
const { validateOperationRequest, prepareBusinessOperation, operationHistoryRoots } = require('./business-operation-preview');
const { bindPreparedOperationReferences } = require('./business-preparation-references');
const { assembleBusinessOperation, bindApprovedOperationPolicies } = require('./business-operation-candidate');
const { deriveBusinessPolicies } = require('./business-tax-policy');
const { createBusinessOperationRetirement } = require('./business-operation-retirement');
const { createBusinessOperationRecovery } = require('./business-operation-recovery');
const { createBusinessUnknownRecovery } = require('./business-unknown-recovery');
const { createBusinessPolicyAmendment } = require('./business-policy-amendment');
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_GOVERNANCE_REQUIRED' }); }
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function exact(input, keys) { if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) fail('Use the exact reviewed action without company or state overrides.', 400); }
function reportHash(source) {
  const reports = Object.fromEntries(Object.entries(unpackReports(source)).map(([name, report]) => {
    const copy = structuredClone(report); delete copy.Header?.Time; return [name, copy];
  }));
  return require('node:crypto').createHash('sha256').update(canonicalReportCollection(reports)).digest('hex');
}
function createBusinessGovernanceService(dependencies = {}) {
  const connection = dependencies.connection || require('mongoose').connection;
  const models = dependencies.models || { ...require('./business-runtime').loadModels(), Authorities: require('../models/BusinessAuthority'), Candidates: require('../models/BusinessCandidate'), Versions: require('../models/BlueprintVersion'), Baselines: require('../models/BusinessBaseline') };
  const transaction = dependencies.transaction || createBusinessTransaction(connection), now = dependencies.now || (() => Date.now());
  const assertReady = dependencies.assertReady || createBusinessStorageReadiness({ connection, models });
  const resolve = dependencies.resolveContext || createContextService().resolve;
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function bind(user, action = 'operations.read', ownerOnly = false) {
    const ownerId = String(user.id), actorId = String(user.actorId || user.id), context = await resolve(user);
    if (!context.connection?.connected) fail('Connect the company before maintaining its business.');
    const scope = scoped({ environment: context.environment, realmId: context.connection.realmId, connectionId: context.connection.connectionId });
    const access = (dependencies.accessFor || createBusinessRuntimeAccess)({ actorId, ownerId, ...models });
    await access.authorize(scope, action); await assertReady();
    if (ownerOnly && ownerId !== actorId) fail('Only the connected company owner can publish or approve business activity.', 403);
    return { scope, access, ownerId, actorId, companyName: context.connection.companyName };
  }
  async function fence(bound, session, action) {
    const { scope, access, actorId, ownerId } = bound;
    const actor = await access.authorize(scope, action, { session });
    if (actor?.actorId !== actorId || actor.ownerId !== ownerId) fail('Business authority changed.');
    for (const id of new Set([ownerId, actorId])) if ((await models.Users.updateOne({ _id: id, role: { $in: ['agent', 'supervisor'] } }, { $inc: { connectionSwitchVersion: 1 } }, { session })).matchedCount !== 1) fail('The business workspace changed.');
    const member = await models.Memberships.updateOne({ userId: actorId, realmId: scope.realmId, status: 'active' }, { $inc: { businessSetupVersion: 1 } }, { session });
    const selected = await models.Connections.updateOne({ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }, { $inc: { businessSetupVersion: 1 } }, { session });
    if (member.matchedCount !== 1 || selected.matchedCount !== 1) fail('Current company access changed.');
  }
  async function touchCoordination(bound, state, session) {
    const { scope } = bound;
    const policy = await models.Policies.findOneAndUpdate({ _id: state.policy._id, ...scope, revision: state.policy.revision, state: state.policy.state }, { $inc: { revision: 1 } }, { new: true, session }).lean();
    const writer = await models.Writers.findOneAndUpdate({ _id: state.writer._id, ...scope, revision: state.writer.revision, operationId: null, planHash: null, unresolved: null }, { $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!policy || !writer) fail('Company activity changed during this decision.');
  }
  async function coordination(bound, session) {
    const { scope, ownerId } = bound, company = { environment: scope.environment, realmId: scope.realmId };
    const policy = await read(models.Policies, company, session), writer = await read(models.Writers, company, session);
    if (!policy || !writer || writer.populationDelegation || String(policy.connectionId) !== scope.connectionId || String(writer.connectionId) !== scope.connectionId || !['preparing', 'active'].includes(policy.state) || writer.operationId !== null || writer.planHash !== null || writer.unresolved !== null) fail('Prepare company write coordination and settle current work first.');
    assertPeriodControl(policy.periodControl, scope, ownerId);
    return { policy, writer };
  }
  async function baselineReview(bound, input, session) {
    if (!ID.test(input.baselineId || '') || !HASH.test(input.blueprintHash || '')) fail('Choose the saved business and exact opening observation.', 400);
    const { scope, ownerId } = bound, baseline = await read(models.Baselines, { _id: input.baselineId, ...scope, ownerId }, session);
    const checked = validateBaselineObservation(baseline);
    const audit = await read(models.Audits, { _id: baseline.auditId, userId: ownerId, realmId: scope.realmId, action: 'Business baseline observation saved', outcome: 'success', 'afterState.evidenceHash': baseline.evidenceHash, 'afterState.sourceHash': baseline.payload.sourceHash, 'afterState.inventoryHash': baseline.inventorySources.sourceHash }, session);
    if (!audit) fail('The retained opening observation audit is unavailable.');
    const acceptanceEvaluation = evaluateReportSources(baseline.sources, { allowExplicitZero: true });
    if (![2, 3].includes(baseline.sources.version) || baseline.contractVersion !== 2 || checked.payload.purpose !== 'opening-balances' || checked.payload.blueprint.contentHash !== input.blueprintHash || acceptanceEvaluation.status !== 'checks-passed') fail('A complete opening observation with all accounting checks is required.');
    const blueprint = await read(models.Versions, { _id: checked.payload.blueprint.id, ...scope, contractVersion: 2, contentHash: input.blueprintHash }, session);
    if (!blueprint || !blueprint.auditId || hash(blueprint.definition) !== input.blueprintHash || checked.payload.period.throughDate !== shift(blueprint.definition.calendar.openingDate, -1)) fail('The opening evidence does not match this saved business.');
    const { policy, writer } = await coordination(bound, session), view = draftView(blueprint, scope.connectionId), definition = activityDefinition(view.business);
    assertActivityTemplateAccepted(view.business, scope);
    const review = { version: 1, scope, blueprintId: String(blueprint._id), blueprintHash: input.blueprintHash, baselineId: input.baselineId, baselineHash: baseline.evidenceHash, inventoryHash: hash(baseline.inventorySources.records), openingDate: view.business.openingDate, businessKey: definition.businessKey, activityTemplateVersion: activityTemplateVersion(view.business), activityRulesHash: hash(definition), periodControlHash: policy.periodControl.contentHash, policyRevision: policy.revision, writerRevision: writer.revision,
      recordCount: checked.payload.inventory.count, existingOnOrAfterOpening: Object.values(baseline.inventorySources.records).flat().filter(row => row.transactionDate >= view.business.openingDate).length,
      financialSummary: financialSummary(baseline.sources, acceptanceEvaluation), reportChecks: acceptanceEvaluation.checks, observedAt: checked.payload.observedAt };
    return { review, reviewHash: hash(review), baseline, blueprint, policy, writer };
  }
  async function publicationSetup(bound, selected) {
    const { scope, access } = bound, client = await access.resolveClient(scope), view = { ...scope, draft: draftView(selected.blueprint, scope.connectionId), proposal: proposalView() };
    const setup = await (dependencies.readSetup || readDraftSetup)(client, scope, now), masters = await (dependencies.readMasters || readBusinessMasters)(client, scope, now);
    const mappings = checkBlueprintMappings(view, setup, { connectionId: scope.connectionId, baseHash: view.draft.contentHash });
    if (mappings.currency.status !== 'compatible' || mappings.rows.some(row => {
      if (!['salesTax', 'purchaseTax'].includes(row.key)) return row.status !== 'compatible';
      const code = setup.options.taxCodes.find(value => value.id === row.id), direction = row.key === 'salesTax' ? 'sales' : 'purchases';
      return !setup.completeness.taxCodes || code?.active !== true || (code[direction] !== true && code.taxable !== false);
    }) || inspectBusinessMasters(view, masters).unresolved) fail('Resolve every required account, tax code and business record choice before publication.');
    const closing = setup.observations.closedThrough;
    if (closing !== null && closing !== undefined) date(closing);
    const cutoff = [selected.policy.periodControl.closedThrough, selected.policy.periodControl.reconciledThrough, closing].filter(Boolean).sort().at(-1);
    if (cutoff && selected.review.openingDate <= cutoff) fail('Business opening is inside a closed or reconciled period through ' + cutoff + '. Review and reopen that history explicitly before publication, or choose a later opening.');
    const company = await readCanadianCompany(client, scope, now, { fiscalCalendar: view.draft.business.stockCosting !== undefined });
    const { observedAt: companyObservedAt, ...companyEvidence } = company;
    const dated = await require('./business-dated-tax').readDatedTaxEvidence(view.draft.business, view.draft.mappings, client, now());
    const datedTaxEvidence = dated ? (({ observedAt, ...retained }) => retained)(dated) : null;
    const stockRoot = view.draft.business.stockCosting === undefined ? null : await require('./business-stock-root').buildStockRoot({ models, scope, ownerId: bound.ownerId, view: view.draft, baseline: selected.baseline, company, stockObservation: await (dependencies.readStockRoot || createBusinessInventoryReader({ access, now, stockMetadata: true, version: selected.baseline.inventorySources.version }))(scope), now: now() });
    return { ...(stockRoot ? { stockRoot } : {}), ...(datedTaxEvidence ? { datedTaxEvidence } : {}), setupHash: setup.sourceHash, masterHash: masters.sourceHash, qboClosedThrough: closing || null, country: 'CA', companyEvidence };
  }
  async function publicationSelection(bound, input) {
    const selected = await baselineReview(bound, input), setup = await publicationSetup(bound, selected);
    const calendar = await read(models.Calendars, { environment: bound.scope.environment, realmId: bound.scope.realmId });
    const review = { ...selected.review, ...setup, replacesAuthorityHash: calendar?.authorityHash || null };
    return { ...selected, coreReviewHash: selected.reviewHash, review, reviewHash: hash(review) };
  }
  async function status(user) {
    const bound = await bind(user), { scope } = bound;
    let calendar = await read(models.Calendars, { ...scope });
    let authority = calendar?.authorityHash ? await read(models.Authorities, { ...scope, contentHash: calendar.authorityHash }) : null;
    if (authority) { assertAuthorityDocument(authority, scope); if (authority.payload.version === 2) ({ authority, calendar } = await readPublishedBusiness({ ...models, scope })); }
    const pendingOperations = await models.Runs.find({ ...scope, authorityHash: calendar?.authorityHash || null, status: 'previewed' }).sort({ createdAt: -1, _id: -1 }).limit(20).maxTimeMS(3000).lean();
    const currentRun = calendar?.currentOperationId ? await read(models.Runs, { _id: calendar.currentOperationId, ...scope }) : null;
    return { ...scope, currentOperation: currentRun ? { operationId: String(currentRun._id), planHash: currentRun.planHash, status: currentRun.status } : null, canReviseBeforeActivity: Boolean(calendar && calendar.verifiedThrough === null && calendar.currentOperationId === null && !await read(models.Steps, { environment: scope.environment, realmId: scope.realmId })), pendingOperations: pendingOperations.map(run => ({ operationId: String(run._id), planHash: run.planHash, fromDate: run.fromDate, throughDate: run.throughDate, recordCount: run.recordCount, ...(run.activityBatch ? { activityBatch: { day: run.activityBatch.day, purpose: run.activityBatch.purpose } } : {}) })), companyName: bound.companyName, owner: bound.actorId === bound.ownerId, published: authority ? { contentHash: authority.contentHash, ...authority.payload } : null,
      calendar: calendar ? { openingDate: calendar.openingDate, verifiedThrough: calendar.verifiedThrough, adoptedThrough: require('./business-calendar').calendarCursor(calendar).adoptedThrough, revision: calendar.revision, currentOperationId: calendar.currentOperationId ? String(calendar.currentOperationId) : null, stopRequested: calendar.stopRequested, completionPending: Boolean(calendar.pendingCommit) } : null,
      limitation: 'Accepted opening evidence starts the managed calendar. It does not certify all existing records, business realism or bank reconciliation.' };
  }
  async function reviewPublication(user, input) {
    exact(input, ['blueprintHash', 'baselineId']); const bound = await bind(user, 'operations.execute', true);
    const { review, reviewHash } = await publicationSelection(bound, input);
    return { review, reviewHash, qboWrites: 0, disposition: 'Retain every existing record as unmanaged. No existing transaction is adopted, edited or removed. Review existing balances and overlapping history before accepting this starting point.' };
  }
  async function publish(user, input, { signal } = {}) {
    exact(input, ['blueprintHash', 'baselineId', 'reviewHash', 'reviewNote', 'ownershipDisposition']);
    if (!HASH.test(input.reviewHash || '') || input.ownershipDisposition !== 'retain-unmanaged' || typeof input.reviewNote !== 'string' || input.reviewNote.trim().length < 30 || input.reviewNote.length > 2000) fail('Review the retained records and starting balances, then record your explicit acceptance.', 400);
    const bound = await bind(user, 'operations.execute', true), { scope, ownerId, actorId, access } = bound;
    const requestHash = hash(input), existing = await read(models.Authorities, { ...scope, 'payload.requestHash': requestHash });
    if (existing) { assertAuthorityDocument(existing, scope); return { published: true, authorityHash: existing.contentHash, reused: true }; }
    const selected = await publicationSelection(bound, input);
    if (selected.reviewHash !== input.reviewHash) fail('The reviewed opening evidence or company state changed. Review it again.');
    if (selected.review.financialSummary.blockers.length) fail('Resolve the listed opening-balance anomalies and report gaps before publication. A general acceptance note does not resolve them.');
    const inventory = await (dependencies.readInventory || createBusinessInventoryReader({ access, now, version: selected.baseline.inventorySources.version }))(scope, { signal });
    validateInventoryObservation(inventory, scope);
    const reports = await (dependencies.readReports || createBusinessReportReader({ access, now, purpose: 'baseline' }))(scope, selected.baseline.payload.period, { signal });
    if (hash(inventory.records) !== selected.review.inventoryHash || reportHash(reports) !== reportHash(selected.baseline.sources)) fail('The company changed since the opening observation. Capture and review it again.');
    const payload = { ...selected.review, status: 'published', ownerId, requestHash, ownershipDisposition: input.ownershipDisposition, reviewNote: input.reviewNote.trim(), reviewedAt: new Date(now()).toISOString() }, contentHash = hash(payload), auditId = hash({ publication: contentHash }).slice(0, 24);
    return transaction(async session => {
      await fence(bound, session, 'operations.execute');
      const repeated = await read(models.Authorities, { ...scope, 'payload.requestHash': requestHash }, session);
      if (repeated) return { published: true, authorityHash: repeated.contentHash, reused: true };
      const current = await baselineReview(bound, input, session);
      if (current.reviewHash !== selected.coreReviewHash) fail('The business evidence changed. Review publication again.');
      if (payload.stockRoot) await require('./business-stock-root').assertStockRootOrigins(models, payload.stockRoot, ownerId, session);
      const calendar = await read(models.Calendars, { environment: scope.environment, realmId: scope.realmId }, session);
      if (calendar && (calendar.authorityHash !== selected.review.replacesAuthorityHash || String(calendar.connectionId) !== scope.connectionId || calendar.verifiedThrough !== null || calendar.currentOperationId !== null || calendar.pendingCommit !== null || calendar.openingDate !== payload.openingDate || calendar.businessKey !== payload.businessKey || await read(models.Steps, { environment: scope.environment, realmId: scope.realmId }, session))) fail('An existing business calendar has activity and requires a reviewed continuity change; it was not replaced.');
      const policyFence = await models.Policies.findOneAndUpdate({ _id: current.policy._id, ...scope, revision: selected.policy.revision }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      const writerFence = await models.Writers.findOneAndUpdate({ _id: current.writer._id, ...scope, revision: selected.writer.revision, operationId: null, planHash: null, unresolved: null }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!policyFence || !writerFence || signal?.aborted) fail('Company activity changed during publication.');
      await models.Authorities.create([{ _id: hash({ scope, contentHash }).slice(0, 24), contractVersion: 1, ...scope, contentHash, payload, actorId, auditId }], { session });
      const calendarValues = { ...scope, blueprintId: payload.blueprintId, blueprintHash: payload.blueprintHash, authorityHash: contentHash, baseline: { status: 'verified', evidenceHash: payload.baselineHash, observedAt: new Date(now()) } };
      if (calendar) {
        const replaced = await models.Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, authorityHash: calendar.authorityHash, authorityRevision: calendar.authorityRevision, verifiedThrough: null, currentOperationId: null, pendingCommit: null }, { $set: calendarValues, $inc: { authorityRevision: 1 } }, { new: true, session }).lean();
        if (!replaced) fail('The untouched business calendar changed during publication.');
      } else await models.Calendars.create([{ _id: scope.environment + ':' + scope.realmId, contractVersion: 1, ...calendarValues, businessKey: payload.businessKey, openingDate: payload.openingDate, authorityRevision: 0, verifiedThrough: null, revision: 0, writerRevision: 0, currentOperationId: null, stopRequested: false, pendingCommit: null }], { session });
      await models.Audits.create([{ _id: auditId, userId: ownerId, realmId: scope.realmId, action: 'Business published and opening evidence accepted', actionType: 'manual', outcome: 'success', afterState: { ...scope, authorityHash: contentHash, blueprintHash: payload.blueprintHash, baselineHash: payload.baselineHash, inventoryHash: payload.inventoryHash, ownershipDisposition: payload.ownershipDisposition, qboWrites: 0, verifiedThrough: null, bankReconciled: false } }], { session });
      return { published: true, authorityHash: contentHash, reused: false };
    });
  }
  function planStore(bound, reportFence) {
    const { scope, access, actorId, ownerId } = bound;
    const writeAudit = createBusinessAuditWriter({ scope, actorId, ownerId, Audits: models.Audits, transaction, access });
    const checkCurrent = async ({ manifest, operationId, planHash, session }) => {
      await fence(bound, session, 'operations.execute');
      const state = await assertPublishedBusiness({ ...models, scope, requireScheduleAcceptance: true, manifest, session, fence: true });
      if (state.calendar.currentOperationId !== null) fail('An existing operation owns the calendar.');
      if (manifest.stockCostExpectation) await require('./business-stock-history').assertFrozenStockOpening(models, state, manifest.stockCostExpectation, session);
      const current = await coordination(bound, session);
      if (current.policy.state !== 'active') fail('Enable company write coordination first.');
      if (!reportFence || reportFence.operationId !== operationId || reportFence.planHash !== planHash || canonical(reportFence.scope) !== canonical(scope) || canonical(reportFence.period) !== canonical({ fromDate: manifest.fromDate, throughDate: manifest.throughDate }) || !HASH.test(reportFence.sourceHash || '') || now() < reportFence.observedAt || now() - reportFence.startedAt > 300000 || reportFence.policyRevision !== current.policy.revision || reportFence.writerRevision !== current.writer.revision || reportFence.calendarRevision !== state.calendar.revision || reportFence.authorityRevision !== state.calendar.authorityRevision || reportFence.calendarWriterRevision !== state.calendar.writerRevision || reportFence.authorityHash !== state.authority.contentHash) fail('The fresh seven-report approval observation or company state changed. Review approval again.');
      const reportEvidence = await retainApprovalReports({ models, scope, operationId, planHash, actorId, ownerId, sources: reportFence.sources, session, now: now() });
      await touchCoordination(bound, current, session);
      return { reportEvidence, scope, operationId, planHash, actorId, expectedRevision: manifest.expectedRevision, fenceHash: hash({ authorityHash: state.authority.contentHash, manifest, periodControlHash: current.policy.periodControl.contentHash, reportSourceHash: reportFence.sourceHash }) };
    };
    return createBusinessOperationPlanStore({ ...models, agentAuthority: dependencies.agentAuthority, agentLease: dependencies.agentLease || null, Agents: dependencies.Agents, transaction, authorize: access.authorize, assertReady, now, writeAudit, checkCurrent, verifyApproval: ({ run, session }) => readApprovalReports({ models, run, ownerId, session }), loadCandidate: async (_scope, candidateHash, session) => {
      const row = await read(models.Candidates, { ...scope, candidateHash }, session);
      if (!row || hash(row.payload) !== candidateHash || !row.auditId) fail('The exact server-prepared candidate is unavailable.');
      await assertPublishedBusiness({ ...models, scope, requireScheduleAcceptance: true, manifest: row.payload, session, fence: true });
      return row.payload;
    } });
  }
  async function prepare(user, input, { signal, batchChoices = null } = {}) {
    if (batchChoices) batchChoices = require('./business-activity-batch').validateChoices(batchChoices);
    exact(input, ['requestKey', 'throughDate']);
    if (typeof input.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestKey)) fail('Use one retained preparation request identifier.', 400);
    date(input.throughDate);
    const bound = await bind(user, 'operations.preview'), { scope, access, ownerId, actorId } = bound;
    // Lost-response retries return the original saved candidate before new reads.
    const operationId = hash({ scope, actorId, requestKey: input.requestKey }).slice(0, 24), existing = await read(models.Runs, { _id: operationId, ...scope });
    if (existing) {
      if (dependencies.agentAuthority && (!existing.agentAuthority || !require('./business-agent-authority').sameAuthority(existing.agentAuthority, dependencies.agentAuthority))) fail('This preparation belongs to a different agent authorization.');
      if (existing.status === 'retired') fail('This preparation was retired. Prepare with a new request identifier.');
      const saved = await read(models.Plans, { _id: existing.planId, ...scope });
      if (!saved || saved.manifest.throughDate !== input.throughDate || String(saved.createdBy) !== actorId || Boolean(saved.manifest.activityBatch) !== Boolean(batchChoices) || (batchChoices && saved.manifest.activityBatch.requestHash !== hash(batchChoices))) fail('This request identifier belongs to different work.');
      return { operationId, planHash: existing.planHash, status: existing.status, reused: true };
    }
    const active = await assertPublishedBusiness({ ...models, scope, requireScheduleAcceptance: true, verifyBaseline: true }), current = await coordination(bound);
    if (current.policy.state !== 'active' || active.calendar.currentOperationId !== null) fail('Enable write coordination and finish the current operation first.');
    const fromDate = active.calendar.verifiedThrough ? shift(active.calendar.verifiedThrough, 1) : active.value.openingDate;
    const request = validateOperationRequest({ connectionId: scope.connectionId, baseHash: active.value.blueprintHash, fromDate, throughDate: input.throughDate });
    if (request.throughDate > businessDate(new Date(now()))) fail('Prepare only elapsed business days.', 400);
    const cutoff = [current.policy.periodControl.closedThrough, current.policy.periodControl.reconciledThrough].filter(Boolean).sort().at(-1);
    if (cutoff && fromDate <= cutoff) fail('The next business period is protected. Review historical periods before backfilling.');
    const client = await access.resolveClient(scope, { signal });
    await readCanadianCompany(client, scope, now);
    const view = { ...scope, draft: active.view, proposal: proposalView() };
    const setup = await (dependencies.readSetup || readDraftSetup)(client, scope, now), masters = await (dependencies.readMasters || readBusinessMasters)(client, scope, now);
    // General governed writes (general-write-v1) dated in this period, and history edits
    // inside verified history, must pass their day-close check before the calendar moves.
    // A composition without general-write storage (an isolated fixture) has no general writes.
    const generalGate = dependencies.generalCloseGate || (!dependencies.models || models.GeneralWriteRuns ? require('./general-write-close-gate').createGeneralCloseGate({ models: dependencies.models ? { GeneralWriteRuns: models.GeneralWriteRuns, GeneralDayCloses: models.GeneralDayCloses, Records: models.Records } : {}, copy: { read: async (s, entity, id) => (await require('./business-observation-store').createBusinessObservationStore({ now }).read(s, entity, id))?.record || (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity] || null }, now }) : null);
    if (!batchChoices && generalGate) await generalGate.assertPeriodReady(scope, { fromDate, throughDate: request.throughDate, verifiedThrough: active.calendar.verifiedThrough, openingDate: active.value.openingDate, mappings: active.view.mappings || {}, readLedger: (from, through) => client.apiCall('GET', require('./general-write-day-close').ledgerEndpoint(from, through)) });
    let prepared;
    if (batchChoices) {
      const batchTools = require('./business-activity-batch');
      const batch = batchTools.makeActivityBatch({ scope, businessKey: active.value.businessKey, day: input.throughDate, choices: batchChoices });
      batchTools.assertBatchPreparation(active, batch, now());
      await checkAdoptedSettlements(scope, active, batch, client);
      const receiving = batch.activities.filter(row => row.type === 'receive-purchase-order');
      if (receiving.length && !active.value.stockRoot) fail('Receiving needs the published FIFO stock-cost evidence.');
      if (batch.activities.some(row => row.type === 'order-stock') && !active.value.stockRoot) fail('Ordering stock needs the published FIFO stock-cost evidence, so the order can later be received.');
      const receiptReader = require('./business-purchase-order-receipt').createPurchaseOrderReceiptReader({ models, history: planStore(bound).history, readRecord: async (scope, entity, id) => { const record = (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity]; return { scope, entity, record, recordHash: hash(record), observedAt: new Date(now()).toISOString() }; }, now });
      for (const choice of receiving) require('./business-purchase-order-receipt').assertChoice(choice, await receiptReader(scope, choice, { signal }), active.view.masterBindings);
      // Accountant-added roles: new names must be free; roles used must be verified,
      // unchanged since creation, and created by an earlier (verified) batch.
      // Additions go in their own batch, within the registry's remaining capacity.
      const addedRoles = require('./business-added-roles'); addedRoles.assertListOnlyBatch(batch);
      const registry = await addedRoles.listAddedRoles(models, scope, ownerId); addedRoles.assertCapacity(registry, batch);
      await addedRoles.assertNamesAvailable({ batch, registry, query: text => client.query(text) });
      const usedRoles = await addedRoles.resolveBatchRoles({ registry, batch, scope, readRecord: async (entity, id) => (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity] });
      // Corrections (policy v7): every term re-derived from the accountant's own original
      // and every eligibility rule proved before a plan is saved (business-correction.js).
      if (batch.activities.some(row => row.type === 'correct-own-record')) {
        const cutoff = [current.policy.periodControl.closedThrough, current.policy.periodControl.reconciledThrough, setup.observations?.closedThrough].filter(Boolean).sort().at(-1) || null;
        await require('./business-correction').assertCorrectionsEligible({ models, scope, ownerId, businessKey: active.value.businessKey, batch, history: planStore(bound).history, readRecord: async (entity, id) => (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity], cutoff, setup });
      }
      // Collections, payments and estimate conversions of own records (policy v8): the original re-derived
      // and its open balance, ownership and freedom from other work proved before saving.
      if (batch.activities.some(row => batchTools.OWN_SOURCED[row.type])) await require('./business-own-settlement').assertOwnSettlementsEligible({ models, scope, ownerId, businessKey: active.value.businessKey, batch, history: planStore(bound).history, readRecord: async (entity, id) => (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity] });
      const activity = batchTools.buildBatchActivity(batch, scope, active.value.businessKey);
      prepared = prepareBusinessOperation(view, request, setup, masters, new Date(now()), activity, usedRoles);
      prepared.activityBatch = batch;
      if (active.lineage) {
        const segment = active.lineage.segments.filter(row => row.effectiveFrom <= batch.day).at(-1);
        if (segment?.authorityHash !== active.authority.contentHash) fail('Additional activity must use the business revision already in effect today.');
        // Each origin names the revision in effect at its occurrence: today for new
        // activity, the original's date for a correction (whose identity it keeps).
        const segmentOf = occurrence => active.lineage.segments.filter(row => row.effectiveFrom <= occurrence).at(-1);
        if (activity.events.some(event => !segmentOf(event.occurrence))) fail('A correction names a record from before the business revision history.');
        prepared.continuity = { version: 1, authorityHash: active.authority.contentHash, lineageHash: active.lineage.lineageHash, segments: active.lineage.segments, origins: activity.events.map(event => ({ logicalKey: event.logicalKey, authorityHash: segmentOf(event.occurrence).authorityHash, blueprintId: segmentOf(event.occurrence).blueprintId, blueprintHash: segmentOf(event.occurrence).blueprintHash, occurrence: event.occurrence, ruleKey: event.ruleKey, stepKey: event.stepKey })).sort((a,b) => a.logicalKey.localeCompare(b.logicalKey)) };
      }
    } else prepared = active.lineage ? require('./business-continuity-plan').prepareContinuingBusiness(active, scope, request, setup, masters, new Date(now())) : prepareBusinessOperation(view, request, setup, masters, new Date(now()));
    if (!batchChoices) prepared = await require('./business-received-order-calendar').replaceReceivedOrderBills({ models, scope, prepared, activity: require('./business-activity-preview').previewBusinessActivity(view, request, businessDate(new Date(now()))), history: planStore(bound).history });
    // A corrected original is no longer collected or paid: its unsent scheduled
    // follow-ups are not prepared (derived from durable step evidence each time).
    if (!batchChoices) prepared = await require('./business-correction').suppressCorrectedFollowUps({ models, scope, businessKey: active.value.businessKey, prepared });
    // Forward cutover after adopted import history: scheduled follow-ups of
    // imported (adopted) occurrences are not managed calendar work. They and
    // anything depending on them are excluded and retained as inherited, so no
    // write ever depends on an unverified imported record.
    const adoptedThrough = require('./business-calendar').calendarCursor(active.calendar).adoptedThrough || active.calendar.adoption?.through || null;
    if (adoptedThrough && !batchChoices) {
      if (active.lineage) fail('A republished business cannot yet continue from adopted import history.');
      // Inherited: dated on/before adoption, or (after adoption) never saved because an
      // earlier period already excluded it as a follow-up of adopted history.
      const later = prepared.earlierRequirements.filter(row => row.txnDate > adoptedThrough).map(row => row.logicalKey), saved = new Set();
      for (let offset = 0; offset < later.length; offset += 100) for (const row of await models.Steps.find({ environment: scope.environment, realmId: scope.realmId, logicalKey: { $in: later.slice(offset, offset + 100) } }).select('logicalKey').limit(101).maxTimeMS(3000).lean()) saved.add(row.logicalKey);
      const adopted = new Set(prepared.earlierRequirements.filter(row => row.txnDate <= adoptedThrough || !saved.has(row.logicalKey)).map(row => row.logicalKey)), excluded = new Set();
      for (let changed = true; changed;) { changed = false; for (const step of prepared.steps) if (!excluded.has(step.logicalKey) && step.dependencies.some(link => adopted.has(link.logicalKey) || excluded.has(link.logicalKey))) { excluded.add(step.logicalKey); changed = true; } }
      if (excluded.size) {
        prepared.steps = prepared.steps.filter(step => !excluded.has(step.logicalKey));
        prepared.earlierRequirements = prepared.earlierRequirements.filter(row => !adopted.has(row.logicalKey));
        prepared.inheritedFollowUps = { version: 1, adoptionId: active.calendar.adoption.adoptionId, through: adoptedThrough, excluded: [...excluded].sort() };
        if (prepared.continuity) fail('A continuing business revision cannot yet exclude follow-ups of adopted history.');
        prepared.limitations = [...(prepared.limitations || []), excluded.size + ' scheduled follow-ups of adopted import history were not prepared. Their obligations stay open in QuickBooks for separate handling.'];
      }
      // Zero-activity close (continuous-business plan v2 §3b): a period with nothing schedulable is
      // not skipped and the cursor never moves directly. It runs the same preparation, approval and
      // seven-report observation as any period, with no writes, and records why it has no activity.
      if (!prepared.steps.length) prepared.limitations = [...(prepared.limitations || []), 'No scheduled activity remains in this period. It closes on its report evidence alone, with no QuickBooks records created.'];
    }
    // The owner's published tax choices are resolved structurally here. Their
    // dated rates and exact expected tax are derived independently below.
    for (const step of prepared.steps) {
      for (const ref of step.references.filter(ref => ref.entity === 'TaxCode')) {
        const code = setup.options.taxCodes.find(row => row.id === ref.id), direction = ref.key === 'salesTax' ? 'sales' : 'purchases';
        if (setup.completeness.taxCodes && code?.active === true && (code[direction] === true || code.taxable === false) && typeof code.syncToken === 'string') { ref.status = 'resolved'; ref.reason = null; }
      }
      step.blockers = step.blockers.filter(blocker => blocker.kind === 'prior_record' || (blocker.kind === 'record_choice' && step.references.some(ref => ref.key === blocker.key && ref.status !== 'resolved')));
      step.status = step.blockers.length ? 'blocked' : 'references_resolved';
    }
    const sign = () => { const { operationHash, preparedAt, readyToExecute, persisted, summary, limitations, ...body } = prepared; prepared.operationHash = hash(body); }; sign();
    prepared = await bindPreparedOperationReferences(prepared, { authorize: access.authorize, resolveClient: access.resolveClient, now, signal });
    const store = planStore(bound), history = await store.history(scope, operationHistoryRoots(prepared), { signal });
    const context = { scope, authorityHash: active.authority.contentHash, businessKey: active.value.businessKey, blueprintId: active.value.blueprintId, blueprintHash: active.value.blueprintHash, baselineHash: active.value.baselineHash, openingDate: active.value.openingDate, expectedCursor: active.calendar.verifiedThrough, expectedRevision: active.calendar.revision,
      requiredAssertions: [{ key: 'records', evidenceType: 'record-readback', currency: 'CAD' }, ...['trial-balance', 'balance-sheet', 'profit-and-loss'].map(key => ({ key, evidenceType: 'accrual-ledger', currency: 'CAD', basis: 'Accrual' })), ...['receivables', 'payables'].map(key => ({ key, evidenceType: 'open-balances-at-date', currency: 'CAD' }))] };
    const assembly = assembleBusinessOperation({ prepared, history, context, now: now() });
    const policies = await (dependencies.derivePolicies || deriveBusinessPolicies)(assembly, client, active.authority.contentHash, now());
    const boundCandidate = bindApprovedOperationPolicies(assembly, policies, now());
    let stockPreparation = null;
    if (active.value.stockRoot) {
      const { state, carry } = await require('./business-stock-history').readCommittedStockOpening(models, active);
      const priorActivityRows = await require('./business-stock-history').readSameDayStockRows(models, active);
      const startingState = require('./business-stock-cost').calculateStockCost(state, priorActivityRows, { fromDate, throughDate: input.throughDate }).closing;
      const receipts = batchChoices?.activities.filter(row => row.type === 'receive-purchase-order') || [];
      if (receipts.length) require('./business-received-order-calendar').assertReceiptSaleCosts({ receipts, day: input.throughDate, adoptedThrough, activity: require('./business-activity-preview').previewBusinessActivity(view, request, businessDate(new Date(now()))), opening: startingState });
      const purchaseOrigins = await require('./business-stock-evidence').loadPurchaseOrigins(models, startingState);
      const stockSource = await require('./business-stock-source').createBusinessStockReader({ access, now, purpose: 'operations.preview' })(scope, startingState, { signal });
      stockPreparation = { opening: state, carry, purchaseOrigins, stockSource, priorActivityRows };
    }
    const startingReports = await (dependencies.readReports || createBusinessReportReader({ access, now, purpose: 'preparation' }))(scope, { fromDate, throughDate: input.throughDate }, { signal });
    reportObservation(scope, { fromDate, throughDate: input.throughDate }, startingReports);
    const incomeExpectation = createIncomeExpectation(scope, { fromDate, throughDate: input.throughDate }, boundCandidate.candidate.entries, unpackReport('ProfitAndLoss', startingReports.reports.ProfitAndLoss, startingReports.version), startingReports.observedAt, startingReports.version);
    const financialExpectation = createFinancialExpectation(scope, { fromDate, throughDate: input.throughDate }, active.view.mappings, startingReports);
    const stockCostExpectation = stockPreparation ? require('./business-stock-evidence').createStockExpectation({ scope, period: { fromDate, throughDate: input.throughDate }, root: active.value.stockRoot, ...stockPreparation, reports: startingReports }) : null;
    const candidate = { ...boundCandidate.candidate, ...(stockCostExpectation ? { stockCostExpectation } : {}), requiredAssertions: [...boundCandidate.candidate.requiredAssertions, ...(stockCostExpectation ? [{ key: 'stock-costs', evidenceType: 'accrual-ledger', basis: 'Accrual', currency: 'CAD' }] : []), { key: 'financial-movements', evidenceType: 'accrual-ledger', basis: 'Accrual', currency: 'CAD' }], authorityHash: active.authority.contentHash, incomeExpectation, financialExpectation }, candidateHash = hash(candidate), auditId = hash({ candidateHash }).slice(0, 24);
    await transaction(async session => {
      await fence(bound, session, 'operations.preview');
      const latestBusiness = await assertPublishedBusiness({ ...models, scope, requireScheduleAcceptance: true, manifest: candidate, session, fence: true });
      if (stockCostExpectation) await require('./business-stock-history').assertFrozenStockOpening(models, latestBusiness, stockCostExpectation, session);
      const latest = await coordination(bound, session);
      if (latest.policy.revision !== current.policy.revision || latest.writer.revision !== current.writer.revision || signal?.aborted) fail('Company activity changed during preparation.');
      await touchCoordination(bound, latest, session);
      if (await read(models.Candidates, { ...scope, candidateHash }, session)) return;
      await models.Candidates.create([{ _id: hash({ scope, candidateHash }).slice(0, 24), contractVersion: 1, ...scope, candidateHash, payload: candidate, actorId, auditId }], { session });
      await models.Audits.create([{ _id: auditId, userId: ownerId, actorUserId: actorId !== ownerId ? actorId : undefined, realmId: scope.realmId, action: 'Business operation candidate retained', actionType: 'manual', outcome: 'success', afterState: { ...scope, candidateHash, authorityHash: active.authority.contentHash, fromDate, throughDate: input.throughDate, records: candidate.entries.length, qboWrites: 0 } }], { session });
    });
    return store.prepare(scope, { requestKey: input.requestKey, candidateHash });
  }
  // Fail before any plan is saved: each adopted obligation must be a saved record of
  // the adopted import, owed by the named party, with an open balance covering the
  // settlement. Compilation repeats the balance check against a fresh read.
  async function checkAdoptedSettlements(scope, active, batch, client) {
    const settlements = batch.activities.filter(row => ['collect-adopted-invoice', 'pay-adopted-bill'].includes(row.type));
    if (!settlements.length) return;
    const { importedObligation, adoptedJob } = require('./business-adopted-settlement'), Records = models.PopulationRecords || require('../models/BusinessPopulationRecord');
    const adoption = active.calendar.adoption;
    if (adoption?.kind !== 'adopted-history') fail('No adopted import history exists for this company.');
    const job = await adoptedJob(models.PopulationJobs, adoption);
    for (const row of settlements) {
      const entity = row.type === 'collect-adopted-invoice' ? 'Invoice' : 'Bill', qboId = row.invoiceId || row.billId, partyKey = row.customerKey || row.vendorKey;
      const origin = importedObligation(await Records.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, entity, qboId }).maxTimeMS(3000).lean(), scope, adoption, entity, qboId, job);
      if (origin.partyKey !== partyKey) fail('Adopted ' + entity.toLowerCase() + ' ' + qboId + ' belongs to another ' + (entity === 'Invoice' ? 'customer' : 'supplier') + '.');
      const record = (await client.apiCall('GET', entity.toLowerCase() + '/' + qboId))?.[entity], balance = Math.round(Number(record?.Balance) * 100);
      if (record?.Id !== qboId || record.CurrencyRef?.value !== 'CAD' || !Number.isSafeInteger(balance) || balance < row.amountCents) fail('Adopted ' + entity.toLowerCase() + ' ' + qboId + ' has an open balance of ' + (Number.isSafeInteger(balance) ? balance : 0) + ' cents, less than this settlement.');
    }
  }
  // Open obligations from the adopted import, from the synchronized company copy.
  // Balances are a starting point; preparation re-reads each chosen record.
  async function adoptedObligations(scope, active) {
    if (active.calendar.adoption?.kind !== 'adopted-history') return { adoptedInvoices: [], adoptedBills: [] };
    const Records = models.PopulationRecords || require('../models/BusinessPopulationRecord'), Mirror = models.Mirror || require('../models/CompanySyncRecord');
    // Same eligibility as preparation: saved by the adopted job with a matching proof.
    const job = await require('./business-adopted-settlement').adoptedJob(models.PopulationJobs, active.calendar.adoption);
    if (job?.status !== 'adopted') return { adoptedInvoices: [], adoptedBills: [] };
    const imported = await Records.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, authorityHash: job.authorityHash, state: 'saved', entity: { $in: ['Invoice', 'Bill'] }, txnDate: { $lte: active.calendar.adoption.importedThrough }, 'financialProof.matchesFinancialIntent': true, 'relationshipCheck.outcome': { $ne: 'error' } }).select('entity qboId step.details.customerKey step.details.vendorKey').limit(5000).maxTimeMS(3000).lean();
    const open = await Mirror.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, entity: { $in: ['Invoice', 'Bill'] }, deleted: false, 'summary.balanceCents': { $gt: 0 }, qboId: { $in: imported.map(row => row.qboId) } }).select('entity qboId summary').sort({ 'summary.dueDate': 1, _id: 1 }).limit(500).maxTimeMS(3000).lean();
    const party = new Map(imported.map(row => [row.entity + ':' + row.qboId, row.step?.details?.customerKey || row.step?.details?.vendorKey]));
    const list = entity => open.filter(row => row.entity === entity && party.has(entity + ':' + row.qboId)).slice(0, 60).map(row => ({ [entity === 'Invoice' ? 'invoiceId' : 'billId']: row.qboId, [entity === 'Invoice' ? 'customerKey' : 'vendorKey']: party.get(entity + ':' + row.qboId), docNumber: row.summary.docNumber || null, txnDate: row.summary.txnDate, dueDate: row.summary.dueDate || null, balanceCents: row.summary.balanceCents }));
    return { adoptedInvoices: list('Invoice'), adoptedBills: list('Bill') };
  }
  async function activityOptions(user, { signal } = {}) {
    const bound = await bind(user, 'operations.preview', true), { scope, access } = bound;
    const active = await assertPublishedBusiness({ ...models, scope, requireScheduleAcceptance: true });
    const client = await access.resolveClient(scope, { signal });
    const observed = await (dependencies.readMasters || readBusinessMasters)(client, scope, now);
    const rows = inspectBusinessMasters({ ...scope, draft: active.view }, observed).rows.filter(row => row.status === 'compatible');
    const policy = require('./business-activity-batch'), day = businessDate(new Date(now()));
    const customers = rows.filter(row => row.entity === 'Customer' && /^(field-client|care-client)-/.test(row.key));
    const services = rows.filter(row => row.entity === 'Item' && ['field-service-hour','care-plan-1','care-plan-2','care-plan-3'].includes(row.key));
    const vendors = rows.filter(row => row.entity === 'Vendor' && /^overhead-supplier-[1-3]$/.test(row.key));
    const adopted = await adoptedObligations(scope, active);
    const receivablePurchaseOrders = [];
    if (active.value.stockRoot) {
      const reader = require('./business-purchase-order-receipt').createPurchaseOrderReceiptReader({ models, history: planStore(bound).history, readRecord: async (scope, entity, id) => { const record = (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity]; return { scope, entity, record, recordHash: hash(record), observedAt: new Date(now()).toISOString() }; }, now });
      const owned = await models.Steps.find({ ...scope, entity: 'PurchaseOrder', state: 'verified' }).select('qboId').sort({ txnDate: -1, _id: 1 }).limit(60).maxTimeMS(3000).lean();
      const adoption = active.calendar.adoption;
      if (adoption?.kind === 'adopted-history') {
        const job = await require('./business-adopted-settlement').adoptedJob(models.PopulationJobs, adoption);
        if (job?.status === 'adopted') owned.push(...await (models.PopulationRecords || require('../models/BusinessPopulationRecord')).find({ ...scope, entity: 'PurchaseOrder', authorityHash: job.authorityHash, state: 'saved', 'financialProof.matchesFinancialIntent': true, 'relationshipCheck.outcome': { $ne: 'error' } }).select('qboId').sort({ txnDate: -1, _id: 1 }).limit(60).maxTimeMS(3000).lean());
      }
      for (const row of owned) {
        if (signal?.aborted) fail('Receiving choices were cancelled.');
        try { const source = await reader(scope, { purchaseOrderId: row.qboId }, { signal }); if (source.record.TxnDate < day) receivablePurchaseOrders.push({ ...require('./business-purchase-order-receipt').receiptChoice(source, active.view.masterBindings), docNumber: source.record.DocNumber || null, remainingQuantity: source.record.Line.reduce((sum,line) => sum + line.ItemBasedExpenseLineDetail.Qty, 0) }); }
        catch (error) { if (!['BUSINESS_PO_RECEIPT_UNVERIFIED', 'BUSINESS_READBACK_UNVERIFIED'].includes(error.code)) throw error; }
      }
    }
    await access.authorize(scope, 'operations.preview', { signal });
    // Transfers need two published bank roles; journal lines use published roles only.
    const banks = policy.bankRoles(), transfers = banks.length >= 2 ? { bankRoles: banks } : { bankRoles: banks, transferUnavailable: 'Transfers need two published bank accounts; this business publishes only ' + banks.join(', ') + '.' };
    const added = require('./business-added-roles').choiceRoles(await require('./business-added-roles').listAddedRoles(models, scope, bound.ownerId));
    // Own records the accountant may correct today, each with its eligibility.
    let correctableRecords = [], correctionUnavailable = null;
    try {
      const control = (await read(models.Policies, { environment: scope.environment, realmId: scope.realmId }))?.periodControl;
      const setup = await (dependencies.readSetup || readDraftSetup)(client, scope, now);
      const cutoff = [control?.closedThrough, control?.reconciledThrough, setup.observations?.closedThrough].filter(Boolean).sort().at(-1) || null;
      correctableRecords = await require('./business-correction').correctableRecords({ models, scope, ownerId: bound.ownerId, businessKey: active.value.businessKey, history: planStore(bound).history, readRecord: async (entity, id) => (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity], day, cutoff, setup, signal });
    } catch (error) { if (signal?.aborted) throw error; correctionUnavailable = 'Correction choices could not be read: ' + error.message; }
    // Own invoices and bills on terms still open (policy v8), each with its eligibility.
    let own = { ownOpenInvoices: [], ownOpenBills: [], ownOpenEstimates: [] }, ownUnavailable = null;
    try { own = await require('./business-own-settlement').ownOpenRecords({ models, scope, ownerId: bound.ownerId, businessKey: active.value.businessKey, history: planStore(bound).history, readRecord: async (entity, id) => (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity], day, signal }); }
    catch (error) { if (signal?.aborted) throw error; ownUnavailable = 'Open own invoices and bills could not be read: ' + error.message; }
    await access.authorize(scope, 'operations.preview', { signal });
    return { scope, day, policy: policy.POLICY, customers, services, vendors, ...added, correctableRecords, ...own, ownSettlementLimitation: ownUnavailable || 'invoice-on-terms and bill-on-terms leave a record open until its due date (' + policy.TERMS_DAYS.join(', ') + ' days). ownOpenInvoices and ownOpenBills list your own open terms records from earlier days with their open balance; collect-own-invoice and pay-own-bill settle one in full or in part (up to its open balance). order-stock raises a purchase order for one to five workshop stock items (vendorKey, lines of itemKey, quantity up to 500 and unitPriceCents before tax); from tomorrow it appears in receivablePurchaseOrders. send-estimate quotes field-service hours to a field customer; ownOpenEstimates lists your own open sent estimates from earlier days, and convert-own-estimate turns one into today’s time entry and an invoice on terms at the quoted hours and price. Imported records use collect-adopted-invoice and pay-adopted-bill; scheduled monthly records are settled by their own schedule.', correctionLimitation: correctionUnavailable || 'Corrections reverse your own verified records from earlier days, dated today: a wholly unpaid service invoice gets a full credit applied to it, a fully collected service sale gets a refund from the operating bank, a wholly unpaid operating bill gets a full supplier credit applied to it, and a journal entry gets its exact reverse. The original tax rate is repeated. Paid bills, partly paid records, records with credits, stock, imported records, corrections of corrections and voids are unavailable. Each record can be corrected once.', receivablePurchaseOrders, receivingLimitation: 'Only wholly unreceived open purchase orders are available, in full at their original cost. Partially received orders are unavailable.', ...adopted, ...transfers, journalRoles: policy.JOURNAL_ROLES, ready: active.calendar.verifiedThrough === shift(day,-1) && !active.calendar.currentOperationId && !active.calendar.stopRequested, limitation: 'Additional activity requires verified history through yesterday and an idle company writer. Preparation creates no QuickBooks records; review and approve the exact saved plan before running it.' };
  }
  async function prepareActivityBatch(user, input, { signal } = {}) {
    let choices = require('./business-activity-batch').validateChoices(input);
    const bound = await bind(user, 'operations.preview', true);
    const requestKey = await activityRequestKey(bound, choices.decisionKey);
    const derived = require('./business-activity-batch').OWN_SOURCED;
    if (choices.activities.some(row => row.type === 'correct-own-record' || derived[row.type])) choices = await correctionChoices(bound, requestKey, choices, signal);
    return prepare(user, { requestKey, throughDate: businessDate(new Date(now())) }, { signal, batchChoices: choices });
  }
  // A decision key identifies one decision and its lost-response retries. When its
  // operation is an expired preview from an earlier business day (never approved, so it
  // can never run: approval fences the calendar revision it was prepared against) or was
  // retired unsent, today's preparation under the same key gets its own day-scoped
  // operation. A key whose earlier-day operation was approved or ran is refused plainly,
  // so a past decision is never repeated.
  async function activityRequestKey(bound, decisionKey) {
    const { scope, ownerId, actorId } = bound, day = businessDate(new Date(now()));
    const legacy = hash({ scope, ownerId, kind: 'business-activity-batch', decisionKey }), dated = hash({ scope, ownerId, kind: 'business-activity-batch', decisionKey, day });
    const idOf = requestKey => hash({ scope, actorId, requestKey }).slice(0, 24), legacyId = idOf(legacy), todayId = idOf(dated);
    const first = await read(models.Runs, { _id: legacyId, ...scope }), firstDay = first?.activityBatch?.day || first?.throughDate;
    if (!first || !firstDay || firstDay >= day) return legacy;
    // Every earlier operation of this decision (the original and any day-scoped one) must
    // be inert, so no decision is ever carried out twice (for example a partial
    // settlement repeated on a later day).
    const earlier = await models.Runs.find({ ...scope, 'activityBatch.decisionKey': decisionKey }).select('_id status approval activityBatch.day throughDate').limit(101).maxTimeMS(3000).lean();
    if (earlier.length > 100) fail('decisionKey ' + decisionKey + ' has too many earlier operations. Choose a new decisionKey for today’s decision.');
    for (const run of [first, ...earlier.filter(row => String(row._id) !== legacyId)]) {
      const operationId = String(run._id);
      if (operationId === todayId) continue;
      const effects = await read(models.Receipts, { environment: scope.environment, realmId: scope.realmId, operationId }) || await models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, operationId }).select('_id').maxTimeMS(3000).lean();
      const inert = (run.status === 'previewed' && !run.approval) || run.status === 'retired';
      if (!inert || effects) fail('decisionKey ' + decisionKey + ' was already used by operation ' + operationId + ' on ' + (run.activityBatch?.day || run.throughDate) + ' (' + run.status + '). Choose a new decisionKey for today’s decision; that earlier work is not repeated.');
    }
    return dated;
  }
  // The agent names a correction's target and reason (or, policy v8, the own record it
  // collects or pays); the server derives the terms. A lost-response retry returns the
  // original saved terms, never re-derived ones (the original's balance has changed once
  // the correction or settlement ran).
  async function correctionChoices(bound, requestKey, choices, signal) {
    const { scope, actorId, access } = bound, operationId = hash({ scope, actorId, requestKey }).slice(0, 24);
    const minimal = activities => activities.map(row => { if (row.type === 'correct-own-record') return { type: row.type, target: row.target, purpose: row.purpose }; const { source, quote, ...rest } = row; return rest; });
    const existing = await read(models.Runs, { _id: operationId, ...scope });
    if (existing) {
      const saved = (await read(models.Plans, { _id: existing.planId, ...scope }))?.manifest?.activityBatch;
      if (!saved || saved.decisionKey !== choices.decisionKey || saved.purpose !== choices.purpose || canonical(minimal(saved.activities)) !== canonical(minimal(choices.activities))) fail('This request identifier belongs to different work.');
      return { decisionKey: saved.decisionKey, purpose: saved.purpose, activities: saved.activities };
    }
    const client = await access.resolveClient(scope, { signal });
    const input = { models, scope, history: planStore(bound).history, readRecord: async (entity, id) => (await client.apiCall('GET', entity.toLowerCase() + '/' + id))?.[entity] };
    return require('./business-own-settlement').expandOwnSettlements({ ...input, choices: await require('./business-correction').expandCorrections({ ...input, choices }) });
  }
  function reportObservation(scope, period, value) {
    const { sourceHash, evaluation: ignored, ...source } = value || {}, startedAt = Date.parse(source.startedAt), observedAt = Date.parse(source.observedAt);
    if (![2, 3].includes(source.version) || canonical(source.scope) !== canonical(scope) || canonical(source.period) !== canonical(period) || !HASH.test(sourceHash || '') || hash(source) !== sourceHash || !Number.isFinite(startedAt) || !Number.isFinite(observedAt) || observedAt < startedAt || observedAt > now() || now() - startedAt > 300000) fail('A fresh scoped seven-report observation is required before new business approval.');
    const evaluation = evaluateReportSources(source, { allowExplicitZero: true });
    if (evaluation.status !== 'checks-passed' || !reportComplete(evaluation, source)) fail('All seven critical reports and the named accounting checks must be available before business writes.');
    return { sourceHash, startedAt, observedAt };
  }
  async function approve(user, operationId, input) {
    const bound = await bind(user, 'operations.execute', true);
    exact(input, bound.scope.environment === 'production' ? ['planHash', 'confirmProduction'] : ['planHash']);
    if (!ID.test(operationId || '') || !HASH.test(input.planHash || '') || (bound.scope.environment === 'production' && input.confirmProduction !== true)) fail('Approve the exact saved plan and explicitly confirm the real Production company.', 400);
    const { scope, access } = bound, run = await read(models.Runs, { _id: operationId, ...scope });
    if (!run || run.planHash !== input.planHash) fail('The exact reviewed operation is unavailable.');
    // Exact acknowledgement recovery reuses the already saved approval. Fresh
    // provider reads belong outside Mongo transactions and only precede a new grant.
    // Additions sit in their own batch: refused for saved and already approved
    // operations too (dispatch re-checks this and capacity before each write).
    const plan = await read(models.Plans, { _id: run.planId, ...scope, planHash: run.planHash }), addedRoles = require('./business-added-roles');
    if (plan?.manifest?.activityBatch) addedRoles.assertListOnlyBatch(plan.manifest.activityBatch);
    if (run.status !== 'previewed') return planStore(bound).approve(scope, operationId, input.planHash, { confirmProduction: input.confirmProduction === true });
    if (!plan || hash(plan.manifest) !== input.planHash) fail('The immutable reviewed operation changed.');
    // Additions prepared earlier must still fit the registry when the writer is claimed.
    if (plan.manifest.activityBatch) addedRoles.assertCapacity(await addedRoles.countAddedRecords(models, scope), plan.manifest.activityBatch);
    const active = await assertPublishedBusiness({ ...models, scope, requireScheduleAcceptance: true, manifest: plan.manifest }), current = await coordination(bound);
    const period = { fromDate: run.fromDate, throughDate: run.throughDate };
    const reports = await (dependencies.readReports || createBusinessReportReader({ access, now, purpose: 'preparation' }))(scope, period);
    const observation = reportObservation(scope, period, reports);
    const reportFence = { ...observation, sources: reports, scope, period, operationId, planHash: input.planHash, authorityHash: active.authority.contentHash, policyRevision: current.policy.revision, writerRevision: current.writer.revision, calendarRevision: active.calendar.revision, authorityRevision: active.calendar.authorityRevision, calendarWriterRevision: active.calendar.writerRevision };
    return planStore(bound, reportFence).approve(scope, operationId, input.planHash, { confirmProduction: input.confirmProduction === true });
  }
  async function reviewOperation(user, operationId, offset = 0) {
    const bound = await bind(user, 'operations.preview'), store = planStore(bound);
    const page = await store.page(bound.scope, operationId, offset, 50);
    const run = await read(models.Runs, { _id: operationId, ...bound.scope });
    const plan = await read(models.Plans, { _id: run.planId, ...bound.scope });
    const approvalReports = await readApprovalReports({ models, run, ownerId: bound.ownerId });
    await bound.access.authorize(bound.scope, 'operations.preview');
    const rejected = await models.Steps.find({ ...bound.scope, operationId, state: 'rejected' }).limit(21).maxTimeMS(3000).lean();
    const uncertain = await models.Steps.find({ ...bound.scope, operationId, state: { $in: ['dispatched', 'unknown'] } }).limit(21).maxTimeMS(3000).lean();
    return { ...page, activityBatch: plan.manifest.activityBatch ? { decisionKey: plan.manifest.activityBatch.decisionKey, purpose: plan.manifest.activityBatch.purpose, day: plan.manifest.activityBatch.day } : null, approvalReports, uncertainActivities: uncertain.slice(0,20).map(row => ({ logicalKey: row.logicalKey, entity: row.entity, txnDate: row.compilation ? JSON.parse(row.compilation.request.body).TxnDate : null })), rejectedActivities: rejected.slice(0,20).map(row => ({ logicalKey: row.logicalKey, entity: row.entity, faultCodes: row.rejection?.faultCodes || [] })), recoveryReason: run.lastError || null, queuedContinuation: run.executionRequest?.pending === true, scope: bound.scope, fromDate: plan.manifest.fromDate, throughDate: plan.manifest.throughDate, createCount: plan.manifest.createCount, requiredAssertions: plan.manifest.requiredAssertions,
      entries: page.entries.map(entry => ({ logicalKey: entry.step.logicalKey, kind: entry.kind, entity: entry.step.entity, txnDate: entry.step.txnDate, details: entry.step.details, ...(entry.businessOrigin ? { businessOrigin: entry.businessOrigin } : {}), expectedTaxCents: entry.policy.readbackTax?.totalTaxCents ?? null, references: entry.step.references.map(ref => ({ entity: ref.entity, key: ref.key, id: ref.id })), dependencies: entry.step.dependencies.map(link => ({ entity: link.entity, logicalKey: link.logicalKey })) })) };
  }
  const continuity = require('./business-continuity-service').createBusinessContinuityService({ models, connection, transaction, now, bind, fence, coordination, touchCoordination, readSetup: dependencies.readSetup, readMasters: dependencies.readMasters });
  const retirement = createBusinessOperationRetirement({ models, transaction, now, bind, fence });
  const historyAdoption = require('./business-history-adoption-service').createHistoryAdoptionService({ models, transaction, now, bind, fence, readers: dependencies.adoptionReaders || {} });
  const taxReview = createBusinessPolicyAmendment({ models, transaction, now, bind, fence });
  const recovery = createBusinessOperationRecovery({ models, transaction, now, bind, fence, agentAuthority: dependencies.agentAuthority, Agents: dependencies.Agents });
  const unknownRecovery = createBusinessUnknownRecovery({ models, connection, transaction, now, bind, fence });
  return { ...unknownRecovery, ...recovery, reviewHistoryAdoption: historyAdoption.review, adoptHistory: historyAdoption.adopt, reviewContinuity: continuity.review, applyContinuity: continuity.apply, withdrawContinuity: continuity.withdraw, status, reviewPublication, publish, prepare, activityOptions, prepareActivityBatch, approve, reviewOperation, reviewRetirement: retirement.review, retire: retirement.retire, reviewTaxChange: taxReview.review, approveTaxChange: taxReview.approve };
}
module.exports = { createBusinessGovernanceService, reportHash };
