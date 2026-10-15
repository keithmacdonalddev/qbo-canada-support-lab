'use strict';
const { randomUUID } = require('node:crypto');
const { assertAccountEligible } = require('./account-policy');
const { hash } = require('./business-calendar');
const { assertRunApproval } = require('./business-period-store');
const { denied, scoped, classifyWriteResponse } = require('./qbo-write-contract');
const { normalizePermissions } = require('./rebuild-permissions');
const { readWritePeriodEvidence, assertWritePeriod } = require('./qbo-write-period');
const { normalizeWorkflow } = require('./qbo-write-workflow');
const ID = /^[a-f0-9]{24}$/i, HASH = /^[a-f0-9]{64}$/;
const same = (a, b) => String(a) === String(b);
const fresh = (stamp, clock) => { const value = typeof stamp === 'string' ? Date.parse(stamp) : NaN; return Number.isFinite(value) && new Date(value).toISOString() === stamp && value <= clock && clock - value <= 300000; };
const validRevision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
function createQboWriteGate({ Policies, Writers, Receipts, Audits, Connections, Memberships, Runs, Calendars, Steps, Users, transaction, assertReady, assertBusinessAuthority, masterTransport, now = () => Date.now(), nonce = randomUUID }) {
  if ([Policies, Writers, Receipts, Audits, Connections, Memberships, Runs, Calendars, Steps].some(value => !value) || [transaction, assertReady, now, nonce].some(value => typeof value !== 'function')) throw new TypeError('Write admission needs explicit storage adapters');
  const company = scope => ({ environment: scope.environment, realmId: scope.realmId });
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function fenceWorkspace(scope, ownerId, actorId, session, automation = false) {
    if (!Users) throw denied('Business workspace authority storage is required.');
    // OAuth switches write these same user documents. A concurrent switch then
    // conflicts with this transaction, so admission retries against the new scope.
    for (const id of [...new Set([ownerId, actorId])].sort()) {
      const user = await Users.findOne({ _id: id }).select('_id role email authVersion accessPolicyVersion automationAccessPolicyVersion connectionSwitchVersion').session(session).maxTimeMS(3000).lean();
      const version = user?.connectionSwitchVersion ?? 0;
      if (!user || !['agent', 'supervisor'].includes(user.role) || !validRevision(version)) throw denied('Business workspace user is unavailable.');
      try { assertAccountEligible(user, { automation }); } catch (error) { throw denied(error.message); }
      const versionFilter = user.connectionSwitchVersion === undefined ? { $exists: false } : version;
      const touched = await Users.findOneAndUpdate({ _id: id, role: user.role, connectionSwitchVersion: versionFilter }, { $inc: { connectionSwitchVersion: 1 } }, { new: true, session }).select('_id').lean();
      if (!touched) throw denied('Business workspace selection changed before dispatch.');
    }
    if (actorId !== ownerId && await read(Connections, { userId: actorId, status: 'active' }, session)) throw denied('The actor now works in its own company workspace.');
    const selected = await Connections.findOne({ userId: ownerId, status: 'active' }).sort({ updatedAt: -1 }).select('_id').session(session).maxTimeMS(3000).lean();
    if (!selected || !same(selected._id, scope.connectionId)) throw denied('The selected company connection changed before dispatch.');
  }
  async function policyState(scope, session) {
    const [policy, writer] = session ? [await read(Policies, company(scope), session), await read(Writers, company(scope), session)] : await Promise.all([read(Policies, company(scope)), read(Writers, company(scope))]);
    if (!policy && !writer) return null;
    if (!policy || !writer || policy.contractVersion !== 1 || writer.contractVersion !== 1 || !validRevision(policy.revision) || !validRevision(writer.revision) || !same(policy.connectionId, scope.connectionId) || !same(writer.connectionId, scope.connectionId)) throw denied('Company write coordination needs recovery before another request. Nothing was sent to QuickBooks; recover the business operation on the Company page, then try again.');
    return { policy, writer };
  }
  async function audit(id, input, outcome, details, session) {
    await Audits.create([{ _id: id, userId: input.ownerId, actorUserId: input.actorId !== input.ownerId ? input.actorId : undefined, realmId: input.scope.realmId,
      action: outcome === 'started' ? 'QuickBooks write dispatch recorded' : details.transportFailure === true ? 'QuickBooks write transport failure recorded' : 'QuickBooks write response recorded', actionType: 'manual', outcome: outcome === 'saved' ? 'success' : outcome === 'rejected' ? 'failure' : 'partial',
      inputParams: { environment: input.scope.environment, connectionId: input.scope.connectionId, dispatchKey: input.dispatchKey, requestHash: input.requestHash, entity: input.entity, operation: input.operation }, afterState: details,
    }], { session });
  }
  async function begin({ request, permit, ownerId, actorId, workflow, periodEvidence }) {
    const scope = scoped(request.scope);
    workflow = workflow ? normalizeWorkflow(workflow) : null;
    const master = workflow?.kind === 'master-preparation';
    if (master && (permit || typeof masterTransport?.admit !== 'function' || typeof masterTransport?.settle !== 'function')) throw denied('Master creates require their dedicated reviewed runtime.');
    if (!ID.test(ownerId || '') || !ID.test(actorId || '')) throw denied('The actual write actor and company owner are required.');
    const initial = await policyState(scope);
    if (!initial) throw denied('Company writes require explicit business storage and write-coordination setup on the Company page. Nothing was sent.');
    if (initial.policy.state !== 'active') throw denied('Company writes are paused while business write coordination is being prepared. Nothing was sent to QuickBooks; finish or resume that setup, then try again.');
    if (request.entity === 'batch') throw denied('Coordinated batch writes need per-item recovery and are not enabled.');
    await assertReady();
    const dispatchKey = permit?.dispatchKey || (master ? hash({ version: 1, masterRunId: workflow.runId, ordinal: workflow.ordinal, attempt: workflow.attempt }) : hash({ scope, requestHash: request.requestHash, nonce: nonce() }));
    const receiptId = hash({ scope, dispatchKey }), startAuditId = hash({ receiptId, event: 'started' }).slice(0, 24);
    const ticket = { coordinated: true, scope, receiptId, dispatchKey, requestHash: request.requestHash, kind: permit ? 'business' : master ? 'master-preparation' : 'legacy', ownerId, actorId, entity: request.entity, operation: request.operation };
    return transaction(async session => {
      const state = await policyState(scope, session);
      if (!state || state.policy.state !== 'active') throw denied('Company write preparation or scope changed.');
      const connection = await read(Connections, { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, session);
      if (!connection) throw denied('The company connection is no longer active.');
      await fenceWorkspace(scope, ownerId, actorId, session, true);
      const membership = await read(Memberships, { userId: actorId, realmId: scope.realmId, status: 'active' }, session);
      const permission = workflow?.kind === 'reproduction' && !permit ? 'reproduction.run' : 'operations.execute';
      if (!membership || !normalizePermissions(membership.role, membership.permissionOverrides || []).includes(permission)) throw denied('Current company permission is required before every write.');
      if (membership) {
        // Take a write conflict with concurrent membership changes in this transaction.
        const authorized = await Memberships.findOneAndUpdate({ _id: membership._id, userId: actorId, realmId: scope.realmId, status: 'active', role: membership.role }, { $inc: { businessSetupVersion: 1 } }, { new: true, session }).lean();
        if (!authorized) throw denied('Business execution permission changed before dispatch.');
      }
      const { writer, policy } = state;
      const fence = periodEvidence?.coordination;
      if (!fence || fence.policyRevision !== policy.revision || fence.writerRevision !== writer.revision || fence.controlHash !== policy.periodControl?.contentHash) throw denied('Company activity or protected-period choices changed during reading. Read fresh evidence before retrying.');
      const periodProof = assertWritePeriod(request, periodEvidence, policy.periodControl, now(), ownerId);
      let unresolved;
      if (master) {
        unresolved = await masterTransport.admit({ scope, ownerId, actorId, workflow, request, receiptId, dispatchKey, writer, policy, startAuditId, session });
      } else if (permit) {
        if (!same(permit.scope?.connectionId, scope.connectionId) || permit.scope?.realmId !== scope.realmId || permit.scope?.environment !== scope.environment || permit.requestHash !== request.requestHash || !same(writer.operationId, permit.operationId) || writer.unresolved?.key !== dispatchKey || writer.unresolved?.logicalKey !== permit.logicalKey || writer.unresolved?.requestHash !== request.requestHash || writer.unresolved?.actorId !== actorId || writer.unresolved?.transportConsumed || request.operation !== 'create') throw denied('This permission does not match the exact unsent business request.');
        const step = await read(Steps, { ...scope, logicalKey: permit.logicalKey, operationId: permit.operationId, state: 'dispatched' }, session);
        const run = await read(Runs, { _id: permit.operationId, ...scope, planHash: writer.planHash, status: { $in: ['reserved', 'running'] } }, session);
        const calendar = await read(Calendars, { ...scope, currentOperationId: permit.operationId, stopRequested: false, pendingCommit: null }, session);
        if (!step || step.revision !== permit.dispatchRevision || step.leaseToken !== permit.stepLeaseToken || writer.unresolved?.stepRevision !== permit.dispatchRevision || !run || !calendar || !fresh(step.dispatch?.observedAt, now()) || !HASH.test(step.dispatch?.compilationHash || '') || step.dispatch?.compilationHash !== writer.unresolved?.compilationHash || !HASH.test(step.dispatch?.evidenceHash || '') || step.dispatch?.evidenceHash !== writer.unresolved?.evidenceHash || !validRevision(step.dispatch?.observationWriterRevision) || writer.revision !== step.dispatch.observationWriterRevision + 1 || step.entity.toLowerCase() !== request.entity || step.planHash !== run.planHash || step.dispatch?.key !== dispatchKey || step.dispatch?.requestHash !== request.requestHash || calendar.blueprintHash !== run.blueprintHash || calendar.baseline?.status !== 'verified' || calendar.baseline.evidenceHash !== run.baselineHash || calendar.verifiedThrough !== run.expectedCursor || calendar.revision !== run.expectedRevision || !validRevision(run.writerRevision) || !validRevision(run.evidenceRevision) || !validRevision(calendar.writerRevision)) throw denied('Business step, stop state or calendar changed before sending.');
        assertRunApproval(run);
        if (run.authorityHash && (!HASH.test(step.dispatch?.policyHash || '') || step.dispatch.policyHash !== writer.unresolved.policyHash || (step.dispatch.policyAmendmentHash || null) !== (run.policyAmendmentHash || null))) throw denied('The exact owner-approved business policy changed before sending.');
        if (typeof assertBusinessAuthority !== 'function') throw denied('The published business authority verifier is required.');
        await assertBusinessAuthority({ scope, run, session });
        if (run.leaseToken && (permit.leaseToken !== run.leaseToken || !Number.isFinite(new Date(run.leaseExpiresAt).getTime()) || new Date(run.leaseExpiresAt).getTime() <= now())) throw denied('The operation worker lease changed or expired before sending.');
        if (permit.leaseToken && !run.leaseToken) throw denied('The operation worker lease is no longer held.');
        const touchedRun = await Runs.findOneAndUpdate({ _id: run._id, ...scope, writerRevision: run.writerRevision, evidenceRevision: run.evidenceRevision, status: run.status, ...(run.leaseToken ? { leaseToken: run.leaseToken, leaseExpiresAt: run.leaseExpiresAt } : {}) }, { $inc: { writerRevision: 1, evidenceRevision: 1 }, $set: { verificationCandidateHash: null } }, { new: true, session }).lean();
        const touchedCalendar = await Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, writerRevision: calendar.writerRevision, stopRequested: false, currentOperationId: run._id }, { $inc: { writerRevision: 1 } }, { new: true, session }).lean();
        if (!touchedRun || !touchedCalendar) throw denied('Business ownership changed before sending.');
        unresolved = { ...writer.unresolved, transportConsumed: { receiptId, consumedAt: new Date(now()).toISOString() } };
      } else {
        if (writer.operationId !== null || writer.planHash !== null || writer.unresolved !== null) throw denied('Another operation or unresolved request owns this company.');
        unresolved = { key: dispatchKey, requestHash: request.requestHash, actorId, entity: request.entity, kind: 'legacy', transportConsumed: { receiptId, consumedAt: new Date(now()).toISOString() } };
      }
      const policyTouched = await Policies.findOneAndUpdate({ _id: policy._id, ...scope, state: 'active', revision: policy.revision }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      const writerTouched = await Writers.findOneAndUpdate({ _id: writer._id, ...scope, revision: writer.revision, operationId: writer.operationId, planHash: writer.planHash }, { $set: { unresolved }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!policyTouched || !writerTouched) throw denied('Company write admission changed.');
      await Receipts.create([{ _id: receiptId, contractVersion: 1, ...scope, ownerId, actorId, kind: ticket.kind, ...(workflow ? { workflow } : {}), ...(permit ? { operationId: permit.operationId, logicalKey: permit.logicalKey } : master ? { operationId: workflow.runId } : {}), dispatchKey, requestHash: request.requestHash, periodProof, entity: request.entity, operation: request.operation, state: 'possibly-sent', observed: null, sentAt: new Date(now()), startAuditId }], { session });
      await audit(startAuditId, { ...ticket, scope }, 'started', { state: 'possibly-sent', receiptId }, session);
      return ticket;
    });
  }
  async function complete(ticket, request, response, intuitTid) {
    return finish(ticket, request, classifyWriteResponse(request, response, intuitTid), 'http-response');
  }
  async function failTransport(ticket, request, facts = {}) {
    const status = Number.isInteger(facts.httpStatus) && facts.httpStatus >= 100 && facts.httpStatus <= 599 ? facts.httpStatus : null;
    const intuitTid = typeof facts.intuitTid === 'string' && /^[a-z0-9._-]{1,128}$/i.test(facts.intuitTid) ? facts.intuitTid : null;
    // No raw exception, request, provider message or headers enter this receipt.
    const observed = { outcome: 'unknown', entity: request.entity, operation: request.operation, httpStatus: status, intuitTid, responseHash: null, transportFailure: true };
    return finish(ticket, request, observed, 'sdk-failure');
  }
  async function finish(ticket, request, observed, endKind) {
    if (!ticket?.coordinated) return { outcome: 'uncoordinated' };
    const resultAuditId = hash({ receiptId: ticket.receiptId, event: 'response', observed }).slice(0, 24);
    return transaction(async session => {
      const stored = await read(Receipts, { _id: ticket.receiptId, ...ticket.scope, dispatchKey: ticket.dispatchKey, requestHash: request.requestHash }, session);
      if (!stored || stored.state !== 'possibly-sent') throw denied('The request receipt already changed; recover its saved result.', true);
      const state = await policyState(ticket.scope, session), writer = state?.writer;
      if (!writer || writer.unresolved?.key !== ticket.dispatchKey || writer.unresolved?.transportConsumed?.receiptId !== ticket.receiptId) throw denied('The response no longer matches the company request barrier.', true);
      const observedAt = new Date(now());
      const terminal = observed.outcome === 'unknown' ? { version: 1, scope: ticket.scope, receiptId: stored._id, dispatchKey: stored.dispatchKey, requestHash: stored.requestHash, kind: endKind, endedAt: observedAt.toISOString(), observedHash: hash(observed) } : null;
      const terminalHash = terminal ? hash(terminal) : null, terminalAuditId = terminal ? hash({ terminalHash }).slice(0, 24) : null;
      const saved = await Receipts.findOneAndUpdate({ _id: stored._id, state: 'possibly-sent', requestHash: request.requestHash }, { $set: { state: observed.outcome, observed, observedAt, resultAuditId, ...(terminal ? { terminal: { ...terminal, contentHash: terminalHash, auditId: terminalAuditId } } : {}) } }, { new: true, session }).lean();
      if (!saved) throw denied('The response receipt changed while saving.', true);
      if (stored.kind === 'master-preparation') {
        if (typeof masterTransport?.settle !== 'function') throw denied('Master result settlement requires its dedicated runtime.', true);
        await masterTransport.settle({ stored, observed, resultAuditId, observedAt, session });
      }
      if (stored.kind === 'business' && observed.outcome === 'rejected') {
        const step = await read(Steps, { ...ticket.scope, operationId: stored.operationId, logicalKey: stored.logicalKey, state: { $in: ['dispatched', 'unknown'] }, 'dispatch.key': stored.dispatchKey, receipt: null }, session);
        const run = await read(Runs, { _id: stored.operationId, ...ticket.scope, status: { $in: ['reserved', 'running', 'blocked', 'stopped'] } }, session);
        const calendar = await read(Calendars, { ...ticket.scope, currentOperationId: stored.operationId, pendingCommit: null }, session);
        if (!step || !run || !calendar || !validRevision(run.writerRevision) || !validRevision(run.evidenceRevision) || !validRevision(calendar.writerRevision)) throw denied('Rejected dispatch needs operation recovery.', true);
        const rejection = { version: 1, dispatchKey: stored.dispatchKey, requestHash: stored.requestHash, receiptId: stored._id, evidenceHash: hash(observed), httpStatus: observed.httpStatus, faultCodes: observed.faultCodes };
        const rejected = await Steps.findOneAndUpdate({ _id: step._id, ...ticket.scope, logicalKey: stored.logicalKey, state: step.state, revision: step.revision, leaseToken: step.leaseToken }, { $set: { state: 'rejected', rejection, lastAuditId: resultAuditId }, $inc: { revision: 1 } }, { new: true, session }).lean();
        const stopped = await Runs.findOneAndUpdate({ _id: run._id, ...ticket.scope, status: run.status, writerRevision: run.writerRevision, evidenceRevision: run.evidenceRevision }, { $set: { status: run.status === 'stopped' ? 'stopped' : 'blocked', verificationCandidateHash: null }, $inc: { writerRevision: 1, evidenceRevision: 1 } }, { new: true, session }).lean();
        const touched = await Calendars.findOneAndUpdate({ _id: calendar._id, ...ticket.scope, currentOperationId: run._id, writerRevision: calendar.writerRevision }, { $inc: { writerRevision: 1 } }, { new: true, session }).lean();
        if (!rejected || !stopped || !touched) throw denied('Rejected dispatch changed during settlement.', true);
      }
      const unresolved = (stored.kind === 'legacy' && ['saved', 'rejected'].includes(observed.outcome)) || observed.outcome === 'rejected' ? null : { ...writer.unresolved, responseReceiptId: ticket.receiptId };
      const updated = await Writers.findOneAndUpdate({ _id: writer._id, ...ticket.scope, revision: writer.revision, 'unresolved.key': ticket.dispatchKey }, { $set: { unresolved }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!updated) throw denied('The company request changed while saving its response.', true);
      await audit(resultAuditId, ticket, observed.outcome, { state: observed.outcome, receiptId: ticket.receiptId, ...observed }, session);
      if (terminal) await Audits.create([{ _id: terminalAuditId, userId: stored.ownerId, actorUserId: same(stored.ownerId, stored.actorId) ? undefined : stored.actorId, realmId: stored.realmId, action: 'QuickBooks write attempt ended without a confirmed outcome', actionType: 'manual', outcome: 'partial', afterState: { ...terminal, contentHash: terminalHash } }], { session });
      return { ...observed, receiptId: ticket.receiptId };
    });
  }
  const caseQuery = (scope, ownerId, workflow) => ({ ...scope, kind: 'legacy', ownerId, 'workflow.kind': 'reproduction', 'workflow.sessionId': workflow.sessionId, 'workflow.planId': workflow.planId, 'workflow.stepNumber': workflow.stepNumber });
  const caseReceipts = (query, session) => Receipts.find(query).limit(2).session(session).maxTimeMS(3000).lean();
  // A server-owned reverse lookup also covers a crash/lost acknowledgement
  // between durable admission and the case saving its dispatch identifier.
  async function settleCase({ scope, ownerId, actorId, workflow, dispatch, decision }, save) {
    scope = scoped(scope); workflow = normalizeWorkflow(workflow);
    if (!ID.test(ownerId || '') || actorId !== ownerId || typeof save !== 'function') throw denied('Only the current company owner can settle a case write.');
    return transaction(async session => {
      await fenceWorkspace(scope, ownerId, actorId, session);
      const state = await policyState(scope, session);
      const receipts = await caseReceipts(caseQuery(scope, ownerId, workflow), session);
      if (receipts.length > 1) throw denied('Several requests claim this case step. Review their exact receipts; nothing was settled.');
      let receipt = receipts[0] || null;
      if (!dispatch && receipt) dispatch = { version: 1, scope, receiptId: String(receipt._id), dispatchKey: receipt.dispatchKey, requestHash: receipt.requestHash };
      if (!dispatch) {
        if (state?.writer.unresolved) throw denied('This company has an unresolved request without an exact receipt for this case step. Its dispatch must be identified before the case can be cleared.');
        return save(session);
      }
      if (dispatch.version !== 1 || !HASH.test(dispatch.receiptId || '') || !HASH.test(dispatch.dispatchKey || '') || !HASH.test(dispatch.requestHash || '') || hash(dispatch.scope || null) !== hash(scope)) throw denied('The saved case dispatch is incomplete or belongs to another company.');
      await assertReady();
      if (!receipt || String(receipt._id) !== dispatch.receiptId || receipt.dispatchKey !== dispatch.dispatchKey || receipt.requestHash !== dispatch.requestHash || hash(receipt.workflow || null) !== hash(workflow)) throw denied('The uncertain company request does not match this exact case step. Nothing was settled.');
      const connection = await read(Connections, { _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }, session);
      if (!connection) throw denied('The case company connection changed during recovery.');
      if (!decision || !['completed', 'failed'].includes(decision.status) || (decision.status === 'completed' && !/^\d{1,30}$/.test(String(decision.result?.data?.id || '')))) throw denied('Saved record evidence or an explicit no-effect decision is required.');
      if (['saved', 'rejected'].includes(receipt.state)) {
        const savedId = receipt.observed?.qboId || receipt.reconciliation?.qboId;
        if ((receipt.state === 'saved' && (decision.status !== 'completed' || String(savedId) !== String(decision.result.data.id))) || (receipt.state === 'rejected' && decision.status !== 'failed')) throw denied('Readback contradicts the retained transport result. Nothing was settled.');
        // The response is already durable. Repair this workflow only; an unrelated
        // current writer is neither changed nor released.
        return save(session);
      }
      const writer = state?.writer;
      if (!['possibly-sent', 'unknown'].includes(receipt.state) || !writer || writer.operationId !== null || writer.planHash !== null || writer.unresolved?.key !== receipt.dispatchKey || writer.unresolved?.requestHash !== receipt.requestHash || writer.unresolved?.transportConsumed?.receiptId !== receipt._id) throw denied('The company barrier changed or belongs to another operation. Nothing was settled.');
      const reconciliation = { version: 1, workflow, actorId, at: new Date(now()).toISOString(), decision: decision.result.reconciled, outcome: decision.status === 'completed' ? 'saved' : 'rejected', qboId: decision.result?.data?.id || null };
      const settled = await Receipts.findOneAndUpdate({ _id: receipt._id, ...scope, state: receipt.state, requestHash: receipt.requestHash }, { $set: { state: reconciliation.outcome, reconciliation } }, { new: true, session }).lean();
      const released = await Writers.findOneAndUpdate({ _id: writer._id, ...scope, revision: writer.revision, operationId: null, planHash: null, 'unresolved.key': receipt.dispatchKey }, { $set: { unresolved: null }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!settled || !released) throw denied('The uncertain company request changed during recovery.');
      return save(session);
    });
  }
  async function assertCaseSettled({ scope, ownerId, sessionId }) {
    scope = scoped(scope);
    if (!ID.test(ownerId || '') || !ID.test(sessionId || '')) throw denied('The current company owner and exact case are required.');
    return transaction(async session => {
      await fenceWorkspace(scope, ownerId, ownerId, session);
      const state = await policyState(scope, session), writer = state?.writer;
      const pending = await caseReceipts({ ...scope, kind: 'legacy', ownerId, 'workflow.sessionId': sessionId, state: { $in: ['possibly-sent', 'unknown'] } }, session);
      if (pending.length) throw denied('The case still has an uncertain transport receipt. Recover its exact saved change before continuing.');
      if (writer?.unresolved) {
        const receipt = await read(Receipts, { _id: writer.unresolved.transportConsumed?.receiptId, ...scope }, session);
        if (!receipt?.workflow || receipt.workflow.sessionId === sessionId) throw denied('The company still has an unresolved request for this case or an unidentified historical request. Its transport must be settled before the case can be cleared.');
      }
      return true;
    });
  }
  async function preflight({ request, client }) {
    if (request.entity === 'batch') throw denied('Coordinated batch writes need per-item recovery and are not enabled.');
    const state = await policyState(scoped(request.scope));
    if (!state || state.policy.state !== 'active' || !state.policy.periodControl) throw denied('Complete explicit write coordination setup and record protected-period choices on the Company page before writing.');
    try {
      const coordination = { policyRevision: state.policy.revision, writerRevision: state.writer.revision, controlHash: state.policy.periodControl.contentHash };
      const evidence = await readWritePeriodEvidence(request, client, now, coordination);
      const current = await policyState(scoped(request.scope));
      if (!current || current.policy.state !== 'active' || current.policy.revision !== coordination.policyRevision || current.writer.revision !== coordination.writerRevision || current.policy.periodControl?.contentHash !== coordination.controlHash) throw denied('Company activity or protected-period choices changed during reading. Read fresh evidence before retrying.');
      return evidence;
    }
    catch (error) { if (error.qboStage === 'write_admission') throw error; const failure = denied('Protected periods or linked record dates could not be verified. Nothing was sent.'); if (error.intuit_tid) failure.intuit_tid = error.intuit_tid; throw failure; }
  }
  // Absence of the mandatory transport receipt is meaningful only while fencing
  // its exact writer/step in this transaction. A racing begin then conflicts and
  // must re-read the reset step, so it cannot send using the superseded marker.
  async function releaseUnsent({ scope, operationId, logicalKey, dispatchKey, ownerId, actorId }) {
    scope = scoped(scope);
    if (![ownerId, actorId, operationId].every(value => ID.test(value || '')) || !HASH.test(logicalKey || '') || !HASH.test(dispatchKey || '')) throw denied('Exact unsent operation identity is required.');
    await assertReady();
    return transaction(async session => {
      await fenceWorkspace(scope, ownerId, actorId, session);
      const member = await read(Memberships, { userId: actorId, realmId: scope.realmId, status: 'active' }, session);
      if (!member || !normalizePermissions(member.role, member.permissionOverrides || []).includes('operations.execute')) throw denied('Current operation recovery permission is required.');
      const authorized = await Memberships.findOneAndUpdate({ _id: member._id, userId: actorId, realmId: scope.realmId, status: 'active', role: member.role }, { $inc: { businessSetupVersion: 1 } }, { new: true, session }).lean();
      if (!authorized) throw denied('Recovery permission changed before settlement.');
      const state = await policyState(scope, session), writer = state?.writer;
      const receiptId = hash({ scope, dispatchKey });
      if (await read(Receipts, { _id: receiptId }, session)) return { released: false };
      const step = await read(Steps, { ...scope, operationId, logicalKey, state: { $in: ['dispatched', 'unknown'] }, 'dispatch.key': dispatchKey, receipt: null }, session);
      const run = await read(Runs, { _id: operationId, ...scope, status: { $in: ['reserved', 'running', 'blocked', 'stopped'] } }, session);
      const calendar = await read(Calendars, { ...scope, currentOperationId: operationId, pendingCommit: null }, session);
      if (!step || !run || !calendar || !writer || !same(writer.operationId, operationId) || writer.planHash !== run.planHash || writer.unresolved?.key !== dispatchKey || writer.unresolved?.logicalKey !== logicalKey || writer.unresolved?.requestHash !== step.dispatch?.requestHash || writer.unresolved?.transportConsumed || step.qboId || !validRevision(step.revision) || !validRevision(run.writerRevision) || !validRevision(run.evidenceRevision) || !validRevision(calendar.writerRevision)) throw denied('The dispatch is not an exact never-admitted request.');
      const auditId = hash({ receiptId, event: 'never-admitted', stepRevision: step.revision }).slice(0, 24);
      const saved = await Steps.findOneAndUpdate({ _id: step._id, ...scope, operationId, logicalKey, state: step.state, revision: step.revision, 'dispatch.key': dispatchKey, receipt: null }, { $set: { state: 'claimed', dispatch: null, compilation: null, leaseExpiresAt: new Date(now()), lastAuditId: auditId }, $inc: { revision: 1 } }, { new: true, session }).lean();
      const released = await Writers.findOneAndUpdate({ _id: writer._id, ...scope, revision: writer.revision, operationId, planHash: run.planHash, 'unresolved.key': dispatchKey }, { $set: { unresolved: null }, $inc: { revision: 1 } }, { new: true, session }).lean();
      const changedRun = await Runs.findOneAndUpdate({ _id: run._id, ...scope, status: run.status, writerRevision: run.writerRevision, evidenceRevision: run.evidenceRevision }, { $set: { verificationCandidateHash: null }, $inc: { writerRevision: 1, evidenceRevision: 1 } }, { new: true, session }).lean();
      const changedCalendar = await Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, currentOperationId: operationId, writerRevision: calendar.writerRevision }, { $inc: { writerRevision: 1 } }, { new: true, session }).lean();
      if (!saved || !released || !changedRun || !changedCalendar) throw denied('The unsent dispatch changed during recovery.');
      await Audits.create([{ _id: auditId, userId: ownerId, actorUserId: actorId !== ownerId ? actorId : undefined, realmId: scope.realmId, action: 'Business dispatch proved never admitted', actionType: 'manual', outcome: 'success', beforeState: { ...scope, operationId, logicalKey, dispatch: step.dispatch }, afterState: { state: 'claimed', noTransportReceipt: receiptId, qboWrites: 0 } }], { session });
      return { released: true, state: 'claimed' };
    });
  }
  return { preflight, begin, complete, failTransport, settleCase, assertCaseSettled, releaseUnsent };
}
let defaultGate;
function getQboWriteGate() {
  if (defaultGate) return defaultGate;
  const mongoose = require('mongoose');
  const models = { Users: require('../models/User'), Policies: require('../models/CompanyWritePolicy'), Writers: require('../models/CompanyWriter'), Receipts: require('../models/QboWriteReceipt'), Audits: require('../models/AuditLog'), Connections: require('../models/Connection'), Memberships: require('../models/CompanyMembership'), Runs: require('../models/OperationRun'), Calendars: require('../models/BusinessCalendar'), Steps: require('../models/OperationStep') };
  const { createBusinessTransaction } = require('./business-transaction');
  const assertReady = async () => {
    if (mongoose.connection.readyState !== 1) throw denied('Write coordination storage is unavailable.');
    const required = [models.Policies, models.Writers, models.Receipts, models.Audits];
    const names = required.map(model => model.collection.name);
    const collections = await mongoose.connection.db.listCollections({ name: { $in: names } }, { nameOnly: true }).toArray();
    if (collections.length !== names.length) throw denied('Write coordination storage needs explicit preparation.');
    for (const [Model, fields] of [[models.Policies, ['environment', 'realmId']], [models.Writers, ['environment', 'realmId']], [models.Receipts, ['environment', 'realmId', 'dispatchKey']]]) {
      const indexes = await Model.collection.indexes();
      if (!indexes.some(index => index.unique === true && !index.sparse && !index.partialFilterExpression && Object.keys(index.key).join(',') === fields.join(',') && fields.every(key => index.key[key] === 1))) throw denied('Write coordination uniqueness is not installed.');
    }
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw denied('Write coordination requires database transactions.');
  };
  defaultGate = createQboWriteGate({ ...models, transaction: createBusinessTransaction(mongoose.connection), assertReady });
  return defaultGate;
}
module.exports = { createQboWriteGate, getQboWriteGate };
