import { useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Copy, FileText, RefreshCw, Check } from 'lucide-react'

const FORMAT_OPTIONS = [
  { key: 'escalation', label: 'Escalation' },
  { key: 'internal', label: 'Internal' },
  { key: 'customer', label: 'Customer' },
]

export default function SupportNote({ note, onRegenerate }) {
  const [activeFormat, setActiveFormat] = useState(note?.format || 'escalation')
  const [copyFeedback, setCopyFeedback] = useState(null)

  const showCopyFeedback = useCallback((type) => {
    setCopyFeedback(type)
    setTimeout(() => setCopyFeedback(null), 2000)
  }, [])

  const handleCopyPlain = useCallback(async () => {
    if (!note?.content) return
    try {
      await navigator.clipboard.writeText(note.content)
      showCopyFeedback('plain')
    } catch {
      // Clipboard API failed silently
    }
  }, [note, showCopyFeedback])

  const handleCopyMarkdown = useCallback(async () => {
    if (!note?.content) return
    try {
      await navigator.clipboard.writeText(note.content)
      showCopyFeedback('markdown')
    } catch {
      // Clipboard API failed silently
    }
  }, [note, showCopyFeedback])

  const handleRegenerate = useCallback(() => {
    if (onRegenerate) onRegenerate(activeFormat)
  }, [onRegenerate, activeFormat])

  const handleFormatChange = useCallback((format) => {
    setActiveFormat(format)
    if (onRegenerate) onRegenerate(format)
  }, [onRegenerate])

  if (!note) return null

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{note.formatName || 'Support Note'}</CardTitle>
            {note.generatedAt && (
              <p className="text-xs text-[#6B7280] mt-0.5">
                Generated {new Date(note.generatedAt).toLocaleString()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1">
            {FORMAT_OPTIONS.map((fmt) => (
              <Button
                key={fmt.key}
                size="sm"
                variant={activeFormat === fmt.key ? 'default' : 'outline'}
                onClick={() => handleFormatChange(fmt.key)}
              >
                {fmt.label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="rounded-lg border border-border bg-gray-50 p-4 min-h-[120px] max-h-[500px] overflow-y-auto">
          <div className="whitespace-pre-wrap text-sm leading-relaxed font-sans">
            {note.content || 'No content generated yet.'}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-4">
          <Button size="sm" variant="outline" onClick={handleCopyPlain}>
            {copyFeedback === 'plain' ? (
              <>
                <Check className="size-3.5 mr-1 text-green-600" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="size-3.5 mr-1" />
                Copy to Clipboard
              </>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={handleCopyMarkdown}>
            {copyFeedback === 'markdown' ? (
              <>
                <Check className="size-3.5 mr-1 text-green-600" />
                Copied!
              </>
            ) : (
              <>
                <FileText className="size-3.5 mr-1" />
                Copy as Markdown
              </>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={handleRegenerate}>
            <RefreshCw className="size-3.5 mr-1" />
            Regenerate
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
