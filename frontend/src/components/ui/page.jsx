import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

// Page scaffolding shared by the redesigned pages, matching Company and Reproduce.

export function PageHeader({ title, description, actions }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--ink)]">{title}</h1>
        {description && <p className="mt-1 text-[13.5px] text-[var(--ink-2)]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Panel({ title, description, action, children, className }) {
  return (
    <section className={cn('rounded-[10px] border border-[var(--line)] bg-[var(--surface)]', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold text-[var(--ink)]">{title}</h2>}
            {description && <p className="mt-0.5 text-[12.5px] text-[var(--ink-3)]">{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function FactRow({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
      <dt className="shrink-0 text-[var(--ink-2)]">{label}</dt>
      <dd className="min-w-0 text-right text-[var(--ink)]">{children}</dd>
    </div>
  )
}

export function Muted({ children, className }) {
  return <p className={cn('px-5 py-4 text-[13px] text-[var(--ink-3)]', className)}>{children}</p>
}

export function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  const copy = () => navigator.clipboard?.writeText(String(value)).then(() => {
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }).catch(() => {})
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded p-0.5 text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

// Pill-style segmented filter. options: [{ value, label }]
export function Segmented({ value, onChange, options, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg bg-[var(--sunken)] p-1">
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px] transition-colors duration-100',
              active
                ? 'bg-[var(--surface)] font-medium text-[var(--ink)] shadow-[0_0_0_1px_var(--line)]'
                : 'text-[var(--ink-2)] hover:text-[var(--ink)]',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
