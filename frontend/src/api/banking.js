import client from './client'

// BF4 v1. Company scope is server-owned; callers never send realm/account overrides.
const base = '/company/banking-workspace'
const segment = value => encodeURIComponent(String(value))
export const bankingApi = {
  async monthlyStatements(accountId,{signal,...params}={}) {return (await client.get(base+'/accounts/'+segment(accountId)+'/statements',{signal,params})).data?.data},
  async issueMonthlyStatements(accountId,statementId) {return (await client.post(base+'/statements/issue',{accountId,...(statementId?{statementId}:{})})).data?.data},
  async monthlyStatementFile(accountId,statementId,file,{signal}={}) {const response=await client.get(base+'/accounts/'+segment(accountId)+'/statements/'+segment(statementId)+'/files/'+segment(file.fileId),{signal,responseType:'blob'}),blob=response.data,digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()),actual=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');if(actual!==file.sha256)throw new Error('Retained monthly statement hash changed. Inspect its original publication.');return blob},

  async currentFeeds(accountId,{signal,...params}={}) {return (await client.get(base+'/accounts/'+segment(accountId)+'/feeds',{signal,params})).data?.data},
  async publishCurrentFeed(accountId,publicationId) {return (await client.post(base+'/feeds/publish',{accountId,...(publicationId?{publicationId}:{})})).data?.data},
  async publishCumulativeFeed(input) {return (await client.post(base+'/feeds/cumulative',input)).data?.data},
  async currentFeedFile(accountId,publicationId,file,{signal}={}) {const response=await client.get(base+'/accounts/'+segment(accountId)+'/feeds/'+segment(publicationId)+'/files/'+segment(file.fileId),{signal,responseType:'blob'}),blob=response.data,digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()),actual=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');if(actual!==file.sha256)throw new Error('Current bank feed hash changed. Inspect the original publication before retrying.');return blob},

  async originPolicy(accountId,{signal,offset,limit,expectedHash}={}) {return (await client.get(base+'/accounts/'+segment(accountId)+'/origin-policy',{signal,params:{offset,limit,expectedHash}})).data?.data},
  async configureOriginPolicy(input) {return (await client.post(base+'/origins/policy',input)).data?.data},
  async processOriginDue(accountId) {return (await client.post(base+'/origins/process',{accountId})).data?.data},
  async addOriginAdvice(input) {return (await client.post(base+'/origins/advice',input)).data?.data},
  async bookOriginEvent(accountId,eventId) {return (await client.post(base+'/origins/book',{accountId,eventId})).data?.data},
  async accounts({ signal } = {}) {
    const data = (await client.get(base + '/accounts', { signal })).data?.data
    if (!Array.isArray(data?.accounts)) throw new Error('The server did not return retained bank accounts. Try refreshing.')
    return data
  },
  async account(accountId, { period, signal } = {}) {
    const data = (await client.get(base + '/accounts/' + segment(accountId), { signal, params: period ? { period } : undefined })).data?.data
    if (data?.accountId !== accountId || !Array.isArray(data?.transactions) || !data.package?.id) throw new Error('The server did not return this retained bank account. Refresh and select it again.')
    return data
  },
  async retryInstructions(runId) {
    const data = (await client.post(base + '/instructions/retry', runId ? { runId } : {})).data?.data
    if (!Array.isArray(data?.results) || data.qboCalls !== 0) throw new Error('Bank-only recovery was not confirmed. Refresh before retrying.')
    return data
  },
  async settleInstructions(accountId) {
    const data = (await client.post(base + '/instructions/settle', { accountId })).data?.data
    if (!Array.isArray(data?.results) || data.qboCalls !== 0) throw new Error('Bank settlement was not confirmed. Refresh before retrying.')
    return data
  },
  async resume(packageId, resolution) {
    const data = (await client.post(base + '/operator/resume', { packageId, resolution })).data?.data
    if (data?.resolved !== true || data.packageId !== packageId) throw new Error('The server did not confirm this banking resolution. Refresh and inspect the current pause before retrying.')
    return data
  },
  async list({ signal } = {}) {
    const data = (await client.get(base, { signal })).data?.data
    if (!Array.isArray(data?.packages)) throw new Error('The server did not return a banking workspace. Refresh after integration is complete.')
    return data
  },
  async detail(id, { signal } = {}) {
    const data = (await client.get(base + '/packages/' + segment(id), { signal })).data?.data
    if (data?.id !== id || !data.snapshot || !data.evidence) throw new Error('The server did not return the requested banking package. Refresh and select the month again.')
    return data
  },
  async file(id, file, { signal } = {}) {
    const response = await client.get(base + '/packages/' + segment(id) + '/files/' + segment(file.fileId), { signal, responseType: 'blob' })
    const blob = response.data
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (actual !== file.sha256) throw new Error('The downloaded file has changed. Refresh the package before using it.')
    return blob
  },
}

