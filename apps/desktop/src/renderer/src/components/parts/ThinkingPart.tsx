import { useEffect, useRef, useState } from 'react'
import { typographyBodySm } from '../../lib/typography'
import { activityRow, activityDetailsSummary, shimmerTextClass, shimmerTextStyle } from './ToolLine'

interface ThinkingPartProps {
  text?: string
  duration?: number
  /** Provider's running estimate of thinking tokens. The only progress signal
   * for providers whose thinking blocks carry no text at all. */
  tokens?: number
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

/** The count is an estimate the provider revises upward, so it is rendered
 * approximate and abbreviated rather than as a precise figure. Zero is a real
 * reading but says nothing a reader can use, so it is left off the label — the
 * row itself still renders, which is the part that matters. */
function tokenLabel(tokens?: number): string | undefined {
  if (tokens === undefined || tokens <= 0) return undefined
  const rounded = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
  return `~${rounded} tokens`
}

export function ThinkingPart({ text, duration, tokens, isStreaming = false }: ThinkingPartProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const body = text ?? ''

  // Long reasoning runs are capped to a scroll area, so follow the tail while
  // it streams instead of leaving the reader parked at the opening lines.
  useEffect(() => {
    if (!isStreaming) return
    const element = bodyRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [body, isStreaming])

  // A part with a token count but no text is still a real thought worth
  // showing; only a part with nothing at all is dropped. Branching on the shape
  // of the part rather than on the provider is deliberate: any provider may
  // stream either shape, and one already streams both within a turn.
  if (!body && tokens === undefined && !isStreaming) return null

  const detail = tokenLabel(tokens)
  const label = isStreaming ? 'Thinking' : thoughtLabel(duration)
  const summary = (
    <>
      {isStreaming ? (
        <span className={shimmerTextClass} style={shimmerTextStyle}>
          {label}
        </span>
      ) : (
        <span className="text-[var(--basis-text-muted)]">{label}</span>
      )}
      {detail ? (
        <span className="text-[var(--basis-text-faint)]">
          {' · '}
          {detail}
        </span>
      ) : null}
    </>
  )

  // Indicator-only: there is no transcript to disclose, so this renders as a
  // plain row rather than a <details> whose toggle would reveal nothing. This
  // is the whole live experience for a provider that reports thinking as
  // timing plus a token estimate — `Thinking · ~1.2k tokens` while the block
  // runs, `Thought for 3s · ~1.5k tokens` once it stops.
  if (!body) {
    return <div className={activityRow}>{summary}</div>
  }

  return (
    <details className={`group ${activityRow}`} open={isStreaming}>
      <summary className={activityDetailsSummary}>{summary}</summary>
      {body && (
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
            {body}
          </div>
        </div>
      )}
    </details>
  )
}
