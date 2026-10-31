import { useState } from 'react'
import { ClipboardList, Wrench } from 'lucide-react'
import { timeOfDay } from '../lib/format'

// The owner's intent, by requirement, as the accountant's daily management review reports it.
const REQUIREMENTS = { R01: 'Support usefulness', R02: 'Size and activity', R04: 'Management and advice', R05: 'Tools', R06: 'Your direction', R11: 'Explaining the work' }
const STATUS = { 'on-track': 'On track', attention: 'Needs attention', gap: 'Gap' }
const AREAS = { customers: 'Customers', suppliers: 'Suppliers', items: 'Items', 'sales-mix': 'Sales mix', scenario: 'Support scenario', collections: 'Collections', payables: 'Payables', stock: 'Stock', close: 'Close', other: 'Other' }
const BUILD_PREVIEW = 5

// Today's plan from the daily management review, and the build list of missing tools it filed.
export default function BusinessTodayPlan({ management }) {
  const [allRequests, setAllRequests] = useState(false)
  if (!management?.available) return null
  const { plan, progress, capabilityRequests: requests = [] } = management
  const share = progress?.target ? Math.min(100, Math.round((progress.saved / progress.target) * 100)) : 0
  const shown = allRequests ? requests : requests.slice(0, BUILD_PREVIEW)
  return <section className="bpl" aria-labelledby="todays-plan-title">
    <header className="bpl-head">
      <h2 id="todays-plan-title"><ClipboardList aria-hidden="true" />Today’s plan<span className="bpl-day">{management.label}</span></h2>
      {progress && progress.target > 0 && <div className="bpl-progress" aria-label={'Today: ' + progress.saved + ' of ' + progress.target + ' planned records in QuickBooks'}>
        <span><strong>{progress.saved}</strong> of {progress.target} records in QuickBooks{progress.reserved > 0 ? ' · ' + progress.reserved + ' in progress' : ''}</span>
        <span className="bpl-meter" aria-hidden="true"><span style={{ width: share + '%' }} /></span>
      </div>}
      {progress && progress.target === 0 && <span className="bpl-progress-note">No activity target today</span>}
    </header>
    {plan ? <>
      <p className="bpl-note">{plan.note}</p>
      <div className="bpl-grid">
        <div>
          <h3>What it found</h3>
          <ul className="bpl-findings">{plan.findings.map((row, index) => <li key={index} className={'bpl-finding bpl-finding--' + row.status}>
            <span className="bpl-req">{REQUIREMENTS[row.requirement] || row.requirement}<em>{STATUS[row.status] || row.status}</em></span>
            <span>{row.finding}</span>
          </li>)}</ul>
        </div>
        <div>
          <h3>What changes today</h3>
          {plan.changes.length ? <ol className="bpl-changes">{plan.changes.map((row, index) => <li key={index}><span className="bpl-area">{AREAS[row.area] || row.area}{row.count ? ' · ' + row.count : ''}</span><span>{row.change}</span></li>)}</ol>
            : <p className="bpl-muted">No changes: today continues the regular rhythm.</p>}
        </div>
      </div>
      <small className="bpl-foot">Set {timeOfDay(plan.at)} by the accountant’s management review. Every review today follows it.</small>
    </> : <p className="bpl-muted bpl-empty">The accountant’s first review of the day compares the business with your goals and sets today’s plan{management.reviewAt ? ' (due ' + timeOfDay(management.reviewAt) + ')' : ''}.{management.lastPlanDay ? '' : ' The first one runs as soon as the accountant is free.'}</p>}
    <div className="bpl-build">
      <div className="bwk-list-head"><Wrench aria-hidden="true" /><span>Build list{requests.length ? ' · ' + requests.length + ' open' : ''}</span></div>
      {requests.length ? <ol className="bpl-requests">{shown.map(row => <li key={row.key} className="bpl-request">
        <span className={'bpl-priority bpl-priority--' + row.priority}>{row.priority}</span>
        <div>
          <h4>{row.missing}</h4>
          <p className="bpl-request-meta">{row.feature} · {REQUIREMENTS[row.requirement] || row.requirement}</p>
          {row.why && <p>{row.why}</p>}
        </div>
      </li>)}</ol> : <p className="bpl-muted">No missing tools recorded yet. The accountant adds one whenever a goal needs a tool it does not have.</p>}
      {requests.length > BUILD_PREVIEW && <button type="button" className="bw-text-button bpl-more" aria-expanded={allRequests} onClick={() => setAllRequests(value => !value)}>{allRequests ? 'Show fewer' : 'Show all ' + requests.length}</button>}
    </div>
  </section>
}
