import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { useAuth } from '../context/AuthContext'
import api from '../api/client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import ChatPanel from '../components/ai/ChatPanel'
import PlanReview from '../components/ai/PlanReview'
import ExecutionLog from '../components/ai/ExecutionLog'
import SupportNote from '../components/ai/SupportNote'
import SessionHistory from '../components/ai/SessionHistory'
import ProductionGuardDialog from '../components/ProductionGuardDialog'

export default function AICommandCenter() {
  const { id: routeSessionId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const toast = useToast()

  // Core state
  const [sessionId, setSessionId] = useState(routeSessionId || null)
  const [sessions, setSessions] = useState([])
  const [sessionsError, setSessionsError] = useState(null)
  const [messages, setMessages] = useState([])
  const [currentPlan, setCurrentPlan] = useState(null)
  const [supportNote, setSupportNote] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)
  const [streamingText, setStreamingText] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [companyInfo, setCompanyInfo] = useState(null)
  const [environment, setEnvironment] = useState(null)

  // Production guard for the AI write path (plan execution)
  const [pendingExecutePlanId, setPendingExecutePlanId] = useState(null)
  const [executeBusy, setExecuteBusy] = useState(false)
  const [executeGuardError, setExecuteGuardError] = useState(null)

  // Quick action prompts
  const [showInvestigatePrompt, setShowInvestigatePrompt] = useState(false)
  const [investigateQuestion, setInvestigateQuestion] = useState('')
  const [showIssuePackPrompt, setShowIssuePackPrompt] = useState(false)
  const [issuePackId, setIssuePackId] = useState('')

  const eventSourceRef = useRef(null)

  // Load company info and sessions on mount
  useEffect(() => {
    api.get('/company/health')
      .then(({ data }) => {
        if (data) setCompanyInfo(data)
      })
      .catch(() => {})
    api.get('/qbo/status')
      .then(({ data }) => setEnvironment(data?.environment || null))
      .catch(() => {})
    loadSessions()
  }, [])

  // Load session from route param
  useEffect(() => {
    if (routeSessionId && routeSessionId !== sessionId) {
      loadSession(routeSessionId)
    }
  }, [routeSessionId])

  // SSE connection for streaming (uses short-lived ticket, not raw JWT)
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let source = null

    async function connectSSE() {
      try {
        // Obtain a single-use ticket from the authenticated endpoint
        const { data } = await api.post('/ai/stream-ticket', { sessionId })
        if (!data.success || cancelled) return

        source = new EventSource(`/api/ai/stream/${sessionId}?ticket=${data.data.ticket}`)
        eventSourceRef.current = source

        source.addEventListener('token', (e) => {
          setStreamingText(prev => (prev || '') + e.data)
        })
        source.addEventListener('plan_proposed', (e) => {
          try {
            setCurrentPlan(JSON.parse(e.data))
          } catch { /* ignore parse errors */ }
        })
        source.addEventListener('step_completed', (e) => {
          try {
            const step = JSON.parse(e.data)
            setCurrentPlan(prev => {
              if (!prev) return prev
              return {
                ...prev,
                steps: prev.steps.map(s =>
                  s.stepNumber === step.stepNumber ? { ...s, ...step } : s
                ),
              }
            })
          } catch { /* ignore parse errors */ }
        })
        source.addEventListener('done', () => {
          setStreamingText(null)
          setIsLoading(false)
        })
        source.addEventListener('error', () => {
          // Ticket is single-use, so reconnect won't work — just clean up
          setStreamingText(null)
          if (source) source.close()
        })
      } catch {
        // Ticket request failed — SSE unavailable, fall back to polling
      }
    }

    connectSSE()

    return () => {
      cancelled = true
      if (source) source.close()
      eventSourceRef.current = null
    }
  }, [sessionId])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl+Enter — approve all pending plan steps
      if (e.ctrlKey && e.key === 'Enter' && currentPlan && currentPlan.status === 'proposed') {
        e.preventDefault()
        const allApprovals = {}
        currentPlan.steps.forEach(s => {
          allApprovals[s.stepNumber] = true
        })
        approvePlan(currentPlan._id, allApprovals)
      }
      // Escape — reject current plan
      if (e.key === 'Escape' && currentPlan && currentPlan.status === 'proposed') {
        e.preventDefault()
        rejectPlan(currentPlan._id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentPlan])

  // API: Send chat message
  const sendMessage = useCallback(async (message) => {
    setIsLoading(true)
    try {
      const { data } = await api.post('/ai/chat', { sessionId, message })
      if (data.success) {
        setSessionId(data.data.session._id)
        setMessages(data.data.session.messages)
        if (data.data.plan) setCurrentPlan(data.data.plan)
        // Update URL if new session
        if (!sessionId && data.data.session._id) {
          navigate(`/ai/session/${data.data.session._id}`, { replace: true })
        }
      }
    } catch (err) {
      const errorMsg = err.response?.data?.error || 'Failed to send message'
      setMessages(prev => [...prev, {
        role: 'system',
        content: errorMsg,
        timestamp: new Date().toISOString(),
      }])
    } finally {
      setIsLoading(false)
    }
  }, [sessionId, navigate])

  // API: Approve plan
  const approvePlan = useCallback(async (planId, stepApprovals) => {
    try {
      const { data } = await api.post(`/ai/plan/${planId}/approve`, { stepApprovals })
      if (data.success) setCurrentPlan(data.data.plan)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve plan.')
    }
  }, [toast])

  // API: Reject plan
  const rejectPlan = useCallback(async (planId) => {
    try {
      const { data } = await api.post(`/ai/plan/${planId}/reject`)
      if (data.success) setCurrentPlan(data.data.plan)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reject plan.')
    }
  }, [toast])

  // API: Execute plan — QBO write path. The click opens the production guard
  // dialog (which collects explicit confirmation); the actual write happens in
  // runExecutePlan after the user confirms. The backend enforces the same gate
  // via requireProductionConfirm (412 without confirmProduction in production).
  const executePlan = useCallback((planId) => {
    setExecuteGuardError(null)
    setPendingExecutePlanId(planId)
  }, [])

  // Performs the actual execute POST, driven from the production guard dialog.
  // Keeps the dialog open on a 412 (or any error) so the reason is shown
  // in-place; closes it only on success.
  const runExecutePlan = useCallback(async () => {
    const planId = pendingExecutePlanId
    if (!planId) return
    setExecuteBusy(true)
    setExecuteGuardError(null)
    setIsExecuting(true)
    // Treat unknown environment as production (high friction).
    const effectiveEnv = environment ?? 'production'
    const confirmFlag = effectiveEnv === 'production' ? { confirmProduction: true } : {}
    try {
      const { data } = await api.post(`/ai/plan/${planId}/execute`, confirmFlag)
      if (data.success) setCurrentPlan(data.data.plan)
      setPendingExecutePlanId(null)
    } catch (err) {
      if (err.response?.status === 412) {
        setExecuteGuardError(err.response.data?.error || 'Confirmation required to run against a real company.')
      } else {
        setExecuteGuardError(err.response?.data?.error || 'Plan execution failed. No changes may have been applied — review the plan before retrying.')
      }
      // Keep the dialog open (do not clear pendingExecutePlanId) so the user sees why.
    } finally {
      setExecuteBusy(false)
      setIsExecuting(false)
    }
  }, [pendingExecutePlanId, environment])

  // API: Load sessions
  const loadSessions = useCallback(async () => {
    setSessionsError(null)
    try {
      const { data } = await api.get('/ai/sessions')
      if (data.success) setSessions(data.data.sessions)
    } catch (err) {
      setSessionsError(err.response?.data?.error || 'Could not load session history.')
    }
  }, [])

  // API: Load specific session
  const loadSession = useCallback(async (id) => {
    try {
      const { data } = await api.get(`/ai/sessions/${id}`)
      if (data.success) {
        setSessionId(id)
        setMessages(data.data.session.messages)
        if (data.data.session.plans && data.data.session.plans.length > 0) {
          setCurrentPlan(data.data.session.plans[data.data.session.plans.length - 1])
        } else {
          setCurrentPlan(null)
        }
        setSupportNote(null)
      }
    } catch { /* ignore */ }
  }, [])

  // API: Investigate
  const investigate = useCallback(async (question) => {
    setIsLoading(true)
    try {
      const { data } = await api.post('/ai/investigate', { sessionId, question })
      if (data.success) {
        setSessionId(data.data.session._id)
        setMessages(data.data.session.messages)
        if (!sessionId && data.data.session._id) {
          navigate(`/ai/session/${data.data.session._id}`, { replace: true })
        }
      }
    } catch (err) {
      const errorMsg = err.response?.data?.error || 'Investigation failed'
      setMessages(prev => [...prev, {
        role: 'system',
        content: errorMsg,
        timestamp: new Date().toISOString(),
      }])
    } finally {
      setIsLoading(false)
    }
  }, [sessionId, navigate])

  // API: Generate note
  const generateNote = useCallback(async (format = 'escalation') => {
    try {
      const { data } = await api.post('/ai/generate-note', { sessionId, format })
      if (data.success) setSupportNote(data.data.note)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to generate support note.')
    }
  }, [sessionId, toast])

  // Start new session
  const startNewSession = useCallback(() => {
    setSessionId(null)
    setMessages([])
    setCurrentPlan(null)
    setSupportNote(null)
    setStreamingText(null)
    navigate('/ai', { replace: true })
  }, [navigate])

  // Select session from history
  const handleSelectSession = useCallback((id) => {
    navigate(`/ai/session/${id}`)
    setShowHistory(false)
  }, [navigate])

  // Quick action: investigate
  const handleInvestigateSubmit = () => {
    if (!investigateQuestion.trim()) return
    investigate(investigateQuestion.trim())
    setInvestigateQuestion('')
    setShowInvestigatePrompt(false)
  }

  // Quick action: issue pack
  const handleIssuePackSubmit = () => {
    if (!issuePackId.trim()) return
    sendMessage(`Run issue pack ${issuePackId.trim()}`)
    setIssuePackId('')
    setShowIssuePackPrompt(false)
  }

  return (
    <Layout>
      <div className="flex flex-col h-[calc(100vh-7rem)]">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div>
            <h1 className="text-[22px] font-semibold text-[var(--text-heading)]">AI Command Center</h1>
            <p className="text-sm text-[#6B7280]">
              Ask questions, investigate issues, and generate support notes with AI assistance.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={startNewSession}>
              New Session
            </Button>
            <Button
              variant={showHistory ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
            >
              Session History
            </Button>
          </div>
        </div>

        {/* Session history panel */}
        {showHistory && (
          <div className="mb-4 shrink-0">
            <SessionHistory
              sessions={sessions}
              currentSessionId={sessionId}
              onSelectSession={handleSelectSession}
              onNewSession={startNewSession}
              onRefresh={loadSessions}
              error={sessionsError}
            />
          </div>
        )}

        {/* Main two-column layout */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
          {/* Left column: Chat */}
          <div className="min-h-0 flex flex-col">
            <ChatPanel
              messages={messages}
              isLoading={isLoading}
              streamingText={streamingText}
              onSendMessage={sendMessage}
              userName={user?.displayName || user?.email}
            />
          </div>

          {/* Right column: Context panel */}
          <div className="min-h-0 overflow-y-auto space-y-4">
            {/* Company info card */}
            {companyInfo && (
              <Card className="shadow-sm py-0">
                <CardContent className="py-4">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-2">Company Context</div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-[var(--text-heading)]">
                        {companyInfo.companyName || 'Unknown Company'}
                      </span>
                      <Badge variant={companyInfo.connectionStatus === 'active' ? 'secondary' : 'destructive'}>
                        {companyInfo.connectionStatus === 'active' ? 'Connected' : 'Disconnected'}
                      </Badge>
                    </div>
                    {companyInfo.realmId && (
                      <div className="text-xs text-[#6B7280]">Realm: {companyInfo.realmId}</div>
                    )}
                    <div className="flex gap-3 mt-1">
                      {companyInfo.entityCounts && (
                        <>
                          <span className="text-xs text-[#6B7280]">
                            {companyInfo.entityCounts?.customers || 0} customers
                          </span>
                          <span className="text-xs text-[#6B7280]">
                            {companyInfo.entityCounts?.vendors || 0} vendors
                          </span>
                          <span className="text-xs text-[#6B7280]">
                            {companyInfo.entityCounts?.items || 0} items
                          </span>
                        </>
                      )}
                    </div>
                    {companyInfo.freshnessScore != null && (
                      <div className="text-xs text-[#6B7280]">
                        Freshness: {companyInfo.freshnessScore}%
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Active Plan */}
            {currentPlan && (
              <PlanReview
                plan={currentPlan}
                onApprove={approvePlan}
                onReject={rejectPlan}
                onExecute={executePlan}
                isExecuting={isExecuting}
              />
            )}

            {/* Execution log — shown during or after execution */}
            {currentPlan && (currentPlan.status === 'executing' || currentPlan.status === 'completed' || currentPlan.status === 'failed') && (
              <ExecutionLog plan={currentPlan} isExecuting={isExecuting} />
            )}

            {/* Support note */}
            {supportNote && (
              <SupportNote
                note={supportNote}
                onRegenerate={(format) => generateNote(format)}
                onClear={() => setSupportNote(null)}
              />
            )}

            {/* Empty state when no context */}
            {!currentPlan && !supportNote && !companyInfo && (
              <Card className="shadow-sm py-0">
                <CardContent className="py-8 text-center">
                  <div className="text-2xl mb-2">&#9671;</div>
                  <p className="text-sm text-[#6B7280]">
                    Start a conversation to see plans, execution logs, and generated notes here.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Quick actions bar */}
        <div className="shrink-0 mt-4 pt-3 border-t border-[var(--border)]">
          {/* Investigate prompt */}
          {showInvestigatePrompt && (
            <div className="flex gap-2 mb-3">
              <Input
                placeholder="What do you want to investigate? e.g., 'Why does customer ABC have a negative balance?'"
                value={investigateQuestion}
                onChange={(e) => setInvestigateQuestion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleInvestigateSubmit()}
                autoFocus
                className="flex-1"
              />
              <Button size="sm" onClick={handleInvestigateSubmit} disabled={!investigateQuestion.trim()}>
                Go
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowInvestigatePrompt(false)}>
                Cancel
              </Button>
            </div>
          )}

          {/* Issue pack prompt */}
          {showIssuePackPrompt && (
            <div className="flex gap-2 mb-3">
              <Input
                placeholder="Issue pack name or ID..."
                value={issuePackId}
                onChange={(e) => setIssuePackId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleIssuePackSubmit()}
                autoFocus
                className="flex-1"
              />
              <Button size="sm" onClick={handleIssuePackSubmit} disabled={!issuePackId.trim()}>
                Run
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowIssuePackPrompt(false)}>
                Cancel
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs text-[#6B7280] mr-1">Quick actions:</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowInvestigatePrompt(true)
                setShowIssuePackPrompt(false)
              }}
              disabled={isLoading}
            >
              Investigate...
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowIssuePackPrompt(true)
                setShowInvestigatePrompt(false)
              }}
              disabled={isLoading}
            >
              Run Issue Pack...
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => generateNote('escalation')}
              disabled={!sessionId || isLoading}
            >
              Generate Note
            </Button>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs text-[#6B7280]">
                Ctrl+Enter: approve plan
              </span>
              <span className="text-xs text-[#6B7280]">
                Esc: reject plan
              </span>
            </div>
          </div>
        </div>
      </div>

      <ProductionGuardDialog
        key={pendingExecutePlanId || 'none'}
        open={!!pendingExecutePlanId}
        loading={executeBusy}
        error={executeGuardError}
        environment={environment ?? 'production'}
        title="Execute AI Plan"
        actionLabel={executeBusy ? 'Executing...' : 'Execute Plan'}
        description="Runs the approved plan's write steps against the connected QuickBooks company using the app's internal tools."
        onConfirm={runExecutePlan}
        onCancel={() => {
          if (!executeBusy) {
            setPendingExecutePlanId(null)
            setExecuteGuardError(null)
          }
        }}
      />
    </Layout>
  )
}
