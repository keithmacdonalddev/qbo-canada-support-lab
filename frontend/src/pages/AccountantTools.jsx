import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, ArrowLeft, BookOpen, FilePen, GraduationCap, LoaderCircle, NotebookPen, RefreshCw, Search, Table2 } from 'lucide-react'
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
        {catalog.counts.core !== undefined && <>{' '}<strong>{catalog.counts.core}</strong> tools are loaded on every review; the other <strong>{catalog.counts.deferred}</strong> are found by search when needed, and it loads one of its <strong>{catalog.counts.skills} skills</strong> before specialised work.</>}
      </p>
      <div className="act-columns">
        <div className="act-stack">
        <section className="bw-panel" aria-labelledby="act-tools-title">
          <header className="bw-panel-heading"><h2 id="act-tools-title"><FilePen aria-hidden="true" />Tools</h2></header>
          {catalog.groups.map(group => {
            const tools = catalog.tools.filter(tool => tool.group === group.key), Icon = GROUP_ICONS[group.key] || BookOpen
            if (!tools.length) return null
            return <div key={group.key} className="act-group">
              <h3><Icon aria-hidden="true" />{group.label}<span>{tools.length}</span></h3>
              <ul>{tools.map(tool => <li key={tool.name}>
                <div className="act-tool-head"><code>{tool.name}</code>{tool.disclosure && <span className={'act-pill act-pill--' + (tool.disclosure === 'core' ? 'quiet' : 'working')}>{tool.disclosure === 'core' ? 'Always loaded' : 'Found by search'}</span>}</div>
                <p>{tool.summary}</p>
                <details><summary>What the accountant is told</summary><p>{tool.instructions}</p></details>
              </li>)}</ul>
            </div>
          })}
          {catalog.discovery?.length > 0 && <div className="act-group">
            <h3><Search aria-hidden="true" />Finding tools and skills<span>{catalog.discovery.length}</span></h3>
            <ul>{catalog.discovery.map(tool => <li key={tool.name}>
              <div className="act-tool-head"><code>{tool.name}</code><span className="act-pill act-pill--quiet">Always loaded</span></div>
              <p>{tool.summary}</p>
              <details><summary>What the accountant is told</summary><p>{tool.instructions}</p></details>
            </li>)}</ul>
          </div>}
        </section>
        {catalog.skills?.length > 0 && <section className="bw-panel" aria-labelledby="act-skills-title">
          <header className="bw-panel-heading"><h2 id="act-skills-title"><GraduationCap aria-hidden="true" />Skills</h2></header>
          <div className="act-group">
            <p className="act-note">Procedures and reference knowledge it loads only when the work needs them. It sees each name and description on every review.</p>
            <ul>{catalog.skills.map(skill => <li key={skill.name}>
              <div className="act-tool-head"><code>{skill.name}</code>{skill.references > 0 && <span className="act-pill act-pill--quiet">{skill.references} reference {skill.references === 1 ? 'file' : 'files'}</span>}</div>
              <p>{skill.description}</p>
            </li>)}</ul>
          </div>
        </section>}
        </div>
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
