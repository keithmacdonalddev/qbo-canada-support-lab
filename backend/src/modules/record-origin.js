'use strict';
const { identity } = require('./record-queries');
const { businessTransportEvidence, assertBusinessTransportAudits } = require('./business-dispatch-receipt');
const LIMIT = 20;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const validDate = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toISOString() : null; };

// Exact saved creation receipts only. Names, prefixes, balances and links never
// establish origin, and origin does not grant permission to change a record.
function originPipelines({ userId, realmId, environment, entity, id }) {
  const owner = { userId, realmId };
  const unknownEnvironment = { $or: [{ environment: { $exists: false } }, { environment: null }] };
  const finish = projection => [{ $sort: { createdAt: -1, _id: -1 } }, { $limit: LIMIT + 1 }, { $project: projection }];
  const legacyTools = { Invoice: 'createInvoice', Payment: 'applyPayment', Bill: 'createBill', BillPayment: 'applyBillPayment' };
  const creations = prefix => [{ [prefix + 'toolName']: 'createRecord', [prefix + 'toolInput.entityType']: entity,
    [prefix + 'result.data.entityType']: entity }, ...(Object.hasOwn(legacyTools, entity) ? [{ [prefix + 'toolName']: legacyTools[entity] }] : [])];
  const caseMatch = { 'steps.status': 'completed', 'steps.result.success': true,
    'steps.result.outcomeUnknown': { $ne: true }, 'steps.result.data.id': id,
    $and: [{ $or: creations('steps.') }, { $or: [{ 'steps.executionScope': { $exists: false } },
      { 'steps.executionScope.version': 1, 'steps.executionScope.realmId': realmId, 'steps.executionScope.environment': environment }] }] };
  return [
    { key: 'assistant', collection: 'aiplans', pipeline: [
      { $match: { ...owner, steps: { $elemMatch: { status: 'completed', 'result.success': true, 'result.data.id': id, $or: creations('') } } } },
      { $unwind: '$steps' }, { $match: caseMatch },
      ...finish({ _id: 1, sessionId: 1, createdAt: '$steps.executedAt', step: '$steps.stepNumber', executionScope: '$steps.executionScope' }),
      { $lookup: { from: 'aisessions', let: { session: '$sessionId' }, pipeline: [
        { $match: { ...owner, mode: 'reproduce', $expr: { $eq: ['$_id', '$$session'] } } }, { $project: { _id: 1 } }, { $limit: 1 },
      ], as: 'cases' } },
    ] },
    { key: 'generation', collection: 'generationruns', pipeline: [
      { $match: { ...owner, environment, executionVersion: 1, steps: { $elemMatch: { state: 'succeeded', 'transaction.entity': entity, 'receipt.Id': id } } } },
      { $unwind: '$steps' }, { $match: { 'steps.state': 'succeeded', 'steps.transaction.entity': entity, 'steps.receipt.Id': id } },
      ...finish({ _id: 1, createdAt: '$steps.completedAt', connectionId: 1 }),
    ] },
    { key: 'legacy_generation', collection: 'generationruns', pipeline: [
      { $match: { ...owner, ...unknownEnvironment, createdTransactions: { $elemMatch: { entity, qboId: id } } } },
      { $unwind: '$createdTransactions' }, { $match: { 'createdTransactions.entity': entity, 'createdTransactions.qboId': id } },
      ...finish({ _id: 1, createdAt: '$createdTransactions.timestamp' }),
    ] },
    ...[['seed', 'seedruns'], ['issue_pack', 'issuepackruns']].map(([key, collection]) => ({ key, collection, pipeline: [
      { $match: { ...owner, ...unknownEnvironment, createdEntities: { $elemMatch: { entity: key === 'seed' ? { $in: [entity, entity.toLowerCase()] } : entity, qboId: id } } } },
      { $unwind: '$createdEntities' }, { $match: { 'createdEntities.entity': key === 'seed' ? { $in: [entity, entity.toLowerCase()] } : entity, 'createdEntities.qboId': id } },
      ...finish({ _id: 1, createdAt: '$createdEntities.timestamp' }),
    ] })),
    { key: 'business_operation', collection: 'qbowritereceipts', pipeline: [
      { $match: { ownerId: userId, realmId, environment, kind: 'business', operation: 'create', state: 'saved', entity: entity.toLowerCase(), 'observed.qboId': id } },
      { $sort: { sentAt: -1, _id: -1 } }, { $limit: LIMIT + 1 },
      { $project: { _id: 1, contractVersion: 1, ownerId: 1, actorId: 1, realmId: 1, environment: 1, connectionId: 1, operationId: 1, logicalKey: 1, dispatchKey: 1, requestHash: 1, entity: 1, kind: 1, operation: 1, state: 1, observed: 1, sentAt: 1, observedAt: 1, startAuditId: 1, resultAuditId: 1 } },
      { $lookup: { from: 'auditlogs', let: { start: '$startAuditId', result: '$resultAuditId' }, pipeline: [
        { $match: { userId, realmId, $expr: { $in: ['$_id', ['$$start', '$$result']] } } },
        { $limit: 3 }, { $project: { _id: 1, userId: 1, actorUserId: 1, realmId: 1, action: 1, actionType: 1, outcome: 1, inputParams: 1, afterState: 1 } },
      ], as: 'audits' } },
    ] },
  ];
}

