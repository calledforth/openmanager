import { presentToolPart } from './toolPresenter'
import { activityRow, activityDetailsSummary, ToolLine, ToolExpandedBody } from './ToolLine'
import { typographyMonoCaption } from '../../lib/typography'
import type { ToolCallContent } from '@agentpack/contract'
import { extractDiff } from '@agentpack/view'
import { StructuredDiffBody } from './StructuredDiffBody'

interface EditToolPartProps {
  part: {
    tool?: string
    state?: {
      type?: string
      status?: string
      input?: unknown
      output?: unknown
      error?: string
    }
    content?: ToolCallContent[]
  }
}

export function EditToolPart({ part }: EditToolPartProps) {
  const model = presentToolPart(part)
  const output = model.expandedText ?? ''
  const diff = extractDiff(part.content ?? [])
  const hasExpand = !!output || !!diff

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
        {diff ? (
          <StructuredDiffBody diff={diff} />
        ) : (
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
