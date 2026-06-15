import { presentToolPart } from './toolPresenter'
import {
  activityRow,
  activityDetailsSummary,
  ToolLine,
  ToolExpandedBody,
} from './ToolLine'
import { typographyMonoCaption } from '../../lib/typography'

interface ToolPartData {
  type: 'tool'
  id: string
  tool?: string
  callID?: string
  state?: {
    type?: string
    status?: string
    input?: unknown
    output?: string
    title?: string
    error?: string
  }
}

function DiffBody({ text }: { text: string }) {
  return (
    <div className={`${typographyMonoCaption} text-[var(--basis-text-muted)]`}>
      {text.split('\n').map((line, i) => {
        const isAdd = line.startsWith('+') && !line.startsWith('+++')
        const isDel = line.startsWith('-') && !line.startsWith('---')
        return (
          <div
            key={i}
            className={
              isAdd
                ? 'text-emerald-500/90'
                : isDel
                  ? 'text-rose-500/90'
                  : 'text-[var(--basis-text-faint)]'
            }
          >
            {line}
          </div>
        )
      })}
    </div>
  )
}

export function ToolCallPart({ part }: { part: ToolPartData }) {
  const model = presentToolPart(part)
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

  if (!model.expandedText) {
    return <div className={activityRow}>{line}</div>
  }

  const isDiff = model.uiKind === 'edit' && model.expandedText.includes('\n+')

  return (
    <details className={`group ${activityRow}`}>
      <summary className={activityDetailsSummary}>
        <span className="min-w-0 flex-1">{line}</span>
      </summary>
      <ToolExpandedBody>
        {isDiff ? (
          <DiffBody text={model.expandedText} />
        ) : (
          <pre
            className={`m-0 whitespace-pre-wrap break-words ${typographyMonoCaption} text-[var(--basis-text-muted)]`}
          >
            {model.expandedText}
          </pre>
        )}
      </ToolExpandedBody>
    </details>
  )
}
