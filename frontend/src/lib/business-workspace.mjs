// Shared formatting and scope checks for the continuously monitored Company workspace.
export function workspaceScope(value, scope) {
  const actual = value?.scope
  if (!/^\d{1,30}$/.test(String(scope?.realmId || '')) || !/^[a-f0-9]{24}$/.test(String(scope?.connectionId || '')) || !['production', 'sandbox'].includes(scope?.environment)) throw new Error('A connected company is required before reading this workspace.')
  if (!actual || !['realmId', 'environment', 'connectionId'].every(key => String(actual[key] || '') === String(scope[key] || '')) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('The selected company changed. Refresh this workspace before continuing.')
  return value
}
export function ageLabel(value, now = Date.now()) {
  const stamp = value ? new Date(value).getTime() : NaN
  if (!Number.isFinite(stamp)) return 'Not yet observed'
  const seconds = Math.max(0, Math.floor((now - stamp) / 1000))
  if (seconds < 5) return 'Just now'
  if (seconds < 60) return seconds + 's ago'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago'
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago'
  return Math.floor(seconds / 86400) + 'd ago'
}
export function syncPresentation(sync, settings, now = Date.now()) {
  const sources = Array.isArray(sync?.sources) ? sync.sources : Object.entries(sync?.sources || {}).map(([entity, source]) => ({ entity, ...source }))
  const last = sync?.lastSuccessAt ? new Date(sync.lastSuccessAt).getTime() : NaN
  const windowMs = Math.max(120, (settings?.syncIntervalSeconds || 30) * 4) * 1000
  const individuallyFresh = sources.length > 0 && sources.every(source => { const until = Date.parse(source.freshUntil); const observed = Date.parse(source.lastSuccessAt); return Number.isFinite(until) && until > now && Number.isFinite(observed) && observed <= now })
  const summary = Date.parse(sync?.summaryAt)
  const recent = Number.isFinite(last) && last <= now && (individuallyFresh ? Number.isFinite(summary) && summary <= now && now - summary <= windowMs : now - last <= windowMs)
  const incomplete = !sources.length || sources.some(source => source.complete !== true && !['current', 'complete', 'ready'].includes(source.status) || ['error', 'blocked', 'saturated', 'bootstrap', 'catching-up', 'initializing', 'resync-required'].includes(source.status))
  if (!settings?.monitoring) return { label: 'Monitoring off', tone: 'quiet', detail: 'Start monitoring to keep this workspace aligned with QuickBooks.', sources }
  if (['attention', 'error', 'blocked', 'saturated', 'failed'].includes(sync?.status) || sources.some(source => ['error', 'blocked', 'saturated'].includes(source.status))) return { label: 'Sync needs attention', tone: 'attention', detail: 'Some company data could not be updated. Earlier observations remain visible.', sources }
  if (!Number.isFinite(last) || incomplete || ['initializing', 'catching-up', 'syncing', 'bootstrap', 'partial'].includes(sync?.status)) return { label: 'Catching up', tone: 'working', detail: 'Reading company records. Totals remain provisional until every source has caught up.', sources }
  if (!recent) return { label: 'Data needs refreshing', tone: 'attention', detail: 'The last complete company read is older than the monitoring interval.', sources }
  return { label: 'Monitoring current', tone: 'good', detail: 'All monitored sources have a recent complete observation.', sources }
}
export function countValue(counts, key, entity) {
  const raw = counts?.[key] ?? counts?.[entity]
  const value = raw && typeof raw === 'object' ? raw.active ?? raw.count ?? raw.total : raw
  return Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value).toLocaleString() : '—'
}
export function recordLink(record) {
  const entity = record?.entity || record?.entityType || record?.type
  const id = record?.qboId || record?.id
  if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(entity || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(String(id || ''))) return '/explorer'
  return '/explorer?' + new URLSearchParams({ type: entity, id: String(id) })
}
export function textValue(value, fallback = '') {
  if (typeof value === 'string') return value.trim() ? value : fallback
  return value?.title || value?.summary || value?.label || value?.detail || fallback
}
