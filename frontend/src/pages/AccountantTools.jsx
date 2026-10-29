import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, ArrowLeft, BookOpen, FilePen, LoaderCircle, NotebookPen, RefreshCw, Search, Table2 } from 'lucide-react'
import Layout from '../components/Layout'
import { Button } from '../components/ui/button'
import client from '../api/client'
import '../styles/business-workspace.css'
import '../styles/accountant-tools.css'

const GROUP_ICONS = { 'quickbooks-read': Search, 'business-read': BookOpen, 'quickbooks-write': FilePen, notes: NotebookPen }
const CREATE = { yes: ['Yes', 'good'], limited: ['Fixed workflows only', 'working'], no: ['Not built yet', 'attention'], manual: ['QuickBooks only', 'quiet'] }

// What the accountant can actually do: its tools, in plain English with the
// exact instructions it receives, and how far they reach into QuickBooks.
export default function AccountantTools() {
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = useCallback(async signal => {
    setLoading(true)
    try {
      const response = await client.get('/company/business-agent/tools', { signal, timeout: 12000 })
      setCatalog(response.data.data); setError('')
    } catch (err) {
      if (err.name !== 'CanceledError') setError(err.response?.data?.error || 'The tool list could not be read.')
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { const controller = new AbortController(); load(controller.signal); return () => controller.abort() }, [load])
  return <Layout><div className="business-workspace act">
    <header className="bw-header"><h1>The accountant’s tools</h1><Link to="/company" className="bw-text-button"><ArrowLeft />Back to the business</Link></header>
    {!catalog && !error && <div className="bw-loading" role="status"><LoaderCircle className="animate-spin" /><div><strong>Reading the accountant’s tools</strong></div></div>}
    {error && <div className="bw-notice bw-notice--attention" role="alert"><AlertCircle /><div><strong>Tool list unavailable</strong><p>{error}</p></div><Button size="sm" variant="outline" disabled={loading} onClick={() => load()}><RefreshCw />Retry</Button></div>}
    {catalog && <>
      <p className="act-lead">
        It has <strong>{catalog.counts.tools} tools</strong>; <strong>{catalog.counts.changesQuickBooks}</strong> of them change QuickBooks.
        It can create <strong>{catalog.counts.canCreate} of {catalog.counts.recordTypes}</strong> record types, only inside fixed, checked workflows.
        {' '}<strong>{catalog.counts.notBuilt}</strong> record types are not built yet. It cannot edit or void records yet.
      </p>
      <div className="act-columns">
        <section className="bw-panel" aria-labelledby="act-tools-title">
          <header className="bw-panel-heading"><h2 id="act-tools-title"><FilePen aria-hidden="true" />Tools</h2></header>
          {catalog.groups.map(group => {
            const tools = catalog.tools.filter(tool => tool.group === group.key), Icon = GROUP_ICONS[group.key] || BookOpen
            if (!tools.length) return null
            return <div key={group.key} className="act-group">
              <h3><Icon aria-hidden="true" />{group.label}<span>{tools.length}</span></h3>
              <ul>{tools.map(tool => <li key={tool.name}>
                <div className="act-tool-head"><code>{tool.name}</code></div>
                <p>{tool.summary}</p>
                <details><summary>What the accountant is told</summary><p>{tool.instructions}</p></details>
              </li>)}</ul>
            </div>
          })}
        </section>
        <section className="bw-panel" aria-labelledby="act-coverage-title">
          <header className="bw-panel-heading"><h2 id="act-coverage-title"><Table2 aria-hidden="true" />What it can do in QuickBooks</h2></header>
          <table className="act-table">
            <thead><tr><th scope="col">Record</th><th scope="col">Read</th><th scope="col">Create</th><th scope="col">Edit or void</th></tr></thead>
            {[...new Set(catalog.coverage.map(row => row.area))].map(area => <tbody key={area}>
              <tr className="act-area"><th scope="rowgroup" colSpan={4}>{area}</th></tr>
              {catalog.coverage.filter(row => row.area === area).map(row => {
                const [label, tone] = CREATE[row.create] || CREATE.no
                return <tr key={row.entity}>
                  <th scope="row">{row.label}{row.note && <small>{row.note}</small>}</th>
                  <td>{row.read ? 'Yes' : '—'}</td>
                  <td><span className={'act-pill act-pill--' + tone}>{label}</span>{row.via.length > 0 && <small>{row.via.join(' · ')}</small>}</td>
                  <td>{row.change === 'manual' ? <span className="act-pill act-pill--quiet">QuickBooks only</span> : <span className="act-pill act-pill--attention">Not built yet</span>}</td>
                </tr>
              })}
            </tbody>)}
          </table>
        </section>
      </div>
    </>}
  </div></Layout>
}
