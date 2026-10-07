const labels = {
  previewed: 'Awaiting plan approval', approved: 'Ready to run', reserved: 'Preparing records',
  running: 'Creating and checking records', blocked: 'Needs attention', stopped: 'Stopped',
  'awaiting-evidence': 'Needs verification', committing: 'Saving verification', verified: 'Verification recorded',
}
export function operationStatus(operation) {
  if (operation.completion) return 'Verified'
  if (operation.execution?.pending) return operation.stopRequested ? 'Stopping safely' : operation.status === 'approved' ? 'Queued' : operation.status === 'awaiting-evidence' ? 'Checking results' : labels[operation.status] || 'Work requested'
  if (['running', 'reserved'].includes(operation.status)) return 'Interrupted — ready to continue'
  return labels[operation.status] || 'Status unavailable'
}
export function operationActions(operation, permissions, stale = false) {
  const known = Object.hasOwn(labels, operation?.status || '')
  return {
    execute: !stale && known && permissions?.execute === true && !operation.execution?.pending && !['previewed', 'stopped', 'verified'].includes(operation.status),
    stop: !stale && known && permissions?.stop === true && !['previewed', 'stopped', 'verified'].includes(operation.status) && !operation.stopRequested && (operation.status !== 'approved' || operation.execution?.pending === true),
  }
}
export function assertOperationScope(value, realmId, environment, connectionId) {
  if (value?.scope?.realmId !== realmId || value.scope.environment !== environment || !/^[a-f0-9]{24}$/.test(value.scope.connectionId || '') || (connectionId && value.scope.connectionId !== connectionId)) throw new Error('The company connection changed. Reload this page before continuing.')
  return value
}
export function operationError(error) {
  if (error?.response?.data?.code === 'BUSINESS_STORAGE_UNPREPARED') return 'Business operation setup is incomplete. Saved operations cannot run until setup is finished.'
  if (error?.response?.status === 404) return 'Business operations are not available on the running server yet.'
  const text = error?.response?.data?.error
  return typeof text === 'string' ? text : error?.message === 'The company connection changed. Reload this page before continuing.' ? error.message : 'Progress could not be checked. Saved work has been retained.'
}
