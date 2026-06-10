import { useState, useEffect, useRef, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Send, ChevronDown, ChevronUp, Wrench } from 'lucide-react'

function ToolCallBubble({ toolCall }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mt-1.5">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        <Wrench className="size-3 text-[#6B7280]" />
        <Badge variant="secondary" className="font-mono text-[10px]">
          {toolCall.name}
        </Badge>
        {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>
      {expanded && (
        <div className="mt-1 rounded border border-border bg-gray-50 p-2 text-xs font-mono max-h-40 overflow-auto">
          {toolCall.input && (
            <div className="mb-1">
              <span className="font-semibold text-[#6B7280]">Input:</span>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(toolCall.input, null, 2)}</pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <span className="font-semibold text-[#6B7280]">Result:</span>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(toolCall.result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message, isStreaming, streamingText }) {
  const { role, content, toolCalls, timestamp } = message

  if (role === 'tool_result') {
    return <ToolResultBubble content={content} />
  }

  const isUser = role === 'user'
  const displayContent = isStreaming ? (streamingText || '') : (content || '')

  return (
    <div className={cn('flex mb-3', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm',
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-gray-50 border border-border text-foreground'
        )}
      >
        <div className="whitespace-pre-wrap break-words">{displayContent}</div>
        {isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-current ml-0.5 animate-pulse" />
        )}
        {toolCalls && toolCalls.length > 0 && (
          <div className="mt-2 border-t border-border/50 pt-2">
            {toolCalls.map((tc, i) => (
              <ToolCallBubble key={i} toolCall={tc} />
            ))}
          </div>
        )}
        {timestamp && (
          <div className={cn('text-[10px] mt-1', isUser ? 'text-blue-200' : 'text-[#9CA3AF]')}>
            {new Date(timestamp).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolResultBubble({ content }) {
  const [expanded, setExpanded] = useState(false)
  const preview = typeof content === 'string' ? content.slice(0, 80) : JSON.stringify(content).slice(0, 80)

  return (
    <div className="flex justify-start mb-2 pl-4">
      <div className="max-w-[70%]">
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-[#6B7280] hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          <Badge variant="outline" className="text-[10px]">tool result</Badge>
          {!expanded && <span className="font-mono truncate">{preview}...</span>}
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
        {expanded && (
          <div className="mt-1 rounded border border-border bg-gray-50 p-2 text-xs font-mono max-h-48 overflow-auto whitespace-pre-wrap break-all">
            {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
          </div>
        )}
      </div>
    </div>
  )
}

function ThinkingIndicator() {
  return (
    <div className="flex justify-start mb-3">
      <div className="bg-gray-50 border border-border rounded-xl px-3.5 py-2.5 text-sm text-[#6B7280]">
        AI is thinking
        <span className="inline-flex ml-1">
          <span className="animate-bounce delay-0">.</span>
          <span className="animate-bounce delay-150">.</span>
          <span className="animate-bounce delay-300">.</span>
        </span>
      </div>
    </div>
  )
}

export default function ChatPanel({ messages, onSendMessage, isLoading, streamingText }) {
  const [input, setInput] = useState('')
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingText, isLoading, scrollToBottom])

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const lineHeight = 20
    const maxRows = 4
    const maxHeight = lineHeight * maxRows
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [])

  useEffect(() => {
    adjustTextareaHeight()
  }, [input, adjustTextareaHeight])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || isLoading) return
    onSendMessage(trimmed)
    setInput('')
  }, [input, isLoading, onSendMessage])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const hasStreaming = streamingText && streamingText.length > 0

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {(!messages || messages.length === 0) && !isLoading && (
          <div className="flex items-center justify-center h-full text-sm text-[#6B7280]">
            Start a conversation with the AI assistant.
          </div>
        )}
        {messages && messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {/* Streaming placeholder — renders as a new assistant bubble so it doesn't overwrite the last persisted message */}
        {hasStreaming && (
          <MessageBubble
            message={{ role: 'assistant', content: streamingText, timestamp: new Date().toISOString() }}
            isStreaming
            streamingText={streamingText}
          />
        )}
        {isLoading && !hasStreaming && <ThinkingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring/50 placeholder:text-muted-foreground"
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
