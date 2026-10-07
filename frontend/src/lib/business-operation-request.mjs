import { assertOperationScope, operationActions } from './business-operation-view.mjs'

// A lost acknowledgement retains its key. If retry acknowledges already-settled
// work, inspect current saved state before starting one new continuation.
export async function requestBusinessOperation({ api, operation, keys, realmId, environment, connectionId, isCurrent = () => true, newKey = () => crypto.randomUUID() }) {
  const identity = operation.operationId + ':' + operation.planHash
  const path = '/business-operations/' + operation.operationId
  async function submit() {
    if (!isCurrent()) throw new Error('Operation view changed')
    const requestKey = keys.get(identity) || newKey()
    keys.set(identity, requestKey)
    const response = await api.post(path + '/execute', { planHash: operation.planHash, requestKey }, { timeout: 20000 })
    const result = response.data?.data
    if (result?.operationId !== operation.operationId || typeof result.accepted !== 'boolean') throw new Error('Operation response could not be confirmed')
    return result
  }
  let result = await submit()
  if (result.accepted && result.reused && result.execution?.pending === false) {
    const response = await api.get(path, { timeout: 12000 })
    const latest = assertOperationScope(response.data?.data, realmId, environment, connectionId)
    if (!isCurrent() || latest.operationId !== operation.operationId || latest.planHash !== operation.planHash) throw new Error('Operation view changed')
    keys.delete(identity)
    if (operationActions(latest, latest.permissions).execute) result = await submit()
    else result = { ...result, accepted: false, state: latest.status }
  }
  return result
}
