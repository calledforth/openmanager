import { presentToolPart } from './toolPresenter'
import {
  activityRow,
  activityDetailsSummary,
  ToolLine,
  ToolExpandedBody,
} from './ToolLine'
import { typographyMonoCaption } from '../../lib/typography'

interface EditToolPartProps {
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

function DiffBody({ text }: { text: string }) {
  return (
    <div className={typographyMonoCaption}>
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

export function EditToolPart({ part }: EditToolPartProps) {
  const model = presentToolPart(part)
  const output = part.state?.output ?? part.state?.error ?? ''
  const hasExpand = !!output

  const line = <ToolLine verb={model.verb} detail={model.detail} isRunning={model.isRunning} />

  if (!hasExpand) {
    return <div className={activityRow}>{line}</div>
  }

  const isDiff = output.includes('\n+') || output.includes('\n-')

  return (
    <details className={`group ${activityRow}`}>
      <summary className={activityDetailsSummary}>
        <span className="min-w-0 flex-1">{line}</span>
      </summary>
      <ToolExpandedBody>
        {isDiff ? (
          <DiffBody text={output} />
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
