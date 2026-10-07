'use strict';
const { canonical, date, hash } = require('./business-calendar');
const { previewBusinessActivity, validatePreviewRequest, businessDate } = require('./business-activity-preview');
const { checkBlueprintMappings } = require('./blueprint-mapping-check');
const { inspectBusinessMasters } = require('./business-master-data');
const { problem } = require('./blueprint-draft');
const MAX_DAYS = 31, MAX_STEPS = 500;
function validateOperationRequest(input) {
  validatePreviewRequest(input);
  if (date(input.throughDate) - date(input.fromDate) >= MAX_DAYS * 86400000) throw problem('Prepare at most 31 calendar days in one operation.');
  return input;
}
function prepareBusinessOperation(view, input, setup, masters, now = new Date()) {
  validateOperationRequest(input);
  const observedNow = now.getTime();
  for (const source of [setup, masters]) {
    const stamp = Date.parse(source.observedAt);
    if (!Number.isFinite(stamp) || stamp > observedNow || observedNow - stamp > 300000 || !/^[a-f0-9]{64}$/.test(source.sourceHash || '')) throw problem('Company observations are missing or stale. Read the company again.', 409);
  }
  const activity = previewBusinessActivity(view, input, businessDate(now));
  if (activity.events.length > MAX_STEPS) throw problem('This operation exceeds 500 steps. Shorten the period.');
  const mappingInput = { connectionId: input.connectionId, baseHash: input.baseHash };
  const accounts = checkBlueprintMappings(view, setup, mappingInput), masterCheck = inspectBusinessMasters(view, masters);
  const mappingRows = new Map(accounts.rows.map(row => [row.key, row]));
  const masterRows = new Map(masterCheck.rows.map(row => [row.key, row]));
  const eventByKey = new Map([...activity.prerequisites, ...activity.events, ...activity.future].map(event => [event.logicalKey, event]));
  const currentKeys = new Set(activity.events.map(event => event.logicalKey));
  const earlier = new Map();
  const retainEarlier = event => { for (const key of event.dependsOn) { const parent = eventByKey.get(key); if (!parent) throw problem('An originating activity is missing.'); if (parent.txnDate < input.fromDate && !earlier.has(key)) { earlier.set(key, parent); retainEarlier(parent); } } };
  for (const event of activity.events) retainEarlier(event);
  const bind = (key, entity, rows, options) => {
    const checked = rows.get(key);
    const records = options || [];
    const matches = records.filter(record => record.id === checked?.id);
    const record = matches.length === 1 ? matches[0] : null;
    const validVersion = typeof record?.syncToken === 'string' && /^(0|[1-9]\d{0,63})$/.test(record.syncToken);
    const structurallyValid = checked?.status === 'compatible' && validVersion;
    return { key, entity, id: checked?.id || null, syncToken: record?.syncToken ?? null,
      status: structurallyValid ? 'resolved' : checked?.status === 'compatible' ? 'unverified' : checked?.status || 'unassigned',
      reason: structurallyValid ? null : checked?.status === 'compatible' ? 'A valid current record version is unavailable.' : checked?.reason || 'A saved choice is required.' };
  };
  const steps = activity.events.map(event => {
    const { details, detailsHash } = activity.detailProposal.byLogicalKey[event.logicalKey];
    const references = new Map();
    const master = (key, entity) => { if (key) references.set(entity + ':' + key, bind(key, entity, masterRows, masters.options[entity])); };
    master(details.customerKey, 'Customer'); master(details.vendorKey, 'Vendor'); master(details.workerKey, 'Employee'); master(details.itemKey, 'Item');
    for (const line of details.lines) master(line.itemKey, 'Item');
    const accountKeys = new Set([details.bankMapping, ...details.lines.map(line => line.accountMapping)].filter(Boolean));
    // Product account dependencies matter even where QBO obtains them through the item.
    for (const line of details.lines) for (const key of Object.values(masterRows.get(line.itemKey)?.accountMappings || {})) accountKeys.add(key);
    if (['Invoice', 'Payment'].includes(event.entity)) accountKeys.add('accountsReceivable');
    if (['PurchaseOrder', 'Bill', 'BillPayment'].includes(event.entity)) accountKeys.add('accountsPayable');
    if (details.destination === 'undeposited_funds' || event.entity === 'Deposit') accountKeys.add('undepositedFunds');
    for (const key of accountKeys) references.set('Account:' + key, bind(key, 'Account', mappingRows, setup.options.accounts));
    if (details.taxMapping) references.set('TaxCode:' + details.taxMapping, bind(details.taxMapping, 'TaxCode', mappingRows, setup.options.taxCodes));
    const dependencies = event.dependsOn.map(key => ({ logicalKey: key, entity: eventByKey.get(key).entity, source: currentKeys.has(key) ? 'this_operation' : 'prior_period', state: 'unverified' }));
    const blockers = [...references.values()].filter(reference => reference.status !== 'resolved').map(reference => ({ kind: 'record_choice', key: reference.key, reason: reference.reason }));
    for (const dependency of dependencies.filter(value => value.source === 'prior_period')) blockers.push({ kind: 'prior_record', key: dependency.logicalKey, reason: 'The earlier saved transaction and its relationships need verified evidence.' });
    return { logicalKey: event.logicalKey, entity: event.entity, txnDate: event.txnDate, purpose: event.intent.purpose,
      detailsHash, calendarFingerprint: event.fingerprint, details, references: [...references.values()], dependencies, blockers,
      status: blockers.length ? 'blocked' : 'references_resolved' };
  });
  const byKey = new Map(steps.map(step => [step.logicalKey, step]));
  for (const step of steps) for (const dependency of step.dependencies) {
    if (byKey.get(dependency.logicalKey)?.status === 'blocked') { step.blockers.push({ kind: 'blocked_dependency', key: dependency.logicalKey, reason: 'An earlier step in this operation has unresolved requirements.' }); step.status = 'blocked'; }
  }
  const remaining = [
    ...(!view.draft ? [{ key: 'saved_plan', reason: 'Save the reviewed business plan and its exact record choices.' }] : []),
    { key: 'baseline', reason: 'Review the existing company baseline and check for existing activity before deciding which records to create.' },
    { key: 'business_policy', reason: 'Approve the proposed activity, prices and Canadian tax policy.' },
    { key: 'period_control', reason: 'Verify the business cursor, closed periods, inventory starting state and prior-period receipts.' },
    { key: 'execution', reason: 'Connect durable execution, recovery and saved-record/report verification before running this operation.' },
    ...(accounts.currency.status !== 'compatible' ? [{ key: 'home_currency', reason: accounts.currency.reason }] : []),
  ];
  const payload = { version: 1, scope: { realmId: view.realmId, environment: view.environment, connectionId: view.connectionId },
    businessKey: activity.businessKey, openingDate: (view.draft || view.proposal).business.openingDate, blueprintId: view.draft?.id || null,
    blueprintHash: view.draft?.contentHash || null, fromDate: input.fromDate, throughDate: input.throughDate,
    calendarHash: activity.planHash, detailsHash: activity.detailProposal.fingerprint,
    observations: { setup: { sourceHash: setup.sourceHash, observedAt: setup.observedAt }, masters: { sourceHash: masters.sourceHash, observedAt: masters.observedAt } },
    steps, earlierRequirements: [...earlier.values()].map(event => ({ logicalKey: event.logicalKey, entity: event.entity, txnDate: event.txnDate })),
    futureFollowUps: activity.future.length, remaining,
  };
  if (Buffer.byteLength(canonical(payload)) > 8000000) throw problem('The prepared operation exceeds its size budget. Shorten the period.');
  return { ...payload, operationHash: hash(payload), preparedAt: now.toISOString(), readyToExecute: false, persisted: false,
    summary: { steps: steps.length, blockedSteps: steps.filter(step => step.status === 'blocked').length, unresolvedReferences: new Set(steps.flatMap(step => step.references.filter(reference => reference.status !== 'resolved').map(reference => reference.entity + ':' + reference.key))).size },
    limitations: ['This read-only preparation does not decide that planned records are missing or authorize creation.', 'Resolved references are observed record choices, not complete transaction validation. QBO payloads and line-level saved links must be validated before execution.'] };
}
function operationHistoryRoots(prepared) {
  const current = new Set(prepared.steps.map(step => step.logicalKey));
  return [...new Set([...current, ...prepared.steps.flatMap(step => step.dependencies.filter(link => !current.has(link.logicalKey)).map(link => link.logicalKey))])].sort();
}
// Public projection only: original full intents/policies stay in the plan store.
// Saved verification is historical evidence, never a fresh QBO observation.
function attachPreparedOperationHistory(prepared, observed) {
  const { operationHash, preparedAt, readyToExecute, persisted, summary, limitations, ...payload } = JSON.parse(canonical(prepared));
  if (readyToExecute !== false || persisted !== false || hash(payload) !== operationHash) throw problem('Prepared activity changed before its history could be attached.', 409);
  if (observed?.unavailable === true) {
    payload.savedHistory = { version: 1, status: 'unavailable', reason: 'Saved activity history could not be checked. Storage may be unavailable or need preparation.', records: [], missing: [], currentReadback: false, provesAbsence: false };
  } else {
    const { sourceHash, ...source } = observed || {};
    const roots = operationHistoryRoots(prepared), current = new Set(payload.steps.map(step => step.logicalKey));
    if (source.version !== 1 || hash(source) !== sourceHash || canonical(source.scope) !== canonical(payload.scope) || canonical(source.roots) !== canonical(roots) || !Array.isArray(source.entries) || !Array.isArray(source.missing) || source.requiresCurrentReadback !== true) throw problem('Saved activity history does not match this preparation.', 409);
    const entries = new Map(source.entries.map(entry => [entry.logicalKey, entry]));
    if (entries.size !== source.entries.length) throw problem('Saved activity history is ambiguous.', 409);
    const records = source.entries.map(entry => ({ logicalKey: entry.logicalKey, entity: entry.entity, txnDate: entry.step.txnDate, operationId: entry.operationId, planHash: entry.planHash, fingerprint: entry.fingerprint, policyHash: hash(entry.policy), state: entry.state, qboId: entry.qboId, dependencies: entry.step.dependencies.map(link => ({ logicalKey: link.logicalKey, entity: link.entity, fingerprint: link.fingerprint })) }));
    const missingEarlier = source.missing.filter(key => !current.has(key));
    const currentMatches = records.filter(row => current.has(row.logicalKey));
    for (const step of payload.steps) {
      const existing = entries.get(step.logicalKey);
      if (existing) {
        if (existing.entity !== step.entity || existing.step.txnDate !== step.txnDate) throw problem('Saved activity identity conflicts with the current business schedule.', 409);
        step.blockers.push({ kind: 'existing_activity', key: step.logicalKey, operationId: existing.operationId, reason: 'This activity already belongs to a saved operation. Inspect or resume that operation before preparing more work.' });
        step.status = 'blocked';
      }
      for (const link of step.dependencies.filter(value => !current.has(value.logicalKey))) {
        const original = entries.get(link.logicalKey);
        if (!original) continue;
        if (original.entity !== link.entity || original.step.txnDate >= payload.fromDate) throw problem('The original dependency conflicts with the requested activity period.', 409);
        link.fingerprint = original.fingerprint; link.operationId = original.operationId; link.savedState = original.state;
        // Keep the prior-record blocker: original identity is known, live content is not.
        const blocker = step.blockers.find(value => value.kind === 'prior_record' && value.key === link.logicalKey);
        if (blocker) blocker.reason = 'The original saved activity was found. Its current QuickBooks record and relationships still need verification.';
      }
    }
    const proposedEarlier = new Map(payload.earlierRequirements.map(row => [row.logicalKey, row]));
    payload.earlierRequirements = [...records.filter(row => !current.has(row.logicalKey)).map(row => ({ logicalKey: row.logicalKey, entity: row.entity, txnDate: row.txnDate, fingerprint: row.fingerprint, operationId: row.operationId })), ...missingEarlier.map(key => proposedEarlier.get(key)).filter(Boolean)];
    payload.savedHistory = { version: 1, status: currentMatches.length ? 'resume_required' : !records.length ? 'no_local_history' : missingEarlier.length ? 'incomplete' : 'retained', sourceHash, observedAt: source.observedAt, records, missing: source.missing, currentReadback: false, provesAbsence: false };
  }
  if (Buffer.byteLength(canonical(payload)) > 8000000) throw problem('The prepared history exceeds its size budget. Shorten the period.');
  return { ...payload, operationHash: hash(payload), preparedAt, readyToExecute: false, persisted: false, summary: { ...summary, blockedSteps: payload.steps.filter(step => step.status === 'blocked').length }, limitations };
}
module.exports = { validateOperationRequest, prepareBusinessOperation, operationHistoryRoots, attachPreparedOperationHistory, MAX_DAYS, MAX_STEPS };
