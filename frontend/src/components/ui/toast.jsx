/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const TOAST_VARIANTS = {
  error: {
    container: "bg-red-50 border-red-200 text-[var(--danger)]",
    icon: AlertTriangle,
  },
  success: {
    container: "bg-green-50 border-green-200 text-[var(--success)]",
    icon: CheckCircle2,
  },
  info: {
    container: "bg-white border-border text-[var(--text-heading)]",
    icon: Info,
  },
}

const DEFAULT_DURATION = 6000

const ToastContext = createContext(null)

/**
 * Access the toast dispatcher. Returns a stable `toast` object with helpers:
 *   toast.error(message), toast.success(message), toast.info(message)
 * or toast.show({ variant, message, title, duration }) for full control.
 * Each helper returns the toast id (usable with toast.dismiss).
 */
export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>")
  }
  return ctx
}

function ToastCard({ toast, onDismiss }) {
  const config = TOAST_VARIANTS[toast.variant] || TOAST_VARIANTS.info
  const Icon = config.icon

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex w-[340px] max-w-[calc(100vw-2rem)] items-start gap-2.5 rounded-lg border px-3.5 py-3 shadow-md",
        config.container
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1 min-w-0">
        {toast.title && (
          <div className="text-[13px] font-semibold leading-tight">{toast.title}</div>
        )}
        <div className={cn("text-[13px] font-medium break-words", toast.title && "mt-0.5 opacity-90")}>
          {toast.message}
        </div>
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-mt-1 -mr-1.5 shrink-0 text-current hover:bg-black/5"
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (input) => {
      const opts = typeof input === "string" ? { message: input } : input || {}
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const duration = opts.duration ?? DEFAULT_DURATION
      setToasts((prev) => [
        ...prev,
        { id, variant: opts.variant || "info", message: opts.message, title: opts.title },
      ])
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration)
        timers.current.set(id, timer)
      }
      return id
    },
    [dismiss]
  )

  // Clean up any pending timers on unmount.
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((timer) => clearTimeout(timer))
      map.clear()
    }
  }, [])

  const toast = useMemo(
    () => ({
      show: (input) => push(input),
      error: (message, opts) => push({ ...opts, variant: "error", message }),
      success: (message, opts) => push({ ...opts, variant: "success", message }),
      info: (message, opts) => push({ ...opts, variant: "info", message }),
      dismiss,
    }),
    [push, dismiss]
  )

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