async function readRecordOrigin({ db, userId, realmId, environment, entity: suppliedEntity, id: suppliedId }) {
  const { entity, id } = identity(suppliedEntity, suppliedId);
  if (!db || !userId || !realmId || !['production', 'sandbox'].includes(environment)) throw new Error('Record origin scope is unavailable');
  const jobs = originPipelines({ userId, realmId, environment, entity, id });
  const results = await Promise.allSettled(jobs.map(job => db.collection(job.collection).aggregate(job.pipeline, { maxTimeMS: 5000 }).toArray()));
  const sources = [], incompleteSources = [];
  results.forEach((result, index) => {
    const kind = jobs[index].key;
    if (result.status !== 'fulfilled' || !Array.isArray(result.value)) { incompleteSources.push(kind); return; }
    if (result.value.length > LIMIT) incompleteSources.push(kind);
    for (const row of result.value.slice(0, LIMIT)) {
      if (kind === 'business_operation') {
        try {
          if (!row || String(row.ownerId) !== String(userId) || row.realmId !== realmId || row.environment !== environment || row.kind !== 'business' || row.operation !== 'create' || row.state !== 'saved' || row.entity !== entity.toLowerCase() || row.observed?.qboId !== id) throw new Error('Mismatched origin');
          const evidence = businessTransportEvidence({ realmId, environment, connectionId: String(row.connectionId), operationId: String(row.operationId), logicalKey: row.logicalKey, entity, dispatch: { key: row.dispatchKey, requestHash: row.requestHash, actorId: String(row.actorId) } }, row);
          if (!evidence) throw new Error('Unsettled origin');
          assertBusinessTransportAudits(row, evidence, row.audits);
          const createdAt = validDate(row.observedAt), sentAt = validDate(row.sentAt);
          if (!createdAt || !sentAt || createdAt < sentAt) throw new Error('Missing observation interval');
          sources.push({ kind, sourceId: row._id, operationId: String(row.operationId), connectionId: String(row.connectionId), caseId: null, scope: 'recorded_environment', createdAt });
        } catch { incompleteSources.push(kind); }
        continue;
      }
      if (!OBJECT_ID.test(String(row._id))) { incompleteSources.push(kind); continue; }
      const caseId = kind === 'assistant' && row.cases?.length === 1 && OBJECT_ID.test(String(row.cases[0]._id)) ? String(row.cases[0]._id) : null;
      const verified = kind === 'generation' ? OBJECT_ID.test(String(row.connectionId))
        : kind === 'assistant' && row.executionScope?.version === 1 && row.executionScope.realmId === realmId
          && row.executionScope.environment === environment && OBJECT_ID.test(String(row.executionScope.connectionId));
      sources.push({ kind: caseId ? 'support_case' : kind, sourceId: String(row._id), caseId,
        scope: verified ? 'recorded_environment' : 'environment_unrecorded', createdAt: validDate(row.createdAt),
        ...(kind === 'assistant' && Number.isSafeInteger(row.step) && row.step > 0 ? { step: row.step } : {}) });
    }
  });
  if (sources.filter(source => source.kind === 'business_operation').length > 1) incompleteSources.push('business_operation');
  const complete = incompleteSources.length === 0;
  return { entity, id, sources, complete, incompleteSources: [...new Set(incompleteSources)],
    status: !complete ? 'incomplete' : sources.some(source => source.scope === 'recorded_environment') ? 'recorded' : sources.length ? 'historical_match' : 'unknown',
    checkedAt: new Date().toISOString(), baseline: 'unclassified' };
}
module.exports = { readRecordOrigin, originPipelines, LIMIT };
