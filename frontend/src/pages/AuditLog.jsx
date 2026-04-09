import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'

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
      <div style={styles.page}>
        <div style={styles.header}>
          <h1 style={styles.title}>Audit Log</h1>
          <span style={styles.count}>{total} entries</span>
        </div>

        <div style={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Action</th>
                <th>Type</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} style={styles.emptyCell}>
                    Loading...
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={4} style={styles.emptyCell}>
                    No audit entries found.
                  </td>
                </tr>
              ) : (
                entries.map((entry, i) => (
                  <tr key={entry._id || entry.id || i}>
                    <td style={styles.timestampCell}>
                      {entry.createdAt
                        ? new Date(entry.createdAt).toLocaleString()
                        : 'N/A'}
                    </td>
                    <td>{entry.action || 'N/A'}</td>
                    <td>
                      <span style={styles.typeBadge}>{entry.actionType || 'N/A'}</span>
                    </td>
                    <td>
                      <span
                        style={{
                          ...styles.outcomeBadge,
                          background:
                            entry.outcome === 'success'
                              ? 'var(--success-light)'
                              : entry.outcome === 'failure'
                              ? 'var(--danger-light)'
                              : 'var(--primary-light)',
                          color:
                            entry.outcome === 'success'
                              ? 'var(--success)'
                              : entry.outcome === 'failure'
                              ? 'var(--danger)'
                              : 'var(--primary)',
                        }}
                      >
                        {entry.outcome || 'N/A'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div style={styles.pagination}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={styles.pageBtn}
            >
              Previous
            </button>
            <span style={styles.pageInfo}>
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={styles.pageBtn}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </Layout>
  )
}

const styles = {
  page: {},
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--text-heading)',
  },
  count: {
    fontSize: 13,
    color: 'var(--text-light)',
  },
  tableWrap: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
  },
  emptyCell: {
    textAlign: 'center',
    padding: '32px 14px',
    color: 'var(--text-light)',
  },
  timestampCell: {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    color: 'var(--text-light)',
    whiteSpace: 'nowrap',
  },
  typeBadge: {
    background: 'var(--primary-light)',
    color: 'var(--primary)',
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 500,
  },
  outcomeBadge: {
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 500,
  },
  toolCell: {
    fontFamily: 'var(--mono)',
    fontSize: 12,
  },
  pagination: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginTop: 20,
  },
  pageBtn: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    padding: '6px 16px',
    fontSize: 13,
  },
  pageInfo: {
    fontSize: 13,
    color: 'var(--text-light)',
  },
}
