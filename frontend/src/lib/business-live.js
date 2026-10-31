// Data for the Live panel on the first page: the activity feed (polled) and the accountant's
// review session transcript (streamed with Server-Sent Events, polled every 2 s as a fallback).
import { useEffect, useRef, useState } from 'react'
import { AuthenticatedEventSource } from './authenticated-event-source.mjs'
import { workspaceScope } from './business-workspace.mjs'

const BASE = '/company/business-agent'
const FAST_MS = 2500, IDLE_MS = 10000, POLL_MS = 2000, STREAM_RETRY_MS = 15000, ATTEMPTS_MS = 15000
const MAX_ENTRIES = 2000
const ATTEMPT = /^[A-Za-z0-9-]{8,64}$/

// Polls the live feed: every 2.5 s while a review or a send is in progress (as reported by the
// feed itself, or by the workspace status via `hurry`), otherwise at the slower idle cadence.
// A failed read keeps the last feed on screen and retries.
export function useLiveFeed(api, scope, enabled, hurry) {
  const [feed, setFeed] = useState(null)
  const [failed, setFailed] = useState(false)
  const scopeKey = [scope.realmId, scope.environment, scope.connectionId].join(':')
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let timer, last = null
    async function load() {
      try {
        const response = await api.get(BASE + '/live', { signal: controller.signal, timeout: 8000 })
        const value = workspaceScope(response.data?.data, scope)
        if (!controller.signal.aborted) { last = value; setFeed(value); setFailed(false) }
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, last?.active || hurry ? FAST_MS : Math.max(FAST_MS, Math.min(30000, Number(last?.pollMs) || IDLE_MS)))
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
    // The workspace remounts on company change; responses are checked against this exact scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, scopeKey, hurry])
  return { feed, failed }
}

function merge(list, incoming) {
  if (!incoming.length) return list
  const bySeq = new Map(list.map(entry => [entry.seq, entry]))
  for (const entry of incoming) if (Number.isSafeInteger(entry?.seq)) bySeq.set(entry.seq, entry)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_ENTRIES)
}

// The review session transcript. `selected` null follows the newest review as it streams;
// an attempt id shows that saved review. Returns { attempts, attemptId, entries, mode, select }.
export function useTranscript(api, scope, enabled) {
  const [attempts, setAttempts] = useState([])
  const [selected, setSelected] = useState(null)
  const [byAttempt, setByAttempt] = useState({})
  const [mode, setMode] = useState('connecting')
  const [latest, setLatest] = useState(null)
  const cursor = useRef(null)
  const scopeKey = [scope.realmId, scope.environment, scope.connectionId].join(':')
  const add = (attemptId, entries) => {
    if (!ATTEMPT.test(attemptId || '') || !entries.length) return
    setByAttempt(current => ({ ...current, [attemptId]: merge(current[attemptId] || [], entries) }))
  }

  // Recent reviews for the selector.
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let timer
    async function load() {
      try {
        const response = await api.get(BASE + '/transcripts', { signal: controller.signal, timeout: 8000 })
        const value = workspaceScope(response.data?.data, scope)
        if (!controller.signal.aborted) {
          const rows = Array.isArray(value.attempts) ? value.attempts.filter(row => ATTEMPT.test(row?.attemptId || '')) : []
          setAttempts(rows)
          if (rows[0]) setLatest(previous => previous || rows[0].attemptId)
        }
      } catch { /* the selector keeps its last list */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, ATTEMPTS_MS) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, scopeKey])

  // Follow the newest review: stream, falling back to polling, resuming from the last entry seen.
  useEffect(() => {
    if (!enabled) return
    let source = null, pollTimer = null, retryTimer = null, stopped = false
    const controller = new AbortController()
    const receive = entry => {
      if (!entry || !ATTEMPT.test(entry.attemptId || '') || !Number.isSafeInteger(entry.seq)) return
      const previous = cursor.current
      if (!previous || previous.attemptId !== entry.attemptId || entry.seq > previous.seq) cursor.current = { attemptId: entry.attemptId, seq: entry.seq }
      if (previous?.attemptId !== entry.attemptId) {
        setLatest(entry.attemptId)
        setAttempts(rows => rows.some(row => row.attemptId === entry.attemptId) ? rows : [{ attemptId: entry.attemptId, role: entry.role, provider: entry.provider, startedAt: entry.at, outcome: null }, ...rows].slice(0, 20))
      }
      if (entry.kind === 'outcome') setAttempts(rows => rows.map(row => row.attemptId === entry.attemptId ? { ...row, outcome: entry.status, endedAt: entry.at } : row))
      add(entry.attemptId, [entry])
    }
    async function poll() {
      if (stopped) return
      try {
        let attemptId = cursor.current?.attemptId
        if (!attemptId) {
          const list = workspaceScope((await api.get(BASE + '/transcripts', { signal: controller.signal, timeout: 8000 })).data?.data, scope)
          attemptId = list.attempts?.[0]?.attemptId
        }
        if (attemptId && ATTEMPT.test(attemptId)) {
          const after = cursor.current?.attemptId === attemptId ? cursor.current.seq : 0
          const page = workspaceScope((await api.get(BASE + '/transcripts/' + attemptId + '/after/' + after, { signal: controller.signal, timeout: 8000 })).data?.data, scope)
          for (const entry of page.entries || []) receive(entry)
        }
      } catch { /* keep polling */ }
      if (!stopped) pollTimer = setTimeout(poll, POLL_MS)
    }
    function stream() {
      if (stopped) return
      clearTimeout(pollTimer); pollTimer = null
      const headers = cursor.current ? { 'Last-Event-ID': cursor.current.attemptId + ':' + cursor.current.seq } : {}
      source = new AuthenticatedEventSource('/api' + BASE + '/transcripts/stream', { headers })
      source.addEventListener('ready', () => { if (!stopped) setMode('streaming') })
      source.addEventListener('entry', event => { try { receive(JSON.parse(event.data)) } catch { /* ignore a malformed frame */ } })
      source.addEventListener('error', () => {
        source?.close(); source = null
        if (stopped) return
        setMode('polling')
        void poll()
        retryTimer = setTimeout(stream, STREAM_RETRY_MS)
      })
    }
    stream()
    return () => { stopped = true; controller.abort(); source?.close(); clearTimeout(pollTimer); clearTimeout(retryTimer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, scopeKey])

  // A saved earlier review: load its entries once.
  useEffect(() => {
    if (!enabled || !selected || !ATTEMPT.test(selected)) return
    const controller = new AbortController()
    api.get(BASE + '/transcripts/' + selected + '/after/0', { signal: controller.signal, timeout: 8000 })
      .then(response => { const page = workspaceScope(response.data?.data, scope); if (!controller.signal.aborted) add(selected, page.entries || []) })
      .catch(() => {})
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, scopeKey, selected])

  const attemptId = selected || latest
  return { attempts, attemptId, following: !selected, entries: attemptId ? byAttempt[attemptId] || [] : [], mode, select: value => setSelected(value && ATTEMPT.test(value) ? value : null) }
}
