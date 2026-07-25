import { useEffect, useRef, useState } from 'react'
import { typographyBodySm } from '../../lib/typography'
import { activityRow, activityDetailsSummary, shimmerTextClass, shimmerTextStyle } from './ToolLine'

interface ThinkingPartProps {
  text: string
  duration?: number
  isStreaming?: boolean
}

/** Sub-second thoughts read as noise, so the duration only joins the label above 1s. */
function thoughtLabel(durationMs?: number): string {
  if (!durationMs || durationMs < 1000) return 'Thought'
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 60) return `Thought for ${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds ? `Thought for ${minutes}m ${seconds}s` : `Thought for ${minutes}m`
}

export function ThinkingPart({ text, duration, isStreaming = false }: ThinkingPartProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)

  // Long reasoning runs are capped to a scroll area, so follow the tail while
  // it streams instead of leaving the reader parked at the opening lines.
  useEffect(() => {
    if (!isStreaming) return
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [text, isStreaming])

  if (!text && !isStreaming) return null

  return (
    <details className={`group ${activityRow}`} open={isStreaming}>
      <summary className={activityDetailsSummary}>
        {isStreaming ? (
          <span className={shimmerTextClass} style={shimmerTextStyle}>
            Thinking
          </span>
        ) : (
          <span className="text-[var(--basis-text-muted)]">{thoughtLabel(duration)}</span>
        )}
      </summary>
      {(text || isStreaming) && (
        <div className="relative mt-1">
          {scrolled && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[var(--basis-canvas-bg)] to-transparent"
            />
          )}
          <div
            ref={bodyRef}
            onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
            className={`thin-scrollbar max-h-[200px] overflow-y-auto ${typographyBodySm} whitespace-pre-wrap text-[var(--basis-text-muted)]`}
          >
            {text || (isStreaming ? '…' : '')}
          </div>
        </div>
      )}
    </details>
  )
}
