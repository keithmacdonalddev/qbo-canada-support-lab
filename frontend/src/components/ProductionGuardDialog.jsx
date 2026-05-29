import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

/**
 * ProductionGuardDialog — a reusable confirm gate for write actions.
 *
 * In sandbox (environment !== 'production') this is a low-friction confirm:
 * a simple title/description with Confirm + Cancel.
 *
 * In production (environment === 'production') this is HIGH-FRICTION. The user
 * must both (1) tick a checkbox acknowledging they understand this modifies a
 * real connected QuickBooks company, and (2) type the word PRODUCTION exactly
 * before the destructive confirm button enables.
 *
 * Props:
 *   open         — when false, renders null.
 *   environment  — 'production' | 'sandbox' (or anything non-'production').
 *   title        — heading text.
 *   actionLabel  — label for the primary confirm button (e.g. 'Seed Company').
 *   description  — supporting copy under the title.
 *   onConfirm    — called when the user confirms.
 *   onCancel     — called when the user cancels / dismisses.
 *   loading      — disables controls and shows a busy state on confirm.
 *   error        — optional message surfaced in-place (e.g. a 412) so the
 *                  dialog can stay open and explain why the action failed.
 *
 * The high-friction inputs (checkbox + typed confirmation) are local state.
 * Callers should mount this with a `key` that changes per action (e.g. the
 * pending action name) so it remounts fresh each time and no prior
 * confirmation can carry over.
 */
export default function ProductionGuardDialog({
  open,
  environment,
  title,
  actionLabel = 'Confirm',
  description,
  onConfirm,
  onCancel,
  loading = false,
  error,
}) {
  const isProduction = environment === 'production'
  const [acknowledged, setAcknowledged] = useState(false)
  const [typed, setTyped] = useState('')

  if (!open) return null

  const typedMatches = typed.trim() === 'PRODUCTION'
  const canConfirm = !loading && (!isProduction || (acknowledged && typedMatches))

  const handleConfirm = () => {
    if (!canConfirm) return
    onConfirm?.()
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={() => { if (!loading) onCancel?.() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="production-guard-title"
        className="bg-white rounded-lg shadow-lg max-w-[480px] w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="production-guard-title"
          className="text-lg font-semibold text-[var(--text-heading)] mb-2"
        >
          {title}
        </h2>

        {description && (
          <p className="text-sm text-[#6B7280] mb-4">{description}</p>
        )}

        {isProduction ? (
          <>
            <Alert variant="error" className="mb-4 items-start">
              <span>
                This writes test data into a <strong>REAL connected QuickBooks
                company</strong>. These records will appear in the live books and
                are not automatically removed. Make sure you have a way to
                restore or accept this change before continuing.
              </span>
            </Alert>

            <label className="flex items-start gap-2.5 mb-4 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={loading}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--danger)] cursor-pointer"
              />
              <span className="text-[13px] text-[var(--text-heading)] leading-snug">
                I have created a restore{' '}
                <Link
                  to="/checkpoints"
                  className="text-[var(--primary)] font-medium underline-offset-2 hover:underline"
                >
                  checkpoint
                </Link>{' '}
                (or accept the risk) and understand this modifies a real company.
              </span>
            </label>

            <div className="mb-5">
              <Label htmlFor="production-guard-confirm-input" className="mb-1.5 text-[13px]">
                Type <span className="font-mono font-semibold text-[var(--danger)]">PRODUCTION</span> to confirm
              </Label>
              <Input
                id="production-guard-confirm-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={loading}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="PRODUCTION"
                className={cn(
                  'font-mono',
                  typed && !typedMatches && 'border-[var(--danger)]'
                )}
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-[#6B7280] mb-5">
            This runs against your <span className="font-medium">sandbox</span>{' '}
            company. No live books are affected.
          </p>
        )}

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        <div className="flex items-center justify-end gap-2.5">
          <Button variant="ghost" onClick={() => onCancel?.()} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={isProduction ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {loading ? 'Working...' : actionLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
