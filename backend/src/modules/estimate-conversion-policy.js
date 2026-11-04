'use strict';
// Intuit Invoice reference checked 2026-11-02. Ordinary Estimate links are API
// writable; Progress Invoicing is not. Never change company preferences to admit one.
const { hash } = require('./business-calendar');
const CODE = 'BUSINESS_ESTIMATE_NATIVE_REQUIRED';
const DOCUMENTATION = 'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice';
const NATIVE_REASON = 'Estimate conversion requires the native QuickBooks workflow while Progress Invoicing is on or its setting is unverified. Keep existing invoices; do not retry the conversion through the API, create replacements or change company settings.';
const SUPPORT = Object.freeze({ apiWritable: 'only-with-observed-progress-invoicing-off', nativeWorkflowRequiredWhen: ['on', 'unknown'], automaticNativeExecution: false, automaticNativeRepair: true, repairTool: 'repairEstimateConversion', reason: NATIVE_REASON, documentation: DOCUMENTATION, checkedOn: '2026-11-02' });
function estimateIds(value) {
  const ids = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'LinkedTxn' && Array.isArray(child)) { for (const link of child) if (link?.TxnType === 'Estimate') ids.push(link.TxnId); }
      else if (key !== 'LinkedTxn') visit(child);
    }
  };
  visit(value); return ids;
}
function needsConversion(entity, operation, payload, existingLinks = []) {
  return entity.toLowerCase() === 'invoice' && ['create', 'update'].includes(operation) && estimateIds(payload).some(id => !existingLinks.some(link => link.entity === 'Estimate' && link.id === id));
}
function supportFor(preferences) {
  const sales = preferences?.SalesFormsPrefs, flag = sales && Object.hasOwn(sales, 'UsingProgressInvoicing') ? sales.UsingProgressInvoicing : null;
  return { ...SUPPORT, progressInvoicing: flag === false ? 'off' : flag === true ? 'on' : 'unknown', apiWritable: flag === false, route: flag === false ? 'api' : 'native', ...(flag !== false ? { code: CODE } : {}) };
}
function refused(detail = {}) {
  return Object.assign(new Error(NATIVE_REASON), { status: 409, code: CODE, qboStage: 'write_admission', outcomeUnknown: false, businessDetail: { ...detail, nativeWorkflow: 'Convert the exact estimate in QuickBooks, or attach it to the already-saved invoice, preserving the original accounting. Verify both links and the estimate closure.', automaticNativeExecution: false } });
}
// Preparation uses scoped synced settings only; fresh native admission is mandatory.
async function readSyncedSupport({ Records, scope, session, now = Date.now() }) {
  if (!Records) return supportFor(null);
  let query = Records.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, entity: 'Preferences', deleted: false });
  if (session) query = query.session(session);
  const rows = await query.select('record lastObservedAt').limit(2).maxTimeMS(3000).lean();
  const row = rows.length === 1 ? rows[0] : null, at = new Date(row?.lastObservedAt || 0).getTime();
  return supportFor(row && at > 0 && at <= now && now - at <= 12 * 3600000 ? row.record : null);
}
// This runs only at NEW SDK admission, after the period proof was authenticated.
// It is deliberately separate from historical/native protected-period verification.
function assertApiEstimateSupport(request, proof) {
  const payload = JSON.parse(request.body), evidence = proof?.evidence;
  const existing = evidence?.records?.find(row => row.entity === 'Invoice' && row.id === request.targetId)?.links || [];
  if (!needsConversion(request.entity, request.operation, payload, existing)) return;
  if (evidence?.requestHash !== request.requestHash || evidence?.estimateConversion?.usingProgressInvoicing !== false || evidence.estimateConversion.preferencesHash !== evidence.preferencesHash || !/^[a-f0-9]{64}$/.test(evidence.preferencesHash || '')) throw refused({ entity: 'Invoice', estimateIds: estimateIds(payload).filter(id => typeof id === 'string') });
  return { kind: 'api-estimate-conversion', preferencesHash: evidence.preferencesHash, evidenceHash: hash(evidence) };
}
function assertPlanSupport(plan, support) {
  const steps = plan?.steps || plan?.records || plan?.entries?.map(entry => ({...entry.step,kind:entry.kind})) || [];
  const byKey = new Map([...steps,...(plan?.earlierRequirements || [])].map(step => [step.logicalKey,step]));
  const conversions = steps.filter(step => step.entity === 'Invoice' && !['existing','fulfilled'].includes(step.kind) && (step.dependencies || step.relationships || []).some(link => (typeof link === 'object' ? link.entity : null) === 'Estimate' || byKey.get(typeof link === 'string' ? link : link.logicalKey)?.entity === 'Estimate'));
  if (conversions.length && support?.apiWritable !== true) throw refused({ logicalKeys: conversions.slice(0,20).map(step => step.logicalKey), beforeSourceWrites: true });
}
module.exports = { assertPlanSupport, CODE, SUPPORT, NATIVE_REASON, DOCUMENTATION, estimateIds, needsConversion, supportFor, readSyncedSupport, assertApiEstimateSupport, refused };
