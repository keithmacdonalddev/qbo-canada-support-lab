const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/
export function assertBaselineScope(value, realmId, environment, connectionId) {
  if (!value || value.scope?.realmId !== String(realmId) || value.scope?.environment !== environment || !ID.test(value.scope?.connectionId || '') || (connectionId && value.scope.connectionId !== connectionId)) throw new Error('The selected company changed. Refresh this page.')
  return value
}
export function baselineRequestKey(actorId, scope) {
  if (!ID.test(actorId || '') || !ID.test(scope?.connectionId || '') || !['production', 'sandbox'].includes(scope?.environment) || !/^\d+$/.test(scope?.realmId || '')) throw new Error('The current company and user must be confirmed.')
  return ['tdl-baseline-request', actorId, scope.environment, scope.realmId, scope.connectionId].join(':')
}
export function pendingBaselineRequest(storage, key, scope) {
  const raw = storage.getItem(key)
  if (!raw) return null
  const request = JSON.parse(raw)
  if (!request || Object.keys(request).sort().join(',') !== 'blueprintHash,blueprintId,connectionId,fromDate,purpose,requestKey,throughDate' || !/^[a-zA-Z0-9_-]{16,100}$/.test(request.requestKey || '') || request.connectionId !== scope.connectionId || !ID.test(request.blueprintId || '') || !HASH.test(request.blueprintHash || '') || !['company-survey', 'opening-balances'].includes(request.purpose) || ![request.fromDate, request.throughDate].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value || ''))) throw new Error('The saved observation request needs review before another can be sent.')
  return request
}
export function validateBaselineDates(request) {
  const days = [request?.fromDate, request?.throughDate].map(value => {
    const time = Date.parse(value + 'T12:00:00Z')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('Choose valid report dates.')
    return time
  })
  if (days[0] > days[1] || days[1] - days[0] > 366 * 86400000) throw new Error('Choose a report period of at most one year.')
}
export async function captureBaseline({ api, storage, key, scope, request, signal, newKey = () => crypto.randomUUID() }) {
  const previous = pendingBaselineRequest(storage, key, scope)
  if (!previous) validateBaselineDates(request)
  const input = previous || { ...request, requestKey: newKey() }
  // Persist before sending. A refresh or lost response must reuse this exact request.
  storage.setItem(key, JSON.stringify(input))
  let response
  try { response = await api.post('/company/business-baseline', input, { signal, timeout: 210000 }) }
  catch (error) {
    if (error.response?.status === 400 && error.response.data?.code === 'BUSINESS_BASELINE_REQUEST_INVALID' && error.response.data?.notSaved === true) storage.removeItem(key)
    throw error
  }
  const result = assertBaselineScope(response.data?.data, scope.realmId, scope.environment, scope.connectionId)
  if (!ID.test(result.id || '') || result.status !== 'captured' || result.persisted !== true || result.accepted !== false || result.activated !== false || result.blueprint?.id !== input.blueprintId || result.blueprint?.contentHash !== input.blueprintHash || result.purpose !== input.purpose || result.period?.fromDate !== input.fromDate || result.period?.throughDate !== input.throughDate || !HASH.test(result.evidenceHash || '')) throw new Error('The saved observation could not be confirmed. Retry the same request.')
  storage.removeItem(key)
  return result
}
