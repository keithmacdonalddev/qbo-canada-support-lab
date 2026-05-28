import { AlertTriangle, Info, CheckCircle2, RotateCw } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const ALERT_VARIANTS = {
  error: {
    container: "bg-red-50 border-red-200 text-[var(--danger)]",
    icon: AlertTriangle,
  },
  warning: {
    container: "bg-yellow-50 border-yellow-200 text-yellow-800",
    icon: AlertTriangle,
  },
  success: {
    container: "bg-green-50 border-green-200 text-[var(--success)]",
    icon: CheckCircle2,
  },
  info: {
    container: "bg-muted/50 border-border text-[var(--text-heading)]",
    icon: Info,
  },
}

/**
 * Lightweight inline alert for non-intrusive error/status surfacing.
 * Optionally renders a retry affordance.
 */
function Alert({
  variant = "info",
  children,
  onRetry,
  retryLabel = "Retry",
  className,
  ...props
}) {
  const config = ALERT_VARIANTS[variant] || ALERT_VARIANTS.info
  const Icon = config.icon

  return (
    <div
      role="alert"
      data-slot="alert"
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium",
        config.container,
        className
      )}
      {...props}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 min-w-0">{children}</span>
      {onRetry && (
        <Button
          size="xs"
          variant="ghost"
          onClick={onRetry}
          className="shrink-0 -my-1 -mr-1.5 text-current hover:bg-black/5"
        >
          <RotateCw className="size-3" />
          {retryLabel}
        </Button>
      )}
    </div>
  )
}

export { Alert }