export function bankingError(error) {
  if (error.response?.status === 404) return error.response?.data?.error || 'The requested bank account or retained statement is unavailable. Return to accounts and select another period.'
  return error.response?.data?.error || error.message || 'Banking could not be loaded. Try refreshing.'
}

export function bankMoney(minor, currency) {
  if (!Number.isSafeInteger(minor)) return 'Unavailable'
  // Format integer minor units without rounding near the safe-integer boundary.
  const digits = (BigInt(minor) < 0n ? -BigInt(minor) : BigInt(minor)).toString().padStart(3, '0')
  return (minor < 0 ? '−' : '') + currency + ' ' + BigInt(digits.slice(0, -2)).toLocaleString('en-CA') + '.' + digits.slice(-2)
}

export function bankingPeriodState(pkg) {
  const summary = pkg.summary || {}, snapshot = pkg.snapshot || pkg
  const total = snapshot.rows?.length ?? (snapshot.files || []).filter(file => file.kind === 'csv').reduce((sum, file) => sum + file.rowCount, 0)
  const noUpload = summary.uploadRequired === false
  const superseded = Boolean(pkg.evidence?.supersededBy)
  const blockers = snapshot.blockers || []
  return {
    total, blockers, superseded,
    needsReview: Boolean(summary.needsReview || superseded),
    stages: [
      { key: 'generated', label: 'Generated', value: summary.generated ? 'Ready' : 'Not generated', done: summary.generated === true },
      { key: 'uploaded', label: 'Uploaded', value: noUpload ? 'Not required' : summary.uploaded ? 'Confirmed' : 'Not confirmed', done: !noUpload && summary.uploaded === true },
      { key: 'reviewed', label: 'Reviewed', value: noUpload ? 'No rows' : (summary.reviewed ?? 0) + ' / ' + total, done: total > 0 && summary.reviewed === total },
      { key: 'reconciled', label: 'Reconciled', value: summary.reconciled ? 'Evidence retained' : 'Not completed', done: summary.reconciled === true },
    ],
  }
}

export function currentBankingPackages(packages) {
  const current = new Map()
  for (const pkg of packages) {
    const key = pkg.accountId + ':' + pkg.period
    if (!current.has(key) || pkg.revision > current.get(key).revision) current.set(key, pkg)
  }
  // Oldest first per account: native reconciliation must proceed chronologically.
  return [...current.values()].sort((a, b) => a.accountId.localeCompare(b.accountId, undefined, { numeric: true }) || a.period.localeCompare(b.period))
}

export function bankingEvidenceEntries(pkg) {
  const state = pkg.evidence || {}, entries = [], seen = new Set()
  const add = (stage, ev) => {
    if (!ev) return
    const key = JSON.stringify([stage, ev.observedAt, ev.artifact?.sha256, ev.note, ev.automation])
    if (!seen.has(key)) { seen.add(key); entries.push({ stage, ...ev }) }
  }
  for (const run of state.imports || []) for (const ev of run.evidence || []) add('Import · ' + run.status, ev)
  for (const [id, row] of Object.entries(state.rows || {})) {
    for (const action of ['reviewed', 'matched', 'added', 'excluded']) add(id + ' · ' + action, row[action]?.evidence)
    for (const ev of row.synced || []) add(id + ' · synced ' + ev.entity + ' #' + ev.id, ev)
  }
  for (const key of ['report', 'completion', 'statementAttachment', 'evidence']) add('Reconciliation · ' + key, state.reconciled?.[key])
  for (const entry of state.history || []) add('History · ' + entry.action, entry.evidence)
  return entries
}

// BF7's journal status is optional until BF6 exposes it. Never infer independent
// observation from a screenshot label or borrow another package's operator run.
export function bankingOperatorStatus(pkg, status) {
  if (!status || status.packageId !== pkg.id || status.accountId !== pkg.accountId || status.period !== pkg.period) return null
  const scope = pkg.snapshot?.scope
  if (!scope || !Array.isArray(status.steps) || status.steps.some(run => run.packageId !== pkg.id || run.accountId !== pkg.accountId || run.period !== pkg.period || ['environment', 'realmId', 'connectionId'].some(key => run.scope?.[key] !== scope[key]))) return null
  return status
}
