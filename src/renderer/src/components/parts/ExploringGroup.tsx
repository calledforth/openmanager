import { useState, useEffect, useRef } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { ToolCallPart } from './ToolCallPart'
import { cn } from '../../lib/utils'

interface Part {
  type: string
  id: string
  tool?: string
  state?: {
    type?: string
    status?: string
    input?: unknown
    output?: string
    title?: string
    time?: { start?: number; end?: number }
  }
  [key: string]: unknown
}

interface ExploringGroupProps {
  parts: Part[]
  isStreaming?: boolean
}

function buildSubtitle(parts: Part[]): string {
  let files = 0
  let searches = 0
  for (const p of parts) {
    const tool = p.tool ?? ''
    if (tool === 'Read') files++
    else if (tool === 'Grep' || tool === 'Glob' || tool === 'WebSearch' || tool === 'WebFetch') searches++
    else files++
  }
  const segments: string[] = []
  if (files > 0) segments.push(`${files} file${files > 1 ? 's' : ''}`)
  if (searches > 0) segments.push(`${searches} search${searches > 1 ? 'es' : ''}`)
  return segments.join(', ')
}

export function ExploringGroup({ parts, isStreaming = false }: ExploringGroupProps) {
  const [expanded, setExpanded] = useState(isStreaming)
  const wasStreamingRef = useRef(isStreaming)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) setExpanded(false)
    wasStreamingRef.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    if (isStreaming && expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [parts.length, isStreaming, expanded])

  const allDone = parts.every((p) => {
    const st = p.state?.type ?? p.state?.status ?? 'pending'
    return st === 'completed' || st === 'error'
  })

  const subtitle = buildSubtitle(parts)
  const maxVisible = 5
  const itemHeight = 24

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="group flex items-start gap-1.5 py-0.5 px-2 cursor-pointer w-full text-left text-muted-foreground hover:text-foreground/80 transition-colors bg-transparent border-none"
      >
        <ChevronRight
          className={cn(
            'size-3.5 flex-shrink-0 mt-px transition-transform duration-200',
            expanded && 'rotate-90'
          )}
        />
        <Search className="size-3.5 flex-shrink-0 mt-px text-muted-foreground/60" />
        <span className="text-[12px]">
          {isStreaming && !allDone ? (
            <span className="shimmer-text font-medium">Exploring</span>
          ) : (
            'Explored'
          )}
        </span>
        <span className="text-11-regular min-w-0 truncate text-muted-foreground/50">
          {subtitle}
        </span>
      </button>

      {expanded && (
        <div
          ref={scrollRef}
          className="ml-5 overflow-y-auto scrollbar-hide"
          style={{ maxHeight: maxVisible * itemHeight }}
        >
          {parts.map((p) => (
            <ToolCallPart key={p.id} part={p as Parameters<typeof ToolCallPart>[0]['part']} />
          ))}
        </div>
      )}
    </div>
  )
}
