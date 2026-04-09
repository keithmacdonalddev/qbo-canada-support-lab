import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Plus, MessageSquare } from 'lucide-react'

const STATUS_STYLES = {
  active: { variant: 'default', className: 'bg-green-100 text-green-800' },
  completed: { variant: 'default', className: 'bg-blue-100 text-blue-800' },
  archived: { variant: 'secondary', className: 'bg-gray-100 text-gray-600' },
}

const MODE_LABELS = {
  suggest: 'Suggest',
  investigate: 'Investigate',
  generate_note: 'Note',
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return ''
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffSec = Math.floor((now - then) / 1000)

  if (diffSec < 60) return 'Just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return 'Yesterday'
  if (diffDay < 7) return `${diffDay}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function SessionRow({ session, isActive, onSelect }) {
  const messageCount = Array.isArray(session.messages)
    ? session.messages.length
    : (typeof session.messages === 'number' ? session.messages : 0)

  const statusStyle = STATUS_STYLES[session.status] || STATUS_STYLES.archived

  return (
    <button
      type="button"
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-lg transition-colors hover:bg-muted',
        isActive && 'bg-muted ring-1 ring-border'
      )}
      onClick={() => onSelect(session._id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm font-medium truncate', isActive && 'text-foreground')}>
            {session.title || 'Untitled Session'}
          </p>
          <div className="flex items-center gap-1.5 mt-1">
            <Badge className={cn('text-[10px]', statusStyle.className)}>
              {session.status || 'active'}
            </Badge>
            {session.mode && (
              <Badge variant="outline" className="text-[10px]">
                {MODE_LABELS[session.mode] || session.mode}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end shrink-0">
          <span className="text-[10px] text-[#9CA3AF]">
            {formatRelativeTime(session.updatedAt)}
          </span>
          {messageCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-[#9CA3AF] mt-1">
              <MessageSquare className="size-2.5" />
              {messageCount}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

export default function SessionHistory({ sessions, currentSessionId, onSelectSession, onNewSession }) {
  const sorted = sessions
    ? [...sessions].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    : []

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-3 border-b border-border">
        <Button className="w-full" size="sm" onClick={onNewSession}>
          <Plus className="size-3.5 mr-1" />
          New Session
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-2 space-y-0.5">
        {sorted.length === 0 && (
          <p className="text-xs text-[#6B7280] text-center py-6">No sessions yet.</p>
        )}
        {sorted.map((session) => (
          <SessionRow
            key={session._id}
            session={session}
            isActive={session._id === currentSessionId}
            onSelect={onSelectSession}
          />
        ))}
      </div>
    </div>
  )
}
