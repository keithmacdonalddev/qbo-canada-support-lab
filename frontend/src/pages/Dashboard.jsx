import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import Layout from '../components/Layout'
import client from '../api/client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'

const SNAPSHOT_CARDS = [
  { key: 'customers', label: 'Customers' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'items', label: 'Items' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'openInvoices', label: 'Open Invoices (AR)' },
  { key: 'openBills', label: 'Open Bills (AP)' },
]

const JUMP_OFFS = [
  { to: '/explorer', label: 'Entity Explorer' },
  { to: '/ai', label: 'AI Command Center' },
  { to: '/lab', label: 'Lab Tools' },
  { to: '/checkpoints', label: 'Checkpoints' },
]

function fmtCount(v) {
  return v == null ? '—' : v
}

function fmtDate(d) {
  if (!d) return null
  try {
    return new Date(d).toLocaleString()
  } catch {
    return null
  }
}

export default function Dashboard() {
  const navigate = useNavigate()

  const [health, setHealth] = useState(null)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [healthError, setHealthError] = useState(null)
  const [notConnected, setNotConnected] = useState(false)

  const [snapshot, setSnapshot] = useState(null)
  const [snapshotLoading, setSnapshotLoading] = useState(true)
  const [snapshotError, setSnapshotError] = useState(null)

  const [checkpoints, setCheckpoints] = useState([])
  const [issuePackRuns, setIssuePackRuns] = useState([])
  const [lastSeedRun, setLastSeedRun] = useState(null)
  const [lastGenRun, setLastGenRun] = useState(null)
  const [activity, setActivity] = useState([])

  const fetchHealth = () => {
    setHealthError(null)
    setNotConnected(false)
    // probe=true: verify the connection is live right now (one cheap read-only
    // QBO call), not just that a stored token timestamp looks valid.
    client.get('/company/health?probe=true')
      .then((res) => setHealth(res.data))
      .catch((err) => {
        if (err.response?.status === 404) {
          setNotConnected(true)
        } else {
          setHealthError(err.response?.data?.error || 'Could not load company status.')
        }
      })
      .finally(() => setLoading(false))
  }

  const fetchSnapshot = () => {
    setSnapshotLoading(true)
    setSnapshotError(null)
    client.get('/company/snapshot')
      .then((res) => setSnapshot(res.data?.counts || null))
      .catch((err) => {
        // No active connection (404) → render cards as '—', not an error.
        if (err.response?.status === 404) {
          setSnapshot(null)
        } else {
          setSnapshotError(err.response?.data?.error || 'Could not load live snapshot.')
        }
      })
      .finally(() => setSnapshotLoading(false))
  }

  useEffect(() => {
    // Initial loads inline so no setState runs synchronously in the effect body
    // (state already starts at its "loading" defaults). The fetchHealth /
    // fetchSnapshot helpers above are reused by the Alert retry handlers.
    client.get('/company/health?probe=true')
      .then((res) => setHealth(res.data))
      .catch((err) => {
        if (err.response?.status === 404) {
          setNotConnected(true)
        } else {
          setHealthError(err.response?.data?.error || 'Could not load company status.')
        }
      })
      .finally(() => setLoading(false))

    client.get('/company/snapshot')
      .then((res) => setSnapshot(res.data?.counts || null))
      .catch((err) => {
        // No active connection (404) → render cards as '—', not an error.
        if (err.response?.status === 404) {
          setSnapshot(null)
        } else {
          setSnapshotError(err.response?.data?.error || 'Could not load live snapshot.')
        }
      })
      .finally(() => setSnapshotLoading(false))

    client.get('/qbo/status')
      .then((res) => setStatus(res.data))
      .catch(() => {})

    client.get('/checkpoint')
      .then((res) => setCheckpoints(res.data?.checkpoints || []))
      .catch(() => {})

    client.get('/issuepacks/runs')
      .then((res) => setIssuePackRuns(res.data?.runs || []))
      .catch(() => {})

    client.get('/seed/history')
      .then((res) => setLastSeedRun((res.data?.seedRuns || [])[0] || null))
      .catch(() => {})

    client.get('/generate/history')
      .then((res) => setLastGenRun((res.data?.genRuns || [])[0] || null))
      .catch(() => {})

    client.get('/explore/timeline?limit=10')
      .then((res) => setActivity((res.data?.entries || []).slice(0, 8)))
      .catch(() => {})
  }, [])

  const environment = status?.environment
  const isProduction = environment === 'production'
  const companyName = health?.companyName || status?.companyName || 'N/A'
  const realmId = status?.realmId || '—'
  // Connection health is refresh-token-based (see backend connection-health).
  // Prefer the authoritative `usable` flag; fall back to legacy fields.
  const connectionActive =
    health?.usable ?? (health?.connectionStatus === 'active' || status?.connected)
  const needsReconnect =
    health?.needsReconnect || health?.connectionStatus === 'expired' || health?.connectionStatus === 'revoked'
  const refreshDays = health?.refreshTokenExpiresInDays
  const accessMins = health?.accessTokenExpiresInMinutes ?? health?.tokenExpiresInMinutes
  const verifiedLive = health?.verified === true
  const probeFailed = health?.probeError === true

  // Primary token-health line: lifetime until re-auth is required.
  const tokenHealthLabel = needsReconnect
    ? 'Reconnect required'
    : refreshDays != null
      ? `Reconnect in ${refreshDays} day${refreshDays === 1 ? '' : 's'}`
      : connectionActive
        ? 'Connected'
        : '—'

  // Secondary line: the access-token reality, de-emphasized.
  const tokenHealthDetail = verifiedLive
    ? 'Verified live · access token auto-refreshed'
    : probeFailed
      ? "Couldn't verify just now — showing last known"
      : accessMins != null && accessMins <= 0
        ? 'Access token expired (auto-refreshes on next call)'
        : accessMins != null
          ? `Access token valid ${accessMins} min`
          : null

  // Lab footprint derived values
  const latestCheckpoint = checkpoints[0] || null
  const recentPackRuns = issuePackRuns.slice(0, 3)

  const seedSummary = (() => {
    if (!lastSeedRun) return null
    const c = lastSeedRun.entitiesCreated || {}
    const total = (c.customers || 0) + (c.vendors || 0) + (c.items || 0)
    return {
      status: lastSeedRun.status,
      total,
      when: fmtDate(lastSeedRun.startedAt || lastSeedRun.createdAt),
    }
  })()

  const genSummary = (() => {
    if (!lastGenRun) return null
    const s = lastGenRun.txnsSummary || {}
    const total = Object.values(s).reduce((a, b) => a + b, 0)
    return {
      status: lastGenRun.status,
      total,
      when: fmtDate(lastGenRun.startedAt || lastGenRun.createdAt),
    }
  })()

  return (
    <Layout>
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text-heading)] mb-2">Dashboard</h1>
        <p className="text-sm text-[#6B7280] mb-6">
          A read-only overview of the connected company: who you are connected to, a live snapshot of the books, and what this lab has done. Write tooling lives in{' '}
          <Link to="/lab" className="text-[var(--primary)] font-medium">Lab Tools</Link>.
        </p>

        {loading ? (
          <p className="text-[#6B7280]">Loading company data...</p>
        ) : notConnected ? (
          <Card className="shadow-sm">
            <CardContent>
              <p className="text-[#6B7280] mb-3">No company connected yet.</p>
              <a href="/onboarding" className="text-[var(--primary)] font-medium">
                Go to Onboarding
              </a>
            </CardContent>
          </Card>
        ) : healthError ? (
          <Alert variant="error" onRetry={fetchHealth} className="max-w-[560px]">
            {healthError}
          </Alert>
        ) : (
          <>
            {/* IDENTITY band */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Company</div>
                  <div className="text-base font-medium text-[var(--text-heading)] truncate" title={companyName}>
                    {companyName}
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Realm ID</div>
                  <div className="text-base font-medium text-[var(--text-heading)] font-mono truncate" title={realmId}>
                    {realmId}
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Environment</div>
                  <div>
                    {environment == null ? (
                      <span className="text-base font-medium text-[#6B7280]">—</span>
                    ) : isProduction ? (
                      <Badge variant="destructive" className="text-[11px] font-semibold uppercase tracking-wide">
                        Production
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[11px] font-semibold uppercase tracking-wide">
                        Sandbox
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Connection</div>
                  <div className="text-base font-medium text-[var(--text-heading)] flex items-center gap-2">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${connectionActive ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'}`} />
                    {connectionActive
                      ? 'Connected'
                      : needsReconnect
                        ? 'Reconnect required'
                        : (health?.connectionStatus || status?.status || 'Disconnected')}
                  </div>
                  {connectionActive && (verifiedLive || probeFailed) && (
                    <div className="text-[11px] text-[#6B7280] mt-1">
                      {verifiedLive ? 'verified just now' : 'unverified'}
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Token Health</div>
                  <div className={`text-base font-medium ${needsReconnect ? 'text-[var(--danger)]' : 'text-[var(--text-heading)]'}`}>
                    {tokenHealthLabel}
                  </div>
                  {tokenHealthDetail && (
                    <div className="text-[11px] text-[#6B7280] mt-1 leading-snug">
                      {tokenHealthDetail}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* LIVE SNAPSHOT band */}
            <Card className="shadow-sm mb-6">
              <CardContent className="pt-5">
                <h3 className="font-semibold text-[var(--text-heading)] mb-1">Live Snapshot</h3>
                <p className="text-xs text-[#6B7280] mb-4">Live read-only counts from the connected company.</p>
                {snapshotError ? (
                  <Alert variant="error" onRetry={fetchSnapshot} className="max-w-[560px]">
                    {snapshotError}
                  </Alert>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                    {SNAPSHOT_CARDS.map((card) => (
                      <div key={card.key} className="rounded-lg bg-muted/30 px-4 py-3">
                        <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1">{card.label}</div>
                        <div className="text-xl font-semibold text-[var(--text-heading)]">
                          {snapshotLoading ? (
                            <span className="text-base font-normal text-[#6B7280]">Loading...</span>
                          ) : (
                            fmtCount(snapshot?.[card.key])
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* LAB FOOTPRINT band */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              {/* Checkpoints */}
              <Card className="shadow-sm">
                <CardContent className="pt-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-[var(--text-heading)]">Checkpoints</h3>
                    <Link to="/checkpoints" className="text-[13px] text-[var(--primary)] font-medium">View all</Link>
                  </div>
                  <div className="text-2xl font-semibold text-[var(--text-heading)] mb-1">{checkpoints.length}</div>
                  {latestCheckpoint ? (
                    <p className="text-xs text-[#6B7280]">
                      Latest: <span className="font-medium text-[var(--text-heading)]">{latestCheckpoint.name}</span>
                      {fmtDate(latestCheckpoint.createdAt) ? ` · ${fmtDate(latestCheckpoint.createdAt)}` : ''}
                    </p>
                  ) : (
                    <p className="text-xs text-[#6B7280]">No checkpoints yet.</p>
                  )}
                </CardContent>
              </Card>

              {/* Issue pack runs */}
              <Card className="shadow-sm">
                <CardContent className="pt-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-[var(--text-heading)]">Issue Pack Runs</h3>
                    <Link to="/issuepacks" className="text-[13px] text-[var(--primary)] font-medium">View all</Link>
                  </div>
                  <div className="text-2xl font-semibold text-[var(--text-heading)] mb-2">{issuePackRuns.length}</div>
                  {recentPackRuns.length > 0 ? (
                    <ul className="space-y-1">
                      {recentPackRuns.map((run) => (
                        <li key={run._id} className="text-xs text-[#6B7280] flex items-center gap-2">
                          <Badge variant={run.status === 'completed' ? 'secondary' : run.status === 'failed' ? 'destructive' : 'outline'} className="text-[10px]">
                            {run.status}
                          </Badge>
                          <span className="truncate">{run.issuePackId?.name || 'Unknown pack'}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[#6B7280]">No issue pack runs yet.</p>
                  )}
                </CardContent>
              </Card>

              {/* Last seed + generation */}
              <Card className="shadow-sm">
                <CardContent className="pt-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-[var(--text-heading)]">Last Seed / Generation</h3>
                    <Link to="/lab" className="text-[13px] text-[var(--primary)] font-medium">Lab Tools</Link>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-0.5">Seed</div>
                      {seedSummary ? (
                        <p className="text-xs text-[#6B7280]">
                          <span className="font-medium text-[var(--text-heading)]">{seedSummary.total}</span> records created
                          {seedSummary.when ? ` · ${seedSummary.when}` : ''}
                        </p>
                      ) : (
                        <p className="text-xs text-[#6B7280]">No seed runs yet.</p>
                      )}
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-0.5">Generation</div>
                      {genSummary ? (
                        <p className="text-xs text-[#6B7280]">
                          <span className="font-medium text-[var(--text-heading)]">{genSummary.total}</span> transactions
                          {genSummary.when ? ` · ${genSummary.when}` : ''}
                        </p>
                      ) : (
                        <p className="text-xs text-[#6B7280]">No generation runs yet.</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Recent activity */}
              <Card className="shadow-sm">
                <CardContent className="pt-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-[var(--text-heading)]">Recent Activity</h3>
                    <Link to="/audit" className="text-[13px] text-[var(--primary)] font-medium">Audit Log</Link>
                  </div>
                  {activity.length > 0 ? (
                    <ul className="space-y-1.5">
                      {activity.map((entry) => (
                        <li key={entry._id} className="text-xs text-[#6B7280] flex items-center justify-between gap-3">
                          <span className="truncate text-[var(--text-heading)]">{entry.action}</span>
                          <span className="shrink-0">{fmtDate(entry.createdAt) || ''}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[#6B7280]">No recent activity.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* JUMP-OFFS */}
            <Card className="shadow-sm">
              <CardContent className="pt-5">
                <h3 className="font-semibold text-[var(--text-heading)] mb-3">Jump to</h3>
                <div className="flex flex-wrap gap-2.5">
                  {JUMP_OFFS.map((j) => (
                    <Button key={j.to} variant="outline" size="sm" onClick={() => navigate(j.to)}>
                      {j.label}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </Layout>
  )
}
