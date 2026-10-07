'use strict';
const { fixture, scope, now, clone } = require('./business-transaction-fixtures');
const { hash } = require('../../src/modules/business-calendar');
const { operationHistoryRoots } = require('../../src/modules/business-operation-preview');
function signPrepared(value) {
  const { operationHash, preparedAt, readyToExecute, persisted, summary, limitations, ...payload } = value;
  value.operationHash = hash(payload); return value;
}
function signHistory(value) { const { sourceHash, ...payload } = value; value.sourceHash = hash(payload); return value; }
function candidateFixture(earlier = false) {
  const po = fixture('PurchaseOrder'), bill = fixture('Bill');
  if (earlier) { po.step.txnDate = '2026-10-05'; po.approve(); }
  bill.step.details.references = [{ logicalKey: po.step.logicalKey, entity: 'PurchaseOrder' }];
  bill.step.detailsHash = hash({ calendarFingerprint: bill.step.calendarFingerprint, details: bill.step.details });
  bill.step.dependencies = [{ logicalKey: po.step.logicalKey, entity: 'PurchaseOrder', fingerprint: hash(po.step) }]; bill.approve();
  const context = { scope: clone(scope), businessKey: 'flagship', blueprintId: 'e'.repeat(24), blueprintHash: hash('blueprint'), baselineHash: hash('baseline'), openingDate: '2026-10-01', expectedCursor: '2026-10-05', expectedRevision: 1,
    requiredAssertions: [{ key: 'trial-balance', evidenceType: 'accrual-ledger', currency: 'CAD', basis: 'Accrual' }] };
  const proposed = step => ({ ...clone(step), blockers: [], status: 'references_resolved', dependencies: step.dependencies.map(({ logicalKey, entity }) => ({ logicalKey, entity, source: earlier ? 'prior_period' : 'this_operation', state: 'unverified' })) });
  const prepared = signPrepared({ version: 1, scope: clone(scope), businessKey: context.businessKey, blueprintId: context.blueprintId, openingDate: context.openingDate, blueprintHash: context.blueprintHash, fromDate: '2026-10-06', throughDate: '2026-10-06', steps: earlier ? [proposed(bill.step)] : [proposed(bill.step), proposed(po.step)], earlierRequirements: [], remaining: [{ key: 'baseline', reason: 'Review existing records.' }, { key: 'business_policy', reason: 'Approve exact policies.' }, { key: 'period_control', reason: 'Fence the current calendar.' }, { key: 'execution', reason: 'Verify runtime readiness.' }], preparedAt: new Date(now).toISOString(), readyToExecute: false, persisted: false, summary: {}, limitations: [] });
  if (earlier) { prepared.steps[0].blockers.push({ kind: 'prior_record', key: po.step.logicalKey }); signPrepared(prepared); }
  const history = signHistory({ version: 1, scope: clone(scope), roots: operationHistoryRoots(prepared), entries: earlier ? [{ businessKey: 'flagship', operationId: 'f'.repeat(24), planHash: hash('original plan'), runStatus: 'complete', logicalKey: po.step.logicalKey, entity: 'PurchaseOrder', fingerprint: hash(po.step), state: 'saved', revision: 1, qboId: '100', step: clone(po.step), policy: clone(po.policy) }] : [], missing: prepared.steps.map(step => step.logicalKey).sort(), observedAt: new Date(now).toISOString(), requiresCurrentReadback: true });
  const policies = assembly => assembly.candidate.entries.filter(entry => entry.kind === 'create').map(entry => ({ logicalKey: entry.step.logicalKey, policy: { ...clone(entry.step.entity === 'Bill' ? bill.policy : po.policy), stepHash: hash(entry.step) } }));
  return { prepared, history, context, now, po, bill, policies };
}
module.exports = { candidateFixture, signPrepared, signHistory };
