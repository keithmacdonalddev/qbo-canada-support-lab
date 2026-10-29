import { featureName, featureState } from './coverage-features.mjs'
import { TARGET_GROUPS } from './coverage-targets.mjs'

export const FOCUS_AREAS = TARGET_GROUPS.filter(group => !group.internal)
export const REPORT_FAMILIES = { sales:['sales','receivables'], purchasing:['payables','expenses'], inventory:['inventory'], banking:['cash','reconciliation'], tax:['tax'], projects:['projects'], books:['financial','budget','audit'], company:[], access:[] }
// These examples demonstrate a specific test situation, rather than just a large record count.
const EXAMPLES = [
  ['partly-paid-invoices','Explore partial payments','See invoices with a payment applied and a balance still open.'],
  ['vendor-credits','Explore supplier credits','Inspect credits available to apply against supplier bills.'],
  ['project-invoices','Explore project billing','Inspect sales connected to a project.'],
  ['refund-receipts','Explore customer refunds','Inspect sales returned to a customer.'],
  ['inventory-items','Explore stocked products','Inspect products that track quantity on hand.'],
  ['grouped-deposits','Explore combined deposits','Inspect deposits that bring customer payments together.'],
  ['taxed-sales','Explore sales tax','Inspect sales with tax charged.'],
  ['partly-paid-bills','Explore partial bill payments','Inspect supplier bills with an outstanding balance after payment.'],
  ['journal-entries','Explore journal entries','Inspect adjustments in the company’s books.'],
]
export function coveragePriorities({ areas = [], reports = [], history = {}, focus = 'all', state = 'ready', reportsFailed = false, recent = null }) {
  const group = FOCUS_AREAS.find(group => group.key === focus)
  const scoped = areas.filter(area => !group || group.keys.includes(area.key))
  const signals = scoped.flatMap(area => area.signals.map(signal => ({area,signal})))
  const scopedReports = reports.filter(report => !group || REPORT_FAMILIES[focus]?.includes(report.family))
  const actions = []
  if (state === 'error') actions.push({key:'read-error',kind:'attention',title:'The company check needs another try',reason:'The last read failed. Earlier observations may still be shown.',action:'Review company check',target:{view:'examples'},rank:100})
  const failed = scopedReports.filter(report => report.status === 'failed')
  if (failed.length) actions.push({key:'failed-reports',kind:'attention',title:failed.length === 1 ? failed[0].name + ' has failed checks' : failed.length + ' reports have failed checks',reason:'A saved check failed. Open its findings before relying on those figures.',action:'Review failed checks',target:{view:'report-results',filter:'failed'},rank:95})
  if (history.status === 'stopped' && (focus === 'all' || focus === 'books')) actions.push({key:'stopped',kind:'attention',title:'Business activity is stopped',reason:'The saved business calendar has a stop request.',action:'Review business history',target:{view:'history'},rank:90})
  if (history.completionPending && (focus === 'all' || focus === 'books')) actions.push({key:'period-pending',kind:'attention',title:'A period is waiting for its final checks',reason:'The business calendar has recorded an unfinished completion step.',action:'Review the period',target:{view:'history'},rank:85})
  const missing = signals.filter(({signal}) => featureState(signal) === 'missing')
  if (missing.length) actions.push({key:'missing',kind:'gap',title:missing.length === 1 ? featureName(missing[0].signal) + ' were not found' : missing.length + ' examples were not found',reason:missing.slice(0,2).map(({signal}) => featureName(signal)).join(' · ') + '. Based on the saved company check.',action:'See what’s missing',target:{view:'examples',filter:'missing',group:focus},rank:60})
  const partial = scopedReports.filter(report => report.status === 'partial')
  if (partial.length) actions.push({key:'report-checks',kind:'report',title:partial.length + (partial.length === 1 ? ' report has data to review' : ' reports have data to review'),reason:'Saved figures are available. Their full checks are not finished.',action:'Review saved reports',target:{view:'report-results',filter:'partial',family:focus},rank:70})
  if (reportsFailed) actions.push({key:'report-read-error',kind:'attention',title:'Some saved results could not load',reason:'Their status is unknown. Retry the saved-result read.',action:'Review saved results',target:{view:'report-results'},rank:80})
  if (!actions.length && history.required > history.completed && (focus === 'all' || focus === 'books')) actions.push({key:'history',kind:'history',title:'Business history is still being prepared',reason:history.completed + ' of ' + history.required + ' planned months have completed their checks.',action:'See the business calendar',target:{view:'history'},rank:40})
  const examples = signals.filter(({signal}) => ['available','limited'].includes(featureState(signal))).map(({area,signal}) => {
    const known = EXAMPLES.find(([key]) => key === signal.key)
    return {key:area.key + ':' + signal.key,kind:'example',title:known?.[1] || featureName(signal),reason:known?.[2] || 'Inspect this feature in the connected company.',proof:signal.key === 'customer-provinces' ? signal.count + ' provinces represented' : signal.count != null ? signal.count.toLocaleString() + (signal.truncated ? '+' : '') + ' found in this company' : 'Enabled in this company',action:'Explore this example',target:{view:'examples',area:area.key,signal:signal.key},rank:known ? 30 - EXAMPLES.indexOf(known) : 1}
  }).sort((a,b) => b.rank-a.rank || a.key.localeCompare(b.key))
  const resume = recent && examples.find(item => item.key === recent)
  if (resume) actions.push({...resume,key:'resume',kind:'resume',title:'Continue with ' + featureName(signals.find(({area,signal}) => area.key + ':' + signal.key === recent).signal).toLowerCase(),reason:'You opened this example during this visit.',action:'Pick up where you left off',rank:75})
  actions.sort((a,b) => b.rank-a.rank || a.key.localeCompare(b.key))
  return {spotlight:actions[0]?.rank >= 85 ? actions.shift() : examples[0] || actions.shift() || null,actions:actions.slice(0,2),alternatives:examples.filter(item => item.key !== examples[0]?.key).slice(0,2)}
}
