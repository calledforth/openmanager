import { useState, type ReactNode } from 'react'
import {
  CaretRightIcon,
  DownloadSimpleIcon,
  FileMagnifyingGlassIcon,
  FilePlusIcon,
  FolderOpenIcon,
  GlobeIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PlugsConnectedIcon,
  RobotIcon,
  TerminalIcon,
  TrashIcon,
  WrenchIcon,
  type Icon,
} from '@phosphor-icons/react'
import type { ToolCallContent } from '@agentpack/contract'
import { extractDiff, type ToolViewModel } from '@agentpack/view'
import {
  presentToolPart,
  resolveTool,
  type ToolOutcome,
  type ToolPartData,
  type ToolPresenterModel,
} from '@openmanager/shared/lib/tool-presenter'
import { typographyMonoCaption } from '../../lib/typography'
import { useToolOutput } from '../../lib/tool-output'
import { cn } from '../../lib/utils'
import { activityDetailsSummary, activityRow, shimmerTextClass, shimmerTextStyle } from './ToolLine'
import { StructuredDiffBody } from './StructuredDiffBody'

export type ToolRowPart = ToolPartData & {
  type: 'tool'
  id: string
  callID?: string
  /** Where a settled call's output is read from, and how much of it there is. */
  sessionId?: string
  outputBytes?: number
  content?: ToolCallContent[]
  viewModel?: ToolViewModel
}

const ICONS: Record<string, Icon> = {
  Bash: TerminalIcon,
  Edit: NotePencilIcon,
  MultiEdit: NotePencilIcon,
  Write: FilePlusIcon,
  Delete: TrashIcon,
  Read: FileMagnifyingGlassIcon,
  Grep: MagnifyingGlassIcon,
  Search: MagnifyingGlassIcon,
  Glob: FolderOpenIcon,
  List: FolderOpenIcon,
  WebSearch: GlobeIcon,
  WebFetch: DownloadSimpleIcon,
  TodoWrite: ListChecksIcon,
  Task: RobotIcon,
}

const OUTCOME_LABELS: Record<ToolOutcome, string> = {
  failed: 'Failed',
  declined: 'Declined',
  cancelled: 'Cancelled',
}

const fillBody = cn(
  'mt-1 rounded-md bg-[var(--basis-surface)] px-2.5 py-2',
  typographyMonoCaption,
  'text-[var(--basis-text-muted)]',
)

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function iconFor(part: ToolRowPart, model: ToolPresenterModel): Icon {
  if (model.uiKind === 'mcp') return PlugsConnectedIcon
  return ICONS[resolveTool(part).canonical] ?? WrenchIcon
}

