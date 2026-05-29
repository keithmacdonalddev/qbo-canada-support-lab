import { useState, useEffect, Fragment } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import ProductionGuardDialog from '../components/ProductionGuardDialog'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'

export default function LabTools() {
  const [environment, setEnvironment] = useState(null)

  const [seeding, setSeeding] = useState(false)
  const [seedResult, setSeedResult] = useState(null)
  const [seedProgress, setSeedProgress] = useState(null)
  const [seedError, setSeedError] = useState(null)

  const [generating, setGenerating] = useState(false)
  const [genResult, setGenResult] = useState(null)
  const [genProgress, setGenProgress] = useState(null)
  const [genConfig, setGenConfig] = useState({ monthsBack: 6, txnsPerMonth: 30 })
  const [genError, setGenError] = useState(null)

  const [genHistory, setGenHistory] = useState([])
  const [genHistoryLoading, setGenHistoryLoading] = useState(false)
  const [genHistoryError, setGenHistoryError] = useState(null)
  const [seedHistory, setSeedHistory] = useState([])
  const [seedHistoryLoading, setSeedHistoryLoading] = useState(false)
  const [seedHistoryError, setSeedHistoryError] = useState(null)

  // Expanded row log caches: { [runId]: logData }
  const [expandedGenRun, setExpandedGenRun] = useState(null)
  const [genLogCache, setGenLogCache] = useState({})
  const [expandedSeedRun, setExpandedSeedRun] = useState(null)
  const [seedLogCache, setSeedLogCache] = useState({})
  const [logLoading, setLogLoading] = useState(false)

  // Production-guard dialog state: which action is pending confirmation
  const [pendingAction, setPendingAction] = useState(null) // 'seed' | 'generate' | null
  // Whether the confirm POST is in flight (keeps the dialog open + shows loading).
  const [confirmBusy, setConfirmBusy] = useState(false)
  // In-place dialog error (e.g. a 412 from the server) — keeps the dialog open.
  const [guardError, setGuardError] = useState(null)

  const isProduction = environment === 'production'

  const fetchGenHistory = () => {
    setGenHistoryLoading(true)
    setGenHistoryError(null)
    client.get('/generate/history')
      .then((res) => setGenHistory(res.data.genRuns || []))
      .catch((err) => setGenHistoryError(err.response?.data?.error || 'Could not load generation history.'))
      .finally(() => setGenHistoryLoading(false))
  }

  const fetchSeedHistory = () => {
    setSeedHistoryLoading(true)
    setSeedHistoryError(null)
    client.get('/seed/history')
      .then((res) => setSeedHistory(res.data.seedRuns || []))
      .catch((err) => setSeedHistoryError(err.response?.data?.error || 'Could not load seed history.'))
      .finally(() => setSeedHistoryLoading(false))
  }

  useEffect(() => {
    client.get('/qbo/status')
      .then((res) => setEnvironment(res.data?.environment || null))
      .catch(() => {})
    fetchGenHistory()
    fetchSeedHistory()
  }, [])

  // Toggle generation run expansion — lazy-load log
  const toggleGenRun = async (runId) => {
    if (expandedGenRun === runId) {
      setExpandedGenRun(null)
      return
    }
    setExpandedGenRun(runId)
    if (!genLogCache[runId]) {
      setLogLoading(true)
      try {
        const res = await client.get(`/generate/log/${runId}`)
        setGenLogCache((prev) => ({ ...prev, [runId]: res.data }))
      } catch { /* ignore */ }
      finally { setLogLoading(false) }
    }
  }

  // Toggle seed run expansion — lazy-load log
  const toggleSeedRun = async (runId) => {
    if (expandedSeedRun === runId) {
      setExpandedSeedRun(null)
      return
    }
    setExpandedSeedRun(runId)
    if (!seedLogCache[runId]) {
      setLogLoading(true)
      try {
        const res = await client.get(`/seed/log/${runId}`)
        setSeedLogCache((prev) => ({ ...prev, [runId]: res.data }))
      } catch { /* ignore */ }
      finally { setLogLoading(false) }
    }
  }

  // Poll for seeding progress
  useEffect(() => {
    if (!seeding) return
    const interval = setInterval(async () => {
      try {
        const res = await client.get('/seed/status')
        const run = res.data.seedRun
        if (run?.progress) setSeedProgress(run.progress)
        if (run?.status === 'completed' || run?.status === 'failed') {
          setSeeding(false)
          setSeedProgress(null)
          const created = run.entitiesCreated || {}
          const skipped = run.entitiesSkipped || {}
          const errors = run.seedErrors?.length || 0
          const createdParts = []
          if (created.customers) createdParts.push(`${created.customers} customers`)
          if (created.vendors) createdParts.push(`${created.vendors} vendors`)
          if (created.items) createdParts.push(`${created.items} items`)
          const totalSkipped = (skipped.customers || 0) + (skipped.vendors || 0) + (skipped.items || 0)
          const parts = []
          if (createdParts.length) parts.push(`Created ${createdParts.join(', ')}`)
          if (totalSkipped) parts.push(`${totalSkipped} already existed`)
          if (errors) parts.push(`${errors} errors`)
          setSeedResult({
            success: run.status === 'completed',
            message: parts.length ? parts.join(' · ') : (run.status === 'failed' ? 'Seeding failed' : 'Done'),
          })
          fetchSeedHistory()
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [seeding])

  // Poll for generation progress
  useEffect(() => {
    if (!generating) return
    const interval = setInterval(async () => {
      try {
        const res = await client.get('/generate/status')
        const run = res.data.genRun
        if (run?.progress) setGenProgress(run.progress)
        if (run?.status === 'completed' || run?.status === 'failed') {
          setGenerating(false)
          setGenProgress(null)
          const s = run.txnsSummary || {}
          const totalTxns = Object.values(s).reduce((a, b) => a + b, 0)
          const parts = []
          if (s.invoices) parts.push(`${s.invoices} invoices`)
          if (s.payments) parts.push(`${s.payments} payments`)
          if (s.bills) parts.push(`${s.bills} bills`)
          if (s.billPayments) parts.push(`${s.billPayments} bill payments`)
          if (s.creditMemos) parts.push(`${s.creditMemos} credit memos`)
          if (s.vendorCredits) parts.push(`${s.vendorCredits} vendor credits`)
          if (s.journalEntries) parts.push(`${s.journalEntries} journal entries`)
          const errors = run.generationErrors?.length || 0
          setGenResult({
            success: run.status === 'completed',
            message: parts.length
              ? `Created ${totalTxns} transactions: ${parts.join(', ')}${errors ? ` (${errors} errors)` : ''}`
              : (run.status === 'failed' ? 'Generation failed' : 'Done'),
          })
          fetchGenHistory()
        }
      } catch { /* ignore */ }
    }, 3000)
    return () => clearInterval(interval)
  }, [generating])

  // Guard entry points — open the dialog instead of running immediately.
  const handleSeed = () => {
    setSeedError(null)
    setPendingAction('seed')
  }
  const handleGenerate = () => {
    setGenError(null)
    setPendingAction('generate')
  }

  // Confirm handler driven from ProductionGuardDialog. The POST happens here
  // and the dialog stays open until it resolves so a 412 (or any error) can be
  // surfaced in-place. Polling (seeding/generating) is only started AFTER the
  // POST succeeds, avoiding a stray status poll for a job that never started.
  const handleGuardConfirm = async () => {
    const action = pendingAction
    if (!action) return
    setConfirmBusy(true)
    setGuardError(null)

    // Treat unknown environment as production (high friction).
    const effectiveEnv = environment ?? 'production'
    const confirmFlag = effectiveEnv === 'production' ? { confirmProduction: true } : {}

    try {
      if (action === 'seed') {
        await client.post('/seed/start', { ...confirmFlag })
        setPendingAction(null)
        setSeedResult(null)
        setSeedProgress(null)
        setSeedError(null)
        setSeeding(true)
      } else if (action === 'generate') {
        await client.post('/generate/start', { ...genConfig, ...confirmFlag })
        setPendingAction(null)
        setGenResult(null)
        setGenProgress(null)
        setGenError(null)
        setGenerating(true)
      }
    } catch (err) {
      if (err.response?.status === 412) {
        setGuardError(
          err.response.data?.error ||
            'Confirmation required to run against a real company.',
        )
      } else {
        setGuardError(err.response?.data?.error || 'Action failed. Please try again.')
      }
      // Keep the dialog open (do not clear pendingAction) so the user sees why.
    } finally {
      setConfirmBusy(false)
    }
  }

  const guardConfig = {
    seed: {
      title: 'Seed Company',
      actionLabel: seeding ? 'Seeding...' : 'Seed Company',
      description:
        'Creates test customers, vendors, and service items in the connected company. These are the building blocks generation and issue packs rely on.',
    },
    generate: {
      title: 'Generate Historical Activity',
      actionLabel: generating ? 'Generating...' : 'Generate History',
      description: `Creates ${genConfig.monthsBack} months of realistic linked transactions (~${genConfig.txnsPerMonth}/month): invoices, payments, bills, bill payments, and more.`,
    },
  }
  const activeGuard = pendingAction ? guardConfig[pendingAction] : null

  return (
    <Layout>
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text-heading)] mb-2">Lab Tools</h1>
        <p className="text-sm text-[#6B7280] mb-6">
          Write tooling for building out a test company. Seed master data, then generate months of realistic transaction history. Everything sent to QuickBooks is individually logged — click any history row below to see exactly what was created, with QBO IDs, amounts, dates, and links.
        </p>

        {isProduction && (
          <Alert variant="error" className="mb-6 items-start">
            <span>
              You are connected to a <strong>REAL production QuickBooks company</strong>. Actions on this page write live records into the connected books. You will be asked to confirm before each write.
            </span>
          </Alert>
        )}

        {/* Seed */}
        <Card className="shadow-sm mb-6">
          <CardContent className="pt-5">
            <h3 className="font-semibold text-[var(--text-heading)] mb-3">Seed Company</h3>
            <p className="text-sm text-[#6B7280] mb-4">
              Creates the test customers, vendors, and service items that generation and issue packs build on. Safe to run more than once — existing records are skipped.
            </p>
            {seedError && (
              <Alert variant="error" className="mb-3">{seedError}</Alert>
            )}
            <div className="flex items-center gap-4">
              <Button size="lg" onClick={handleSeed} disabled={seeding}>
                {seeding ? 'Seeding...' : 'Seed Company'}
              </Button>
              {seeding && seedProgress && (
                <Badge variant="secondary" className="px-3.5 py-1.5 text-[13px]">{seedProgress.detail}</Badge>
              )}
              {!seeding && seedResult && (
                <Badge variant={seedResult.success ? 'secondary' : 'destructive'} className="px-3.5 py-1.5 text-[13px]">
                  {seedResult.message}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Seed History — expandable rows */}
        <Card className="shadow-sm mb-6">
          <CardContent className="pt-5">
            <h3 className="font-semibold text-[var(--text-heading)] mb-4">Seed History</h3>
            {seedHistoryError && (
              <Alert variant="error" onRetry={fetchSeedHistory} className="mb-3">
                {seedHistoryError}
              </Alert>
            )}
            {seedHistoryLoading ? (
              <p className="text-sm text-[#6B7280]">Loading history...</p>
            ) : seedHistory.length === 0 ? (
              !seedHistoryError && <p className="text-sm text-[#6B7280]">No seed runs yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Skipped</TableHead>
                    <TableHead>Errors</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {seedHistory.map((run) => {
                    const c = run.entitiesCreated || {}
                    const totalCreated = (c.customers || 0) + (c.vendors || 0) + (c.items || 0)
                    const sk = run.entitiesSkipped || {}
                    const totalSkipped = (sk.customers || 0) + (sk.vendors || 0) + (sk.items || 0)
                    const isExpanded = expandedSeedRun === run._id
                    const log = seedLogCache[run._id]
                    return (
                      <Fragment key={run._id}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggleSeedRun(run._id)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-[#6B7280]">{isExpanded ? '▼' : '▶'}</span>
                              <Badge variant={run.status === 'completed' ? 'secondary' : run.status === 'failed' ? 'destructive' : 'outline'}>
                                {run.status}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="font-medium">{totalCreated}</span>
                            <span className="text-xs text-[#6B7280] ml-1">({c.customers || 0}c {c.vendors || 0}v {c.items || 0}i)</span>
                          </TableCell>
                          <TableCell>{totalSkipped}</TableCell>
                          <TableCell>{run.seedErrors?.length || 0}</TableCell>
                          <TableCell className="text-xs">
                            {run.startedAt ? new Date(run.startedAt).toLocaleString() : new Date(run.createdAt).toLocaleString()}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow>
                            <TableCell colSpan={5} className="p-0">
                              {logLoading && !log ? (
                                <p className="text-xs text-[#6B7280] p-4">Loading log...</p>
                              ) : log ? (
                                <div className="max-h-[400px] overflow-y-auto border-t border-[var(--border)]">
                                  <Table>
                                    <TableHeader>
                                      <TableRow className="bg-muted/30">
                                        <TableHead>Status</TableHead>
                                        <TableHead>Entity</TableHead>
                                        <TableHead>Name</TableHead>
                                        <TableHead>QBO ID</TableHead>
                                        <TableHead>Time</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {log.createdEntities?.map((e, i) => (
                                        <TableRow key={`c-${i}`}>
                                          <TableCell><Badge className="bg-green-100 text-green-800 text-[10px]">Created</Badge></TableCell>
                                          <TableCell className="text-xs">{e.entity}</TableCell>
                                          <TableCell className="text-xs">{e.name}</TableCell>
                                          <TableCell className="font-mono text-xs">{e.qboId}</TableCell>
                                          <TableCell className="text-xs">{e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '-'}</TableCell>
                                        </TableRow>
                                      ))}
                                      {log.skippedEntities?.map((e, i) => (
                                        <TableRow key={`s-${i}`}>
                                          <TableCell><Badge className="bg-yellow-100 text-yellow-800 text-[10px]">Skipped</Badge></TableCell>
                                          <TableCell className="text-xs">{e.entity}</TableCell>
                                          <TableCell className="text-xs">{e.name}</TableCell>
                                          <TableCell className="text-xs">-</TableCell>
                                          <TableCell className="text-xs">-</TableCell>
                                        </TableRow>
                                      ))}
                                      {log.errors?.map((e, i) => (
                                        <TableRow key={`e-${i}`}>
                                          <TableCell><Badge variant="destructive" className="text-[10px]">Error</Badge></TableCell>
                                          <TableCell className="text-xs">{e.entity}</TableCell>
                                          <TableCell className="text-xs">{e.name}</TableCell>
                                          <TableCell colSpan={2} className="text-xs text-[var(--danger)]">{e.error}</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              ) : (
                                <p className="text-xs text-[#6B7280] p-4">No detailed log available for this run.</p>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Generate controls */}
        <Card className="shadow-sm mb-6">
          <CardContent className="pt-5">
            <h3 className="font-semibold text-[var(--text-heading)] mb-3">Generate Historical Activity</h3>
            <p className="text-sm text-[#6B7280] mb-3">
              Fills your QBO company with months of realistic transaction history so it looks like a real business, not an empty test account. It creates two types of linked record chains:
            </p>
            <div className="text-sm text-[#6B7280] mb-4 grid grid-cols-2 gap-4">
              <div className="bg-muted/30 rounded-md p-3">
                <p className="font-medium text-[var(--text-heading)] mb-1">AR (Accounts Receivable) — money owed to you</p>
                <p className="text-xs">Invoice ("Customer owes $1,000") → Payment ("Customer paid") → sometimes a Credit Memo ("We gave $50 back"). These records link together — the payment references which invoice it paid.</p>
              </div>
              <div className="bg-muted/30 rounded-md p-3">
                <p className="font-medium text-[var(--text-heading)] mb-1">AP (Accounts Payable) — money you owe vendors</p>
                <p className="text-xs">Bill ("You owe Vendor $2,000") → Bill Payment ("You paid the vendor") → sometimes a Vendor Credit ("Vendor gave $200 back"). Same idea — the payment links back to the bill.</p>
              </div>
            </div>
            {genError && (
              <Alert variant="error" className="mb-3">{genError}</Alert>
            )}
            <div className="flex items-end gap-4 mb-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1 block">Months Back</label>
                <select
                  value={genConfig.monthsBack}
                  onChange={(e) => setGenConfig({ ...genConfig, monthsBack: Number(e.target.value) })}
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                  disabled={generating}
                >
                  {[3, 4, 5, 6, 9, 12].map((m) => (
                    <option key={m} value={m}>{m} months</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1 block">Txns/Month</label>
                <select
                  value={genConfig.txnsPerMonth}
                  onChange={(e) => setGenConfig({ ...genConfig, txnsPerMonth: Number(e.target.value) })}
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                  disabled={generating}
                >
                  {[10, 20, 30, 40, 50, 60].map((n) => (
                    <option key={n} value={n}>{n} per month</option>
                  ))}
                </select>
              </div>
              <Button onClick={handleGenerate} disabled={generating}>
                {generating ? 'Generating...' : 'Generate History'}
              </Button>
              {generating && genProgress && (
                <Badge variant="secondary" className="px-3.5 py-1.5 text-[13px]">{genProgress.detail}</Badge>
              )}
            </div>
            {!generating && genResult && (
              <Badge variant={genResult.success ? 'secondary' : 'destructive'} className="px-3.5 py-1.5 text-[13px]">
                {genResult.message}
              </Badge>
            )}
          </CardContent>
        </Card>

        {/* Generation History — expandable rows */}
        <Card className="shadow-sm">
          <CardContent className="pt-5">
            <h3 className="font-semibold text-[var(--text-heading)] mb-4">Generation History</h3>
            {genHistoryError && (
              <Alert variant="error" onRetry={fetchGenHistory} className="mb-3">
                {genHistoryError}
              </Alert>
            )}
            {genHistoryLoading ? (
              <p className="text-sm text-[#6B7280]">Loading history...</p>
            ) : genHistory.length === 0 ? (
              !genHistoryError && <p className="text-sm text-[#6B7280]">No generation runs yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Config</TableHead>
                    <TableHead>Transactions</TableHead>
                    <TableHead>Errors</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {genHistory.map((run) => {
                    const s = run.txnsSummary || {}
                    const totalTxns = Object.values(s).reduce((a, b) => a + b, 0)
                    const duration = run.startedAt && run.completedAt
                      ? Math.round((new Date(run.completedAt) - new Date(run.startedAt)) / 1000)
                      : null
                    const isExpanded = expandedGenRun === run._id
                    const log = genLogCache[run._id]
                    return (
                      <Fragment key={run._id}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggleGenRun(run._id)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-[#6B7280]">{isExpanded ? '▼' : '▶'}</span>
                              <Badge variant={run.status === 'completed' ? 'secondary' : run.status === 'failed' ? 'destructive' : 'outline'}>
                                {run.status}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">
                            {run.config?.monthsBack}mo / {run.config?.txnsPerMonth} per mo
                          </TableCell>
                          <TableCell>
                            <span className="font-medium">{totalTxns}</span>
                            <span className="text-xs text-[#6B7280] ml-1">
                              ({s.invoices || 0} inv, {s.payments || 0} pay, {s.bills || 0} bill)
                            </span>
                          </TableCell>
                          <TableCell>{run.generationErrors?.length || 0}</TableCell>
                          <TableCell className="text-xs">
                            {run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}
                          </TableCell>
                          <TableCell className="text-xs">
                            {duration != null
                              ? duration >= 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`
                              : run.status === 'in_progress' ? 'Running...' : '-'}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow>
                            <TableCell colSpan={6} className="p-0">
                              {logLoading && !log ? (
                                <p className="text-xs text-[#6B7280] p-4">Loading log...</p>
                              ) : log && log.transactions?.length > 0 ? (
                                <div className="max-h-[500px] overflow-y-auto border-t border-[var(--border)]">
                                  <Table>
                                    <TableHeader>
                                      <TableRow className="bg-muted/30">
                                        <TableHead>Entity</TableHead>
                                        <TableHead>QBO ID</TableHead>
                                        <TableHead>Doc #</TableHead>
                                        <TableHead>Amount</TableHead>
                                        <TableHead>Date</TableHead>
                                        <TableHead>Customer/Vendor</TableHead>
                                        <TableHead>Linked To</TableHead>
                                        <TableHead>Created At</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {log.transactions.map((txn, i) => (
                                        <TableRow key={i}>
                                          <TableCell>
                                            <Badge variant="outline" className="text-[11px]">{txn.entity}</Badge>
                                          </TableCell>
                                          <TableCell className="font-mono text-xs">{txn.qboId}</TableCell>
                                          <TableCell>{txn.docNumber || '-'}</TableCell>
                                          <TableCell>${txn.amount?.toFixed(2)}</TableCell>
                                          <TableCell>{txn.txnDate}</TableCell>
                                          <TableCell className="text-xs">{txn.customerOrVendor || '-'}</TableCell>
                                          <TableCell className="text-xs">{txn.linkedTo || '-'}</TableCell>
                                          <TableCell className="text-xs">{new Date(txn.timestamp).toLocaleTimeString()}</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                  {log.errors?.length > 0 && (
                                    <div className="p-3 border-t border-[var(--border)]">
                                      <p className="text-xs font-medium text-[var(--danger)] mb-1">{log.errors.length} error(s):</p>
                                      {log.errors.map((err, i) => (
                                        <p key={i} className="text-xs text-[#6B7280]">[{err.type}] {err.detail}</p>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="text-xs text-[#6B7280] p-4">No detailed log available for this run.</p>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <ProductionGuardDialog
        key={pendingAction || 'none'}
        open={!!pendingAction}
        loading={confirmBusy}
        error={guardError}
        environment={environment ?? 'production'}
        title={activeGuard?.title || ''}
        actionLabel={activeGuard?.actionLabel || 'Confirm'}
        description={activeGuard?.description}
        onConfirm={handleGuardConfirm}
        onCancel={() => {
          if (!confirmBusy) {
            setPendingAction(null)
            setGuardError(null)
          }
        }}
      />
    </Layout>
  )
}
