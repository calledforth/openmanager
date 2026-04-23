import { useState, useEffect, useRef } from 'react'
import { ChevronRight } from 'lucide-react'
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

  const elapsedDisplay = isStreaming ? formatElapsedTime(elapsedMs) : ''

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'group flex items-start gap-2 py-0.5 px-0 cursor-pointer w-full text-left',
          'text-muted-foreground hover:text-foreground/80 transition-colors',
        )}
      >
        {isStreaming ? (
          <span className="text-13-regular m-0 flex items-start gap-2">
            <span className="mt-[4px] flex h-4 w-4 shrink-0 items-center justify-center">
              <span className="custom-loader text-primary" />
            </span>
            <span className="shimmer-text font-medium">Thinking</span>
          </span>
        ) : (
          <span className="text-13-regular flex items-start gap-2">
            <span className="mt-[4px] flex h-4 w-4 shrink-0 items-center justify-center">
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                  expanded && 'rotate-90',
                )}
              />
            </span>
            <span className="text-muted-foreground">Thought</span>
          </span>
        )}
      </button>
      {elapsedDisplay && !expanded && (
        <div className="px-0 mt-0.5 ml-6">
          <span className="text-muted-foreground/50 tabular-nums text-[12px]">
            {elapsedDisplay}
          </span>
        </div>
      )}

      {expanded && (text || isStreaming) && (
        <div className="relative px-0 mt-1">
          <div
            className={cn(
              'absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background to-transparent z-10 pointer-events-none transition-opacity duration-200',
              isStreaming && isOverflowing ? 'opacity-100' : 'opacity-0',
            )}
          />
          <div
            ref={scrollRef}
            className={cn(
              'overflow-y-auto max-h-[400px] scrollbar-hide',
              'ml-6 pl-3 border-l border-border',
              'chat-assistant text-muted-foreground whitespace-pre-wrap',
            )}
          >
            {text || (isStreaming ? '…' : '')}
          </div>
        </div>
      )}
    </div>
  )
}
