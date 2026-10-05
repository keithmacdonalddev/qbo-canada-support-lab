const LEASE_MS = 10 * 60 * 1000;
const LABELS = { completed: 'Successful', partial: 'Partially successful', failed: 'Failed', interrupted: 'Needs attention', pending: 'Waiting', in_progress: 'Running' };
const SUMMARY_KEYS = { invoice: 'invoices', payment: 'payments', creditmemo: 'creditMemos', bill: 'bills', billpayment: 'billPayments', vendorcredit: 'vendorCredits', journalentry: 'journalEntries' };

function generationView(document, now = Date.now()) {
  if (!document) return null;
  const run = document.toObject ? document.toObject() : { ...document };
  const steps = run.steps || [];
  const modern = run.executionVersion === 1;
  const active = modern && !!run.leaseToken && new Date(run.leaseExpiresAt).getTime() > now;
  const needsInspection = s => s.state === 'uncertain' || (!active && s.state === 'sending');
  const uncertain = steps.filter(needsInspection).length;
  const errors = modern ? steps.filter(s => s.state === 'rejected' || needsInspection(s)).map(s => ({
    type: s.entity, detail: s.error || 'Result not confirmed. Inspect QuickBooks before retrying.', txnDate: s.payload.TxnDate,
  })) : run.generationErrors || [];
  const transactions = modern ? steps.filter(s => s.state === 'succeeded').map(s => ({
    ...s.transaction, qboId: s.receipt.Id, docNumber: s.receipt.DocNumber || '', timestamp: s.completedAt,
    linkedTo: (s.transaction.linkedTo || '').replace(/\$step:(\d+)/g, (_m, index) => steps[Number(index)]?.receipt?.Id || 'unconfirmed'),
  })) : run.createdTransactions || [];
  const created = modern ? steps.filter(s => s.state === 'succeeded').length : (run.createdTransactions || []).length;
  const failed = modern ? steps.filter(s => s.state === 'rejected').length : (run.generationErrors || []).length;
  const pending = modern ? steps.filter(s => s.state === 'pending').length : null;
  const auditPending = steps.filter(s => s.state === 'succeeded' && !s.audited).length;
  let status = run.status;
  if (modern && active) status = 'in_progress';
  else if (modern && (uncertain || ['pending', 'in_progress'].includes(status))) status = 'interrupted';
  else if (!modern && ['pending', 'in_progress'].includes(status)) status = 'interrupted';
  else if (!modern && (failed || status === 'failed')) status = created ? 'partial' : 'failed';
  const success = status === 'completed' && !failed && !uncertain && !auditPending && (!modern || (steps.length > 0 && created === steps.length));
  if (status === 'completed' && !success) status = created ? 'partial' : 'failed';
  const canResume = modern && !active && !uncertain && !success;
  const summary = modern ? Object.fromEntries(Object.values(SUMMARY_KEYS).map(k => [k, 0])) : run.txnsSummary;
  if (modern) for (const step of steps) if (step.state === 'succeeded') summary[SUMMARY_KEYS[step.entity]]++;
  const inspection = steps.filter(needsInspection).map(s => ({
    entity: s.transaction.entity, txnDate: s.transaction.txnDate, amount: s.transaction.amount,
    customerOrVendor: s.transaction.customerOrVendor,
    linkedTo: (s.transaction.linkedTo || '').replace(/\$step:(\d+)/g, (_m, index) => steps[Number(index)]?.receipt?.Id || 'unconfirmed'),
  }));
  const recoveryMessage = uncertain
    ? 'QuickBooks may have accepted a transaction whose result was not saved. Check the run details in QuickBooks before creating more records.'
    : !modern && !success ? 'This older run has no saved recovery plan. Inspect its existing records before creating more history.'
      : auditPending && !active ? 'Records were created, but their audit entries need to be saved. Resume will repair the audit without recreating records.'
        : canResume ? 'Resume uses the saved plan and skips records already created.' : null;
  // Keep payloads and internal lock tokens off the public response.
  const { steps: _steps, leaseToken: _token, ...safe } = run;
  return { ...safe, generationErrors: errors, createdTransactions: transactions, status, statusLabel: LABELS[status] || status, success, canResume,
    canCreateAdditional: success, recoveryMessage, inspection, txnsSummary: summary,
    counts: { created, failed, pending, uncertain, auditPending, planned: modern ? steps.length : null } };
}

module.exports = { LEASE_MS, SUMMARY_KEYS, generationView };
