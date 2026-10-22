// Saved creation, report observation, and calendar evidence are deliberately separate.
export function companyProgress({ governance, population, observation, today }) {
  const job = population?.job, counts = job?.counts
  const verified = governance?.calendar?.verifiedThrough || null
  const complete = Boolean(job && ['populated', 'populated-with-gaps'].includes(job.status) && counts?.required > 0 && counts.saved === counts.required && counts.unknown === 0 && counts.rejected === 0)
  const preparedThrough = complete ? [verified, job.throughDate].filter(Boolean).sort().at(-1) : verified
  const evaluation = observation?.evaluation, checks = evaluation?.checks || []
  const failures = checks.filter(check => check.status === 'failed').length
  const unanswered = checks.filter(check => !['passed', 'failed'].includes(check.status)).length
  const reportsComplete = evaluation?.reportCoverage?.complete === true
  const booksPassed = Boolean(checks.length && !failures && !unanswered && reportsComplete)
  const bookDate = observation?.period?.throughDate
  const records = {
    date: preparedThrough,
    detail: job ? counts.saved.toLocaleString() + ' of ' + counts.required.toLocaleString() + ' scheduled records saved.' + (complete ? ' Schedule: ' + job.fromDate + ' – ' + job.throughDate + '.' : ' The current schedule is incomplete.') + (counts.coverageGaps ? ' ' + counts.coverageGaps.toLocaleString() + ' records have relationship gaps.' : '') : verified ? 'From the verified business calendar.' : 'No completed business period is recorded.',
  }
  const books = {
    date: bookDate || null,
    detail: observation ? (observation.purpose === 'opening-balances' ? 'Opening observation' : 'Saved observation') + ': ' + observation.period.fromDate + ' – ' + bookDate + '. ' + (booksPassed ? 'All saved accounting checks passed.' : failures ? failures + ' accounting differences found.' : 'Some accounting evidence remains unverified.') : 'No report observation has been saved.',
    observedAt: observation?.observedAt,
  }
  let action
  const choose = (label, detail, target) => ({ label, detail, target })
  if (!governance?.published) action = choose('Review company preparation', 'Publish the business and accept its opening evidence before preparing activity.', 'business-maintenance')
  else if (job && (['running', 'stopping'].includes(job.status) || job.batch || job.metrics?.linkRepair && job.metrics.linkRepair.allPreferencesRestored !== true)) action = choose('Inspect active business work', 'Check the current batch and any pending restoration before starting more work.', 'business-population')
  else if (job && (['blocked', 'stopped', 'prepared'].includes(job.status) || counts.unknown || counts.rejected || counts.coverageGaps || counts.verificationErrors || !complete)) action = choose('Review saved business activity', 'Inspect remaining records and relationship gaps in the existing schedule.', 'business-population')
  else if (governance.currentOperation || governance.calendar?.currentOperationId || governance.calendar?.completionPending) action = choose('Review current operation', 'Inspect its saved progress and recovery or completion evidence before preparing another period.', 'business-maintenance')
  else if (governance.pendingOperations?.length) action = choose('Review the prepared operation', 'An existing plan is waiting for review. Continue it before preparing another.', 'business-maintenance')
  else if (!job && !verified) action = choose('Prepare the first business period', 'The business is published. Preview its first period from the opening date.', 'business-maintenance')
  else if (!observation || !booksPassed || observation.purpose === 'opening-balances' || preparedThrough && bookDate < preparedThrough) action = choose('Check the unchecked period', failures ? 'Review the saved differences, then capture a new report observation for the period you need.' : 'Save dated report evidence for the prepared activity. A single observation covers only its stated period.', 'business-observations')
  else if (!verified || preparedThrough && verified < preparedThrough) action = choose('Review business calendar', 'Records and report observations exist, but calendar completion still needs verification.', 'business-maintenance')
  else if (verified < today) action = choose('Prepare the next business period', 'Preview the next uninterrupted period from the verified calendar.', 'business-maintenance')
  else action = choose('Review report coverage', 'The calendar is current. Inspect the remaining report and reconciliation evidence.', '/reports')
  return { records, books, verified, action }
}

function scoped(value, scope) {
  const actual = value?.scope || value
  if (!actual || actual.realmId !== scope.realmId || actual.environment !== scope.environment || actual.connectionId !== scope.connectionId) throw new Error('The company changed. Reload Company before relying on this summary.')
  return value
}

export async function readCompanyProgress(api, scope, signal) {
  const get = async (path, params) => scoped((await api.get(path, { params, signal, timeout: 15000 })).data?.data, scope)
  const results = await Promise.allSettled([
    get('/company/business-governance'), get('/business-population'),
    get('/company/business-baseline', { limit: 1 }),
  ])
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw failures[0].reason
  const [governance, population, list] = results.map(result => result.value)
  if (!Array.isArray(list.records)) throw new Error('Saved report observations could not be confirmed.')
  if (population.job) scoped(population.job, scope)
  const latest = list.records[0]
  let observation = null
  if (latest) {
    if (!/^[a-f0-9]{24}$/.test(latest.id || '')) throw new Error('The saved observation identity could not be confirmed.')
    observation = await get('/company/business-baseline/' + latest.id)
    if (observation.id !== latest.id || observation.evidenceHash !== latest.evidenceHash || observation.accepted !== false || observation.activated !== false || !Array.isArray(observation.evaluation?.checks) || observation.period?.fromDate !== latest.period?.fromDate || observation.period?.throughDate !== latest.period?.throughDate) throw new Error('The saved accounting evidence changed. Refresh the summary.')
  }
  return { governance, population, observation }
}
