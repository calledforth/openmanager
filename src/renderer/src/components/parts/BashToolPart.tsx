import { presentToolPart } from './toolPresenter'
import {
  activityRow,
  activityDetailsSummary,
  ToolLine,
  ToolExpandedBody,
} from './ToolLine'
import { typographyMonoCaption } from '../../lib/typography'

interface BashToolPartProps {
  part: {
    tool?: string
    state?: {
      type?: string
      status?: string
      input?: unknown
      output?: string
      error?: string
    }
  }
}

export function BashToolPart({ part }: BashToolPartProps) {
  const model = presentToolPart(part)
  const input = part.state?.input as Record<string, unknown> | undefined
  const command = String(input?.command ?? '')
  const output = part.state?.output ?? part.state?.error ?? ''
  const hasExpand = !!(output || command)

  const line = <ToolLine verb={model.verb} detail={model.detail} isRunning={model.isRunning} />

  if (!hasExpand) {
    return <div className={activityRow}>{line}</div>
  }

  return (
    <details className={`group ${activityRow}`}>
      <summary className={activityDetailsSummary}>
        <span className="min-w-0 flex-1">{line}</span>
      </summary>
      <ToolExpandedBody>
        {command && (
          <div className="mb-1.5 flex items-start gap-1.5">
            <span className={`shrink-0 ${typographyMonoCaption} text-[var(--basis-text-muted)]`}>
              $
            </span>
            <code
              className={`break-all whitespace-pre-wrap ${typographyMonoCaption} text-[var(--basis-text)]`}
            >
              {command}
            </code>
          </div>
        )}
        {output && (
          <pre
            className={`m-0 whitespace-pre-wrap break-words ${typographyMonoCaption} text-[var(--basis-text-muted)]`}
          >
            {output}
          </pre>
        )}
      </ToolExpandedBody>
    </details>
  )
}
