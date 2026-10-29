import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, OctagonAlert } from 'lucide-react'
import client from '../api/client'
import { businessPromises } from '../lib/business-promises.mjs'

const ICONS = { kept: CheckCircle2, attention: AlertTriangle, broken: OctagonAlert, waiting: CircleDashed, unknown: CircleDashed }
const LABELS = { kept: 'Holding', attention: 'Needs attention', broken: 'Broken', waiting: 'Checking', unknown: 'Not measured' }

// Reads only the saved feature check; it never asks QuickBooks for a fresh one.
function useCachedCoverage(scopeKey) {
  const [coverage, setCoverage] = useState(undefined)
  useEffect(() => {
    const controller = new AbortController()
    client.get('/coverage', { params: { cached: 'true' }, signal: controller.signal, timeout: 12000 })
      .then(response => setCoverage(response.data?.data || null))
      .catch(() => { if (!controller.signal.aborted) setCoverage(null) })
    return () => controller.abort()
  }, [scopeKey])
  return coverage
}

export function BusinessPromisesView({ data, coverage, now, onView }) {
  const navigate = useNavigate()
  const { promises, headline, tone, unknown } = businessPromises(data, coverage, now)
  const open = target => target === 'coverage' ? navigate('/coverage') : target === 'manage' ? navigate('/company/manage') : onView(target)
  return <section className={'bp bp--' + tone} aria-labelledby="business-promises-title">
    <div className="bp-head">
      <span className="bp-eyebrow">What the business promises you</span>
      <h2 id="business-promises-title">{headline}</h2>
      {unknown > 0 && tone === 'kept' && <p>{unknown === 1 ? 'One promise is not measured yet.' : unknown + ' promises are not measured yet.'}</p>}
    </div>
    <ol className="bp-grid">
      {promises.map(item => {
        const Icon = ICONS[item.state]
        return <li key={item.key} className={'bp-card bp-card--' + item.state}>
          <div className="bp-card-top"><Icon aria-hidden="true" /><span>{item.name}</span><em>{LABELS[item.state]}</em></div>
          <strong>{item.verdict}</strong>
          <p>{item.detail}</p>
          {item.action && <button type="button" className="bw-text-button" onClick={() => open(item.target)}>{item.action}<ArrowRight /></button>}
        </li>
      })}
    </ol>
  </section>
}

export default function BusinessPromises({ data, now, onView }) {
  const coverage = useCachedCoverage([data?.scope?.realmId, data?.scope?.connectionId].join(':'))
  return <BusinessPromisesView data={data} coverage={coverage} now={now} onView={onView} />
}
