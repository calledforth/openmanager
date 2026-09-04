import { presentToolPart } from './toolPresenter'
import { activityRow, activityDetailsSummary } from './ToolLine'
import { CommandPill } from './CommandPill'
import { TerminalPanel } from './TerminalPanel'

interface BashToolPartProps {
  part: {
    tool?: string
    state?: {
      type?: string
      status?: string
      input?: unknown
      output?: unknown
      error?: string
    }
  }
}

export function BashToolPart({ part }: BashToolPartProps) {
  const model = presentToolPart(part)
  const input = part.state?.input as Record<string, unknown> | undefined
  const command = String(input?.command ?? '')
  const output = model.expandedText ?? ''
  const pillCommand = command || model.detail || model.verb

  if (!command && !output) {
    return (
      <div className={activityRow}>
        <CommandPill command={pillCommand} isRunning={model.isRunning} isError={model.isError} />
      </div>
    )
  }

  return (
    <details className={`group ${activityRow}`}>
      <summary className={activityDetailsSummary}>
        <CommandPill
          command={pillCommand}
          isRunning={model.isRunning}
          isError={model.isError}
          isInteractive
        />
      </summary>
      <div className="mt-1">
        <TerminalPanel command={command} output={output} isError={model.isError} />
      </div>
    </details>
  )
}
