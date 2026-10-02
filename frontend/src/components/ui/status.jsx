/* eslint-disable react-refresh/only-export-components */
// Shared status vocabulary: one meaning per colour, always paired with text.

export function connectionSummary(company, companyError) {
  if (companyError) return { tone: 'attention', label: 'Status unavailable' }
  if (!company) return { tone: 'muted', label: 'Checking…' }
  if (company.connected) return { tone: 'ok', label: 'Connected' }
  if (company.status === 'expired') return { tone: 'attention', label: 'Needs reconnect' }
  if (company.status === 'none') return { tone: 'muted', label: 'Not connected' }
  return { tone: 'danger', label: 'Disconnected' }
}

const DOT_TONE = {
  ok: 'bg-[var(--ok)]',
  attention: 'bg-[var(--attention-dot)]',
  danger: 'bg-[var(--danger-ink)]',
  muted: 'bg-[var(--ink-3)]',
}

export function StatusDot({ tone = 'muted', className = '' }) {
  return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${DOT_TONE[tone] || DOT_TONE.muted} ${className}`} />
}

export function EnvironmentTag({ environment }) {
  if (!environment) return null
  const isProduction = environment === 'production'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-medium ${
        isProduction
          ? 'bg-[var(--production-soft)] text-[var(--production)]'
          : 'bg-[var(--sunken)] text-[var(--ink-2)]'
      }`}
    >
      {isProduction && <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--production)]" />}
      {isProduction ? 'Production · real company' : 'Sandbox'}
    </span>
  )
}
