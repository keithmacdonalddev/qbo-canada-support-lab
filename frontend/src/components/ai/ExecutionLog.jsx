import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Check, X, Loader2, Minus, ChevronDown, ChevronUp,
} from 'lucide-react'

function StepIcon({ status }) {
  switch (status) {
    case 'executing':
      return <Loader2 className="size-4 text-blue-600 animate-spin" />
    case 'completed':
      return <Check className="size-4 text-green-600" />
    case 'failed':
      return <X className="size-4 text-red-600" />
    case 'skipped':
      return <Minus className="size-4 text-gray-400" />
    default:
      return <div className="size-4 rounded-full border-2 border-gray-300" />
  }
}

function StepEntry({ step }) {
  const [expanded, setExpanded] = useState(false)
  const hasResult = step.status === 'completed' && step.result
  const hasFailed = step.status === 'failed' && step.error
  const resultPreview = hasResult
    ? (typeof step.result === 'string' ? step.result : JSON.stringify(step.result)).slice(0, 100)
    : null

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="mt-0.5">
          <StepIcon status={step.status} />
        </div>
        <div className="w-px flex-1 bg-border mt-1" />
      </div>

      <div className="flex-1 pb-4 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn(
            'text-sm font-medium',
            step.status === 'failed' && 'text-red-600',
            step.status === 'skipped' && 'text-[#9CA3AF]',
            (step.status === 'pending') && 'text-[#6B7280]',
          )}>
            {step.description}
          </span>
          {step.duration && (
            <span className="text-[10px] text-[#9CA3AF] tabular-nums">{step.duration}</span>
          )}
        </div>

        {hasFailed && (
          <p className="text-xs text-red-600 mt-1">{step.error}</p>
        )}

        {hasResult && (
          <div className="mt-1">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-[#6B7280] hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              <span className="font-mono truncate max-w-[300px]">
                {expanded ? 'Collapse' : resultPreview}
              </span>
            </button>
            {expanded && (
              <div className="mt-1 rounded border border-border bg-gray-50 p-2 text-xs font-mono max-h-40 overflow-auto whitespace-pre-wrap break-all">
                {typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 2)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ProgressBar({ current, total }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-600 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-[#6B7280] tabular-nums shrink-0">
        Step {current} of {total}
      </span>
    </div>
  )
}

function ElapsedTimer({ isRunning, startTime }) {
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef(null)

  useEffect(() => {
    if (isRunning && startTime) {
      const tick = () => setElapsed(Math.floor((Date.now() - new Date(startTime).getTime()) / 1000))
      tick()
      intervalRef.current = setInterval(tick, 1000)
      return () => clearInterval(intervalRef.current)
    }
    if (intervalRef.current) clearInterval(intervalRef.current)
  }, [isRunning, startTime])

  if (!isRunning && elapsed === 0) return null

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const display = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  return (
    <span className="text-xs text-[#6B7280] tabular-nums">
      Elapsed: {display}
    </span>
  )
}

export default function ExecutionLog({ plan, isExecuting }) {
  if (!plan || !plan.steps) return null

  const { steps } = plan
  const completedCount = steps.filter(
    (s) => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
  ).length
  const executingStep = steps.find((s) => s.status === 'executing')
  const currentStepNum = executingStep
    ? executingStep.stepNumber
    : completedCount

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isExecuting && (
            <Badge variant="default" className="text-[10px]">
              <Loader2 className="size-3 animate-spin mr-1" />
              Executing
            </Badge>
          )}
          {!isExecuting && completedCount === steps.length && (
            <Badge className="bg-green-100 text-green-800 text-[10px]">Complete</Badge>
          )}
        </div>
        <ElapsedTimer isRunning={isExecuting} startTime={plan.executionStartedAt} />
      </div>

      <ProgressBar current={currentStepNum} total={steps.length} />

      <div className="mt-4">
        {steps.map((step) => (
          <StepEntry key={step.stepNumber} step={step} />
        ))}
      </div>
    </div>
  )
}
