import { typographyBodySm } from '../../lib/typography'
import { activityRow, activityDetailsSummary } from './ToolLine'

interface ThinkingPartProps {
  text: string
  duration?: number
  isStreaming?: boolean
}

export function ThinkingPart({ text, isStreaming = false }: ThinkingPartProps) {
  if (!text && !isStreaming) return null

  return (
    <details className={`group ${activityRow}`} open={isStreaming}>
      <summary className={activityDetailsSummary}>
        {isStreaming ? (
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
            Thought
          </span>
        ) : (
          <span className="text-[var(--basis-text-muted)]">Thought</span>
        )}
      </summary>
      {(text || isStreaming) && (
        <div
          className={`mt-1 pl-2 ${typographyBodySm} text-[var(--basis-text-muted)] whitespace-pre-wrap`}
        >
          {text || (isStreaming ? '…' : '')}
        </div>
      )}
    </details>
  )
}