/** The one line a tool call is: what it did, to what, and how that went. */
function RowLine({
  part,
  model,
  open,
}: {
  part: ToolRowPart
  model: ToolPresenterModel
  open?: boolean
}) {
  const Glyph = iconFor(part, model)
  const quiet = model.outcome === 'declined' || model.outcome === 'cancelled'
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <Glyph
        size={13}
        aria-hidden
        className={cn(
          'relative top-[2px] shrink-0',
          model.outcome === 'failed' ? 'text-rose-500/80' : 'text-[var(--basis-text-faint)]',
        )}
      />
      <span
        className={cn('min-w-0 truncate', quiet && 'opacity-60')}
        title={model.fullDetail ?? model.detail}
      >
        {model.isRunning ? (
          <span className={shimmerTextClass} style={shimmerTextStyle}>
            {model.verb} {model.detail}
          </span>
        ) : (
          <>
            <span className="text-[var(--basis-text-muted)]">{model.verb}</span>{' '}
            <span
              className={cn(
                'text-[var(--basis-text)]',
                model.detailIsCode && typographyMonoCaption,
              )}
            >
              {model.detail}
            </span>
          </>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-baseline gap-1.5 pl-2 text-ui-sm tabular-nums">
        {model.diffAdds ? <span className="text-emerald-500/80">+{model.diffAdds}</span> : null}
        {model.diffDels ? <span className="text-rose-500/80">-{model.diffDels}</span> : null}
        {model.outcome ? (
          <span
            className={
              model.outcome === 'failed' ? 'text-rose-500/80' : 'text-[var(--basis-text-faint)]'
            }
          >
            {OUTCOME_LABELS[model.outcome]}
          </span>
        ) : null}
        {!model.outcome && model.durationMs !== undefined && model.durationMs >= 1_000 ? (
          <span className="text-[var(--basis-text-faint)]">{formatDuration(model.durationMs)}</span>
        ) : null}
        {/* Reserved on every row, so the column lines up whether a row opens or not. */}
        <CaretRightIcon
          size={10}
          aria-hidden
          className={cn(
            'relative top-px text-[var(--basis-text-faint)] opacity-0 transition-[transform,opacity] duration-150',
            open !== undefined && 'group-hover/row:opacity-100',
            open && 'rotate-90 opacity-100',
          )}
        />
      </span>
    </span>
  )
}

function Scroller({ children }: { children: ReactNode }) {
  return (
    <pre className="custom-scrollbar m-0 max-h-[300px] overflow-y-auto bg-transparent !p-0 break-words whitespace-pre-wrap">
      {children}
    </pre>
  )
}

/** What opening the row shows. Mounted only when open, so a closed row costs nothing. */
function RowDetails({ part, model }: { part: ToolRowPart; model: ToolPresenterModel }) {
  const diff = part.viewModel?.diff ?? extractDiff(part.content ?? [])
  const running = model.expandedText
  // Text the view already has (a running tool's, or the desktop's) needs no read.
  const target =
    running === undefined && part.sessionId && part.outputBytes
      ? { sessionId: part.sessionId, toolCallId: part.callID ?? part.id }
      : undefined
  const { read, retry } = useToolOutput(target)
  // The settle takes the running text out of the store. What this open row was
  // showing stays until the whole text arrives: view state, nothing more.
  const [last, setLast] = useState(running)
  if (running !== undefined && running !== last) setLast(running)
  const shown = running ?? (read.state === 'ready' ? read.text : undefined)
  const held = read.state === 'failed' ? undefined : last
  const lead =
    model.uiKind === 'terminal' && model.fullDetail && model.fullDetail !== model.detail
      ? model.fullDetail
      : undefined
  const files = model.files.length > 1 ? model.files : []

  return (
    <div className="pl-[19px]">
      {lead ? (
        <div className={fillBody}>
          <Scroller>
            <span className="text-[var(--basis-text)]">{lead}</span>
          </Scroller>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className={cn(fillBody, 'flex flex-col gap-0.5')}>
          {files.map((file) => (
            <span key={file} className="truncate" title={file}>
              {file}
            </span>
          ))}
        </div>
      ) : null}
      {diff ? (
        <div className="mt-1 max-h-[300px] overflow-y-auto custom-scrollbar">
          <StructuredDiffBody diff={diff} />
        </div>
      ) : (shown ?? held) !== undefined ? (
        <div className={cn(fillBody, model.outcome === 'failed' && 'text-rose-400/90')}>
          <Scroller>{shown ?? held}</Scroller>
        </div>
      ) : read.state === 'failed' ? (
        <div className={cn(fillBody, 'flex items-center gap-2')}>
          <span>The output could not be read.</span>
          <button
            type="button"
            onClick={retry}
            className="rounded px-1 text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)]"
          >
            Try again
          </button>
        </div>
      ) : read.state === 'loading' ? (
        <div className={fillBody}>
          <span className={shimmerTextClass} style={shimmerTextStyle}>
            Reading {part.outputBytes ? formatBytes(part.outputBytes) : 'output'}
          </span>
        </div>
      ) : null}
    </div>
  )
}

function isExpandable(part: ToolRowPart, model: ToolPresenterModel): boolean {
  if (model.expandedText || part.outputBytes) return true
  if (part.viewModel?.diff ?? extractDiff(part.content ?? [])) return true
  if (model.files.length > 1) return true
  return (
    model.uiKind === 'terminal' &&
    model.fullDetail !== undefined &&
    model.fullDetail !== model.detail
  )
}

/**
 * Every tool call's row. The line reads from what the call was given, so it
 * says what happened before any output is fetched, and the output is asked for
 * when the row is opened. Surfaces are fills, never outlines.
 */
export function ToolRow({ part }: { part: ToolRowPart }) {
  const model = presentToolPart(part)
  const [open, setOpen] = useState(false)

  if (!isExpandable(part, model)) {
    return (
      <div className={cn(activityRow, 'flex min-w-0')}>
        <RowLine part={part} model={model} />
      </div>
    )
  }

  return (
    <details
      className={cn('group/row', activityRow)}
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary
        className={cn(
          activityDetailsSummary,
          '-mx-1 rounded px-1 transition-colors duration-150 hover:bg-[var(--basis-surface-hover)]',
        )}
      >
        <RowLine part={part} model={model} open={open} />
      </summary>
      {open ? <RowDetails part={part} model={model} /> : null}
    </details>
  )
}
