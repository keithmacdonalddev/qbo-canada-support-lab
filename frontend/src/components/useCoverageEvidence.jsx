import { useEffect, useState } from 'react'
import client from '../api/client'
import { matchesScope } from '@/lib/coverage-targets.mjs'
import { readReportPages } from '@/lib/coverage-results.mjs'

export default function useCoverageEvidence({ enabled, realmId, environment, connectionId, definitions }) {
  const initial = { state: enabled ? 'loading' : 'disconnected', data: null }
  const [saved, setSaved] = useState({ plan: initial, governance: initial, baselines: initial, reports: {} })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!enabled || !realmId || !connectionId) return
    const controller = new AbortController(), signal = controller.signal
    const scope = { realmId, environment, connectionId }
    const update = (key, value) => { if (!signal.aborted) setSaved(old => ({ ...old, [key]: value })) }
    for (const [key, path] of [['plan', '/company/business-plan'], ['governance', '/company/business-governance']]) {
      client.get(path, { signal, timeout: 15000 }).then(response => {
        const data = response.data?.data
        if (!matchesScope(data, scope)) throw new Error('Company changed')
        update(key, { state: 'ready', data })
      }).catch(() => update(key, { state: 'error', data: null }))
    }
    // Saved evidence only. No new accounting report is requested or saved.
    client.get('/company/business-baseline', { params: { limit: 10 }, signal, timeout: 15000 }).then(async response => {
      const page = response.data?.data
      if (!matchesScope(page?.scope, scope) || !Array.isArray(page.records)) throw new Error('Company changed')
      const observations = [], failures = []
      let index = 0
      await Promise.all(Array.from({ length: Math.min(2, page.records.length) }, async () => {
        while (!signal.aborted && index < page.records.length) {
          const record = page.records[index++]
          try {
            const response = await client.get('/company/business-baseline/' + encodeURIComponent(record.id), { signal, timeout: 15000 }), data = response.data?.data
            if (!matchesScope(data?.scope, scope) || data.id !== record.id || data.evidenceHash !== record.evidenceHash || !Array.isArray(data.evaluation?.reports)) throw new Error('Observation changed')
            observations.push(data)
          } catch { failures.push(record.id) }
        }
      }))
      update('baselines', { state: failures.length ? 'partial' : 'ready', data: observations, historyComplete: !page.next, failedCount: failures.length })
    }).catch(() => update('baselines', { state: 'error', data: null }))
    readReportPages(client, definitions, scope, signal, (key, value) => {
      if (!signal.aborted) setSaved(old => ({ ...old, reports: { ...old.reports, [key]: value } }))
    })
    return () => controller.abort()
  }, [enabled, realmId, environment, connectionId, definitions, revision])
  function retry() {
    setSaved({ plan: initial, governance: initial, baselines: initial, reports: {} })
    setRevision(value => value + 1)
  }
  return { saved, retry }
}
