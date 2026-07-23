import { useState } from 'react'
import { activityRow, activityDetailsSummary, ToolLine, ToolExpandedBody } from './ToolLine'
import { typographyMonoCaption } from '../../lib/typography'
import { useAppUi } from '../../providers/app-ui-provider'

export interface SubtaskPartData {
  type: 'subtask'
  id: string
  title?: string
  description?: string
  prompt?: string
  status?: string
  statusSource?: string
  statusReason?: string
  targetSessionId?: string
  modelId?: string
  subagentType?: string
  durationMs?: number
  resultText?: string
  currentActivity?: string
  toolCallCount?: number
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded border border-[var(--basis-border-muted)] px-1 py-px text-ui-2xs leading-none text-[var(--basis-text-faint)]">
      {children}
    </span>
  )
}

export function subtaskVerb(status: string | undefined): string {
  if (status === 'pending' || status === 'running') return 'Running subagent'
  if (status === 'failed') return 'Subagent failed'
  if (status === 'cancelled') return 'Subagent cancelled'
  if (status === 'interrupted') return 'Subagent interrupted'
  if (status === 'unknown') return 'Subagent status unknown'
  return 'Ran subagent'
}

/** Delegated child-agent task: status line + metadata chips, expandable
 * prompt/result, and — when the provider exposes the child as a loadable
 * session — navigation to its read-only transcript. */
export function SubtaskCard({ part }: { part: SubtaskPartData }) {
  const { activeSessionId, openChildSession } = useAppUi()
  const [openError, setOpenError] = useState<string | null>(null)
  const isRunning = part.status === 'running' || part.status === 'pending'
  const verb = subtaskVerb(part.status)
  const detail = part.description ?? part.title ?? part.subagentType
  const canOpen = Boolean(part.targetSessionId && activeSessionId)

  const chips = (
    <span className="ml-1.5 inline-flex items-center gap-1 align-middle">
      {part.subagentType ? <Chip>{part.subagentType}</Chip> : null}
      {part.modelId ? <Chip>{part.modelId}</Chip> : null}
      {!isRunning && part.durationMs !== undefined ? (
        <Chip>{formatDuration(part.durationMs)}</Chip>
      ) : null}
      {part.toolCallCount !== undefined ? <Chip>{`${part.toolCallCount} tools`}</Chip> : null}
    </span>
  )

  const line = (
    <span className="min-w-0">
      <ToolLine verb={verb} detail={detail} isRunning={isRunning} />
      {chips}
    </span>
  )

  const activity =
    isRunning && part.currentActivity ? (
      <div className="pl-4 text-ui-xs text-[var(--basis-text-faint)]">{part.currentActivity}</div>
    ) : null

  const openButton = canOpen ? (
    <button
      type="button"
      className="mt-1 rounded border border-[var(--basis-border-muted)] px-1.5 py-0.5 text-ui-2xs text-[var(--basis-text-muted)] hover:text-[var(--basis-text)]"
      onClick={(event) => {
        event.preventDefault()
        if (part.targetSessionId && activeSessionId) {
          setOpenError(null)
          void openChildSession(part.targetSessionId, activeSessionId).catch((error) => {
            setOpenError(error instanceof Error ? error.message : 'Unable to open transcript')
          })
        }
      }}
    >
      View transcript
    </button>
  ) : null

  if (!part.prompt && !part.resultText && !openButton) {
    return (
      <div className={activityRow}>
        {line}
        {activity}
      </div>
    )
  }

  return (
    <details className={`group ${activityRow}`}>
      <summary className={activityDetailsSummary}>
        <span className="min-w-0 flex-1">{line}</span>
      </summary>
      {activity}
      <ToolExpandedBody>
        {part.prompt ? (
          <pre
            className={`m-0 whitespace-pre-wrap break-words ${typographyMonoCaption} text-[var(--basis-text-faint)]`}
          >
            {part.prompt}
          </pre>
        ) : null}
        {part.resultText ? (
          <pre
            className={`m-0 mt-1 whitespace-pre-wrap break-words ${typographyMonoCaption} text-[var(--basis-text-muted)]`}
          >
            {part.resultText}
          </pre>
        ) : null}
        {openButton}
        {openError ? (
          <p className="m-0 mt-1 text-ui-2xs text-red-400" role="alert">
            {openError}
          </p>
        ) : null}
      </ToolExpandedBody>
    </details>
  )
}
