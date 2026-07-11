import { presentToolPart } from './toolPresenter'
import { activityRow, activityDetailsSummary, ToolLine, ToolExpandedBody } from './ToolLine'
import { typographyMonoCaption } from '../../lib/typography'
import type { ToolCallContent } from '@agentpack/contract'
import { extractDiff, type ToolViewModel } from '@agentpack/view'
import { StructuredDiffBody } from './StructuredDiffBody'

interface ToolPartData {
  type: 'tool'
  id: string
  tool?: string
  callID?: string
  state?: {
    type?: string
    status?: string
    input?: unknown
    output?: unknown
    title?: string
    error?: string
  }
  content?: ToolCallContent[]
  viewModel?: ToolViewModel
}

export function ToolCallPart({ part }: { part: ToolPartData }) {
  const model = presentToolPart(part)
  const diff = part.viewModel?.diff ?? extractDiff(part.content ?? [])
  const line = (
    <ToolLine
      verb={model.verb}
      detail={model.detail}
      isRunning={model.isRunning}
      detailSlot={
        model.uiKind === 'read' && model.readTarget ? (
          <span className="font-mono text-[var(--basis-text)]">{model.readTarget}</span>
        ) : undefined
      }
    />
  )

  if (!model.expandedText && !diff) {
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
            {model.expandedText ?? ''}
          </pre>
        )}
      </ToolExpandedBody>
    </details>
  )
}
