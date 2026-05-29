import { Fragment, useState, useEffect } from 'react'
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

const CATEGORY_COLORS = {
  ar: 'bg-blue-100 text-blue-800',
  ap: 'bg-purple-100 text-purple-800',
  tax: 'bg-orange-100 text-orange-800',
  data_hygiene: 'bg-gray-100 text-gray-800',
}

const SEVERITY_COLORS = {
  low: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-red-100 text-red-800',
}

export default function IssuePacks() {
  const [packs, setPacks] = useState([])
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('catalog')
  const [running, setRunning] = useState(null)
  const [expandedRun, setExpandedRun] = useState(null)
  const [environment, setEnvironment] = useState(null)
  const [runError, setRunError] = useState(null)
  // Slug pending production confirmation (drives the guard dialog)
  const [pendingSlug, setPendingSlug] = useState(null)
  // Whether the confirm POST is in flight (keeps the dialog open + shows loading).
  const [confirmBusy, setConfirmBusy] = useState(false)
  // In-place dialog error (e.g. a 412 from the server) — keeps the dialog open.
  const [guardError, setGuardError] = useState(null)

  const isProduction = environment === 'production'

  useEffect(() => {
    Promise.all([
      client.get('/issuepacks').then((r) => setPacks(r.data.packs || [])),
      client.get('/issuepacks/runs').then((r) => setRuns(r.data.runs || [])),
    ])
      .catch(() => {})
      .finally(() => setLoading(false))
    client.get('/qbo/status')
      .then((r) => setEnvironment(r.data?.environment || null))
      .catch(() => {})
  }, [])

  // Open the guard dialog instead of running immediately.
  const handleRun = (slug) => {
    setRunError(null)
    setPendingSlug(slug)
  }

  // Poll a specific run to completion (started only after the POST succeeds).
  const startRunPolling = (runId, slug) => {
    setRunning(slug)
    const poll = setInterval(async () => {
      try {
        const res = await client.get(`/issuepacks/runs/${runId}`)
        const run = res.data.run
        if (run && ['completed', 'failed'].includes(run.status)) {
          clearInterval(poll)
          setRunning(null)
          // Refresh full run list
          const listRes = await client.get('/issuepacks/runs')
          setRuns(listRes.data.runs || [])
        }
      } catch {
        clearInterval(poll)
        setRunning(null)
      }
    }, 2000)
    // Safety timeout
    setTimeout(() => { clearInterval(poll); setRunning(null) }, 60000)
  }

  // Confirm handler driven from ProductionGuardDialog. The POST happens here
  // and the dialog stays open until it resolves so a 412 (or any error) can be
  // surfaced in-place. Run polling is only started AFTER the POST succeeds,
  // avoiding a stray status poll for a run that never started.
  const handleGuardConfirm = async () => {
    const slug = pendingSlug
    if (!slug) return
    setConfirmBusy(true)
    setGuardError(null)

    // Treat unknown environment as production (high friction).
    const effectiveEnv = environment ?? 'production'
    const body = effectiveEnv === 'production' ? { confirmProduction: true } : {}

    try {
      const startRes = await client.post(`/issuepacks/${slug}/run`, body)
      setPendingSlug(null)
      setRunError(null)
      const runId = startRes.data.run?._id
      if (runId) startRunPolling(runId, slug)
    } catch (err) {
      if (err.response?.status === 412) {
        setGuardError(
          err.response.data?.error ||
            'Confirmation required to run against a real company.',
        )
      } else {
        setGuardError(err.response?.data?.error || 'Action failed. Please try again.')
      }
      // Keep the dialog open (do not clear pendingSlug) so the user sees why.
    } finally {
      setConfirmBusy(false)
    }
  }

  const pendingPack = pendingSlug ? packs.find((p) => p.slug === pendingSlug) : null

  const handleExpandRun = async (runId) => {
    if (expandedRun?._id === runId) {
      setExpandedRun(null)
      return
    }
    try {
      const res = await client.get(`/issuepacks/runs/${runId}`)
      setExpandedRun(res.data.run)
    } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <Layout>
        <p className="text-[#6B7280] text-sm">Loading issue packs...</p>
      </Layout>
    )
  }

  return (
    <Layout>
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text-heading)] mb-2">Issue Packs</h1>
        <p className="text-sm text-[#6B7280] mb-6">
          Issue packs create known problems in your QBO company on purpose — so you can practice finding and diagnosing them. For example, "AR Payment Mismatch" creates an invoice and a payment that's off by a penny, which is a common real-world support issue. Each pack tells you what symptoms to expect and gives hints on where to look. The workflow: create a checkpoint first, run a pack, then use the Entity Explorer to find the bad data and Checkpoints to diff what changed. Every record created is fully logged.
        </p>

        {isProduction && (
          <Alert variant="error" className="mb-6 items-start">
            <span>
              You are connected to a <strong>REAL production QuickBooks company</strong>. Running a pack writes live records into the connected books. You will be asked to confirm first.
            </span>
          </Alert>
        )}

        {runError && (
          <Alert variant="error" className="mb-6">{runError}</Alert>
        )}

        <div className="flex gap-2 mb-6">
          <Button
            variant={activeTab === 'catalog' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveTab('catalog')}
          >
            Pack Catalog
          </Button>
          <Button
            variant={activeTab === 'history' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveTab('history')}
          >
            Run History ({runs.length})
          </Button>
        </div>

        {activeTab === 'catalog' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {packs.map((pack) => (
              <Card key={pack.slug} className="shadow-sm">
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-[var(--text-heading)]">{pack.name}</h3>
                    <div className="flex gap-1.5">
                      <Badge className={CATEGORY_COLORS[pack.category] || ''}>
                        {pack.category}
                      </Badge>
                      <Badge className={SEVERITY_COLORS[pack.severity] || ''}>
                        {pack.severity}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-sm text-[#6B7280] mb-3">{pack.description}</p>

                  {pack.expectedSymptoms?.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1">Expected Symptoms</p>
                      <ul className="text-xs text-[#6B7280] list-disc list-inside space-y-0.5">
                        {pack.expectedSymptoms.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}

                  {pack.investigationHints?.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1">Investigation Hints</p>
                      <ul className="text-xs text-[#6B7280] list-disc list-inside space-y-0.5">
                        {pack.investigationHints.map((h, i) => <li key={i}>{h}</li>)}
                      </ul>
                    </div>
                  )}

                  <Button
                    size="sm"
                    onClick={() => handleRun(pack.slug)}
                    disabled={running === pack.slug}
                  >
                    {running === pack.slug ? 'Running...' : 'Run Pack'}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {activeTab === 'history' && (
          <Card className="shadow-sm">
            <CardContent className="p-0">
              {runs.length === 0 ? (
                <p className="text-[#6B7280] text-sm p-4">No runs yet. Execute an issue pack from the catalog.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pack</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Entities Created</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => (
                      <Fragment key={run._id}>
                        <TableRow>
                          <TableCell className="font-medium">
                            {run.issuePackId?.name || 'Unknown'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={run.status === 'completed' ? 'secondary' : run.status === 'failed' ? 'destructive' : 'outline'}>
                              {run.status}
                            </Badge>
                          </TableCell>
                          <TableCell>{run.createdEntities?.length || 0}</TableCell>
                          <TableCell>{new Date(run.startedAt || run.createdAt).toLocaleString()}</TableCell>
                          <TableCell>
                            <Button size="sm" variant="ghost" onClick={() => handleExpandRun(run._id)}>
                              {expandedRun?._id === run._id ? 'Collapse' : 'Details'}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {expandedRun?._id === run._id && (
                          <TableRow>
                            <TableCell colSpan={5}>
                              <div className="p-3 bg-muted/30 rounded">
                                <p className="text-xs font-medium mb-2">Execution Log:</p>
                                <div className="space-y-1">
                                  {expandedRun.executionLog?.map((entry, i) => (
                                    <div key={i} className="text-xs flex gap-2">
                                      <Badge
                                        variant={entry.outcome === 'success' ? 'secondary' : 'destructive'}
                                        className="text-[10px] px-1.5 py-0"
                                      >
                                        Step {entry.step}
                                      </Badge>
                                      <span className="text-[#6B7280]">{entry.action}:</span>
                                      <span>{entry.detail}</span>
                                    </div>
                                  ))}
                                </div>
                                {expandedRun.createdEntities?.length > 0 && (
                                  <div className="mt-2 pt-2 border-t border-[var(--border)]">
                                    <p className="text-xs font-medium mb-1">Created Entities:</p>
                                    <div className="flex flex-wrap gap-1">
                                      {expandedRun.createdEntities.map((e, i) => (
                                        <Badge key={i} variant="outline" className="text-[10px]">
                                          {e.entity} #{e.qboId}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <ProductionGuardDialog
        key={pendingSlug || 'none'}
        open={!!pendingSlug}
        loading={confirmBusy}
        error={guardError}
        environment={environment ?? 'production'}
        title={pendingPack ? `Run "${pendingPack.name}"` : 'Run Issue Pack'}
        actionLabel="Run Pack"
        description="This deliberately creates problematic records in the connected company so you can practice diagnosing them."
        onConfirm={handleGuardConfirm}
        onCancel={() => {
          if (!confirmBusy) {
            setPendingSlug(null)
            setGuardError(null)
          }
        }}
      />
    </Layout>
  )
}
