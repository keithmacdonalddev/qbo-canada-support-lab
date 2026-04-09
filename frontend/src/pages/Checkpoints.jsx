import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'

const ENTITY_KEYS = [
  'customers', 'invoices', 'payments', 'creditMemos',
  'bills', 'billPayments', 'vendorCredits', 'items', 'accounts', 'journalEntries',
]

export default function Checkpoints() {
  const [checkpoints, setCheckpoints] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [diffResult, setDiffResult] = useState(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [compareA, setCompareA] = useState('')
  const [compareB, setCompareB] = useState('')

  const fetchCheckpoints = async () => {
    try {
      const res = await client.get('/checkpoint')
      setCheckpoints(res.data.checkpoints || [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  useEffect(() => { fetchCheckpoints() }, [])

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      await client.post('/checkpoint', { name: name.trim(), description: description.trim() })
      setName('')
      setDescription('')
      await fetchCheckpoints()
    } catch { /* ignore */ }
    finally { setCreating(false) }
  }

  const handleDelete = async (id) => {
    try {
      await client.delete(`/checkpoint/${id}`)
      await fetchCheckpoints()
    } catch { /* ignore */ }
  }

  const handleDiff = async () => {
    if (!compareA || !compareB || compareA === compareB) return
    setDiffLoading(true)
    setDiffResult(null)
    try {
      const res = await client.get(`/checkpoint/${compareA}/diff/${compareB}`)
      setDiffResult(res.data)
    } catch { /* ignore */ }
    finally { setDiffLoading(false) }
  }

  const totalEntities = (counts) => {
    if (!counts) return 0
    return Object.values(counts).reduce((a, b) => a + b, 0)
  }

  return (
    <Layout>
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text-heading)] mb-2">Checkpoints</h1>
        <p className="text-sm text-[#6B7280] mb-6">
          A checkpoint saves a copy of everything currently in your QBO company — all customers, invoices, payments, bills, and other records — to the database at that moment. The typical workflow: create a checkpoint ("Before"), then make changes (like running an issue pack), then create another checkpoint ("After"). Use Compare to see a side-by-side diff of exactly what changed between the two — which records were added, removed, or had fields modified. This is how you verify what an issue pack actually did to your data.
        </p>

        <Card className="shadow-sm mb-6">
          <CardContent className="pt-5">
            <h3 className="font-semibold text-[var(--text-heading)] mb-3">Create Checkpoint</h3>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1 block">Name</label>
                <Input
                  placeholder="e.g., Before issue pack"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex-1">
                <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1 block">Description (optional)</label>
                <Input
                  placeholder="What's this snapshot for?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <Button onClick={handleCreate} disabled={creating || !name.trim()}>
                {creating ? 'Creating...' : 'Create Checkpoint'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {loading ? (
          <p className="text-[#6B7280] text-sm">Loading checkpoints...</p>
        ) : checkpoints.length === 0 ? (
          <p className="text-[#6B7280] text-sm">No checkpoints yet. Create one to snapshot your QBO company state.</p>
        ) : (
          <>
            <Card className="shadow-sm mb-6">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Total Entities</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {checkpoints.map((cp) => (
                      <TableRow key={cp._id}>
                        <TableCell className="font-medium">{cp.name}</TableCell>
                        <TableCell className="text-[#6B7280]">{cp.description || '-'}</TableCell>
                        <TableCell>{totalEntities(cp.entityCounts)}</TableCell>
                        <TableCell>{new Date(cp.createdAt).toLocaleString()}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[var(--danger)]"
                            onClick={() => handleDelete(cp._id)}
                          >
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="shadow-sm">
              <CardContent className="pt-5">
                <h3 className="font-semibold text-[var(--text-heading)] mb-3">Compare Checkpoints</h3>
                <div className="flex items-end gap-3 mb-4">
                  <div className="flex-1">
                    <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1 block">Checkpoint A (before)</label>
                    <select
                      value={compareA}
                      onChange={(e) => setCompareA(e.target.value)}
                      className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    >
                      <option value="">Select...</option>
                      {checkpoints.map((cp) => (
                        <option key={cp._id} value={cp._id}>{cp.name} ({new Date(cp.createdAt).toLocaleDateString()})</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-1 block">Checkpoint B (after)</label>
                    <select
                      value={compareB}
                      onChange={(e) => setCompareB(e.target.value)}
                      className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    >
                      <option value="">Select...</option>
                      {checkpoints.map((cp) => (
                        <option key={cp._id} value={cp._id}>{cp.name} ({new Date(cp.createdAt).toLocaleDateString()})</option>
                      ))}
                    </select>
                  </div>
                  <Button onClick={handleDiff} disabled={diffLoading || !compareA || !compareB || compareA === compareB}>
                    {diffLoading ? 'Comparing...' : 'Compare'}
                  </Button>
                </div>

                {diffResult && (
                  <div className="mt-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-medium">{diffResult.checkpointA?.name}</span>
                      <span className="text-[#6B7280]">vs</span>
                      <span className="text-sm font-medium">{diffResult.checkpointB?.name}</span>
                    </div>

                    {Object.keys(diffResult.diff).length === 0 ? (
                      <p className="text-[#6B7280] text-sm">No differences found.</p>
                    ) : (
                      <div className="space-y-4">
                        {ENTITY_KEYS.map((key) => {
                          const d = diffResult.diff[key]
                          if (!d) return null
                          return (
                            <div key={key}>
                              <h4 className="font-medium text-sm text-[var(--text-heading)] mb-2 capitalize">{key}</h4>
                              {d.added.length > 0 && (
                                <div className="mb-2">
                                  <Badge className="bg-green-100 text-green-800 mb-1">+{d.added.length} added</Badge>
                                  <div className="text-xs text-[#6B7280] ml-2">
                                    {d.added.map((e) => `#${e.qboId}`).join(', ')}
                                  </div>
                                </div>
                              )}
                              {d.deleted.length > 0 && (
                                <div className="mb-2">
                                  <Badge className="bg-red-100 text-red-800 mb-1">-{d.deleted.length} deleted</Badge>
                                  <div className="text-xs text-[#6B7280] ml-2">
                                    {d.deleted.map((e) => `#${e.qboId}`).join(', ')}
                                  </div>
                                </div>
                              )}
                              {d.modified.length > 0 && (
                                <div>
                                  <Badge className="bg-yellow-100 text-yellow-800 mb-1">~{d.modified.length} modified</Badge>
                                  {d.modified.map((m) => (
                                    <div key={m.qboId} className="ml-2 mt-1">
                                      <span className="text-xs font-medium">#{m.qboId}:</span>
                                      {m.changes.map((c, i) => (
                                        <span key={i} className="text-xs text-[#6B7280] ml-1">
                                          {c.field} ({JSON.stringify(c.before)} → {JSON.stringify(c.after)})
                                        </span>
                                      ))}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </Layout>
  )
}
