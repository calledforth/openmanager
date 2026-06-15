import { useState, useEffect, useRef } from 'react'
import { ToolCallPart } from './ToolCallPart'
import { activityRowBare, activityDetailsSummary } from './ToolLine'

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
    else if (tool === 'Grep' || tool === 'Glob' || tool === 'WebSearch' || tool === 'WebFetch')
      searches++
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
  const isRunning = isStreaming && !allDone

  return (
    <details
      className={`group ${activityRowBare}`}
      open={expanded}
      onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
    >
      <summary className={`${activityDetailsSummary} px-2`}>
        {isRunning ? (
          <span
            className="inline basis-tool-shimmer"
            style={{
              background:
                'linear-gradient(90deg, color-mix(in srgb, var(--basis-text-faint) 65%, transparent) 25%, color-mix(in srgb, var(--basis-text-muted) 92%, transparent) 50%, color-mix(in srgb, var(--basis-text-faint) 65%, transparent) 75%)',
              backgroundSize: '200% 100%',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              animation: 'shimmer 1.6s infinite linear',
            }}
          >
            Explored {subtitle}
          </span>
        ) : (
          <>
            <span className="text-[var(--basis-text-muted)]">Explored</span>{' '}
            <span className="text-[var(--basis-text-faint)]">{subtitle}</span>
          </>
        )}
      </summary>
      <div ref={scrollRef} className="thin-scrollbar max-h-[120px] overflow-y-auto">
        {parts.map((p) => (
          <ToolCallPart key={p.id} part={p as Parameters<typeof ToolCallPart>[0]['part']} />
        ))}
      </div>
    </details>
  )
}
