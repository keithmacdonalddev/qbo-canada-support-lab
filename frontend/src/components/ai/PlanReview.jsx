import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Check, X, Loader2, Clock, Minus, AlertTriangle, ThumbsUp, ThumbsDown,
} from 'lucide-react'

const STATUS_CONFIG = {
  pending: { icon: Clock, color: 'text-yellow-600', bg: 'bg-yellow-100', label: 'Pending' },
  approved: { icon: Check, color: 'text-green-600', bg: 'bg-green-100', label: 'Approved' },
  rejected: { icon: X, color: 'text-red-600', bg: 'bg-red-100', label: 'Rejected' },
  executing: { icon: Loader2, color: 'text-blue-600', bg: 'bg-blue-100', label: 'Executing', spin: true },
  completed: { icon: Check, color: 'text-green-600', bg: 'bg-green-100', label: 'Completed' },
  failed: { icon: X, color: 'text-red-600', bg: 'bg-red-100', label: 'Failed' },
  skipped: { icon: Minus, color: 'text-gray-400', bg: 'bg-gray-100', label: 'Skipped' },
}

function StepStatusIcon({ status }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending
  const Icon = config.icon
  return (
    <div className={cn('flex items-center justify-center size-6 rounded-full', config.bg)}>
      <Icon className={cn('size-3.5', config.color, config.spin && 'animate-spin')} />
    </div>
  )
}

function StepRow({ step, canToggle, onToggleApproval }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-b-0">
      <Badge variant="outline" className="font-mono text-[10px] shrink-0 w-6 justify-center">
        {step.stepNumber}
      </Badge>

      <StepStatusIcon status={step.status} />

      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{step.description}</p>
        <Badge variant="secondary" className="font-mono text-[10px] mt-0.5">
          {step.toolName}
        </Badge>
      </div>

      {canToggle && step.status === 'pending' && (
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-green-600 hover:bg-green-50"
            onClick={() => onToggleApproval(step.stepNumber, true)}
          >
            <ThumbsUp className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-red-600 hover:bg-red-50"
            onClick={() => onToggleApproval(step.stepNumber, false)}
          >
            <ThumbsDown className="size-3" />
          </Button>
        </div>
      )}

      {!canToggle && (
        <Badge
          variant={step.status === 'completed' ? 'default' : step.status === 'failed' ? 'destructive' : 'secondary'}
          className="text-[10px] shrink-0"
        >
          {STATUS_CONFIG[step.status]?.label || step.status}
        </Badge>
      )}
    </div>
  )
}

export default function PlanReview({ plan, onApprove, onReject, onExecute }) {
  const [stepApprovals, setStepApprovals] = useState({})

  if (!plan) return null

  const { _id, description, status, steps = [] } = plan
  const isProposed = status === 'proposed'
  const isApproved = status === 'approved' || status === 'partially_approved'

  const writeStepCount = steps.filter(
    (s) => s.requiresConfirmation
  ).length

  const handleToggleApproval = (stepNumber, approved) => {
    setStepApprovals((prev) => ({
      ...prev,
      [stepNumber]: approved,
    }))
  }

  const handleApproveAll = () => {
    if (onApprove) {
      const approvals = Object.keys(stepApprovals).length > 0
        ? Object.entries(stepApprovals).map(([stepNumber, approved]) => ({ stepNumber: Number(stepNumber), approved }))
        : undefined
      onApprove(_id, approvals)
    }
  }

  const handleReject = () => {
    if (onReject) onReject(_id)
  }

  const handleExecute = () => {
    if (onExecute) onExecute(_id)
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>{description || 'Execution Plan'}</CardTitle>
      </CardHeader>

      <CardContent>
        {writeStepCount > 5 && (
          <div className="flex items-center gap-2 mb-4 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 text-sm text-yellow-800">
            <AlertTriangle className="size-4 shrink-0" />
            <span>This plan has {writeStepCount} write steps. Review each step carefully.</span>
          </div>
        )}

        <div>
          {steps.map((step) => (
            <StepRow
              key={step.stepNumber}
              step={step}
              canToggle={isProposed}
              onToggleApproval={handleToggleApproval}
            />
          ))}
        </div>
      </CardContent>

      {(isProposed || isApproved) && (
        <CardFooter className="gap-2">
          {isProposed && (
            <>
              <Button onClick={handleApproveAll}>
                <Check className="size-4 mr-1" />
                Approve All
              </Button>
              <Button variant="destructive" onClick={handleReject}>
                <X className="size-4 mr-1" />
                Reject
              </Button>
            </>
          )}
          {isApproved && (
            <Button onClick={handleExecute}>
              Execute
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  )
}
