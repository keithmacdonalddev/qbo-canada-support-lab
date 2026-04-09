import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

const PAGE_SIZE = 25

export default function AuditLog() {
  const [entries, setEntries] = useState([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchLogs = useCallback(async (p) => {
    setLoading(true)
    try {
      const res = await client.get('/audit', { params: { offset: (p - 1) * PAGE_SIZE, limit: PAGE_SIZE } })
      setEntries(res.data.logs || [])
      setTotal(res.data.pagination?.total || 0)
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchLogs(page)
  }, [page, fetchLogs])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Layout>
      <div>
        <div className="flex items-baseline gap-3 mb-5">
          <h1 className="text-[22px] font-semibold text-[var(--text-heading)]">Audit Log</h1>
          <span className="text-[13px] text-[var(--text-light)]">{total} entries</span>
        </div>

        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-[var(--text-light)]">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-[var(--text-light)]">
                    No audit entries found.
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry, i) => (
                  <TableRow key={entry._id || entry.id || i}>
                    <TableCell className="font-mono text-xs text-[var(--text-light)] whitespace-nowrap">
                      {entry.createdAt
                        ? new Date(entry.createdAt).toLocaleString()
                        : 'N/A'}
                    </TableCell>
                    <TableCell>{entry.action || 'N/A'}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="bg-blue-100 text-blue-600 hover:bg-blue-100">
                        {entry.actionType || 'N/A'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={
                          entry.outcome === 'success'
                            ? 'bg-green-100 text-green-600 hover:bg-green-100'
                            : entry.outcome === 'failure'
                            ? 'bg-red-100 text-red-600 hover:bg-red-100'
                            : 'bg-blue-100 text-blue-600 hover:bg-blue-100'
                        }
                      >
                        {entry.outcome || 'N/A'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-4 mt-5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <span className="text-[13px] text-[var(--text-light)]">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </Layout>
  )
}
