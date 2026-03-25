import { useState, useEffect, useRef } from 'react'
import { Loader2, Check, ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

const PREVIEW_LENGTH = 60

function formatElapsedTime(ms: number): string {
  if (ms < 1000) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (remainingSeconds === 0) return `${minutes}m`
  return `${minutes}m ${remainingSeconds}s`
}

interface ThinkingPartProps {
  text: string
  duration?: number
  isStreaming?: boolean
}

export function ThinkingPart({ text, duration, isStreaming = false }: ThinkingPartProps) {
  const [expanded, setExpanded] = useState(isStreaming)
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasStreamingRef = useRef(isStreaming)
  const startedAtRef = useRef(Date.now())
  const [elapsedMs, setElapsedMs] = useState(0)
  const [isOverflowing, setIsOverflowing] = useState(false)

  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) setExpanded(false)
    wasStreamingRef.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    if (!isStreaming) return
    const tick = () => setElapsedMs(Date.now() - startedAtRef.current)
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [isStreaming])

  useEffect(() => {
    if (isStreaming && expanded && scrollRef.current) {
      const el = scrollRef.current
      setIsOverflowing(el.scrollHeight > el.clientHeight)
      el.scrollTop = el.scrollHeight
    }
  }, [text, isStreaming, expanded])

  if (!text && !isStreaming) return null

  const previewText = text.slice(0, PREVIEW_LENGTH).replace(/\n/g, ' ')
  const elapsedDisplay = isStreaming ? formatElapsedTime(elapsedMs) : ''

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'group flex items-start gap-1.5 py-0.5 px-2 cursor-pointer w-full text-left',
          'text-muted-foreground hover:text-foreground/80 transition-colors',
        )}
      >
        {isStreaming ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] leading-4 m-0">
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
            <span className="shimmer-text font-medium">Thinking</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12px] leading-4">
            <Check className="h-3 w-3 text-primary" />
            <span className="text-muted-foreground">Thought</span>
          </span>
        )}
      </button>
      {!expanded && previewText && (
        <div className="px-2 mt-0.5">
          <span className="text-muted-foreground/60 truncate text-[12px] block">{previewText}</span>
        </div>
      )}
      {elapsedDisplay && !expanded && (
        <div className="px-2">
          <span className="text-muted-foreground/50 tabular-nums text-[11px]">
            {elapsedDisplay}
          </span>
        </div>
      )}

      {expanded && (text || isStreaming) && (
        <div className="relative px-2">
          <div
            className={cn(
              'absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background to-transparent z-10 pointer-events-none transition-opacity duration-200',
              isStreaming && isOverflowing ? 'opacity-100' : 'opacity-0',
            )}
          />
          <div
            ref={scrollRef}
            className={cn(
              'overflow-y-auto max-h-36 scrollbar-hide',
              'ml-1 pl-3 border-l border-border',
              'text-muted-foreground text-[12px] leading-relaxed whitespace-pre-wrap',
            )}
          >
            {text || (isStreaming ? '…' : '')}
          </div>
        </div>
      )}
    </div>
  )
}
