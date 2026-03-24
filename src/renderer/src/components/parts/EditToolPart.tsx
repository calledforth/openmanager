import { useState, useMemo } from 'react'
import { FileEdit, FilePlus, ChevronRight, Check, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { canonicalizeToolName } from './ToolRegistry'

interface EditToolPartProps {
  part: {
    tool?: string
    state?: {
      type?: string
      status?: string
      input?: unknown
      output?: string
      error?: string
      time?: { start?: number; end?: number }
    }
  }
}

interface DiffLine {
  type: 'added' | 'removed' | 'context'
  content: string
}

function parseDiffFromOutput(output: string): DiffLine[] {
  if (!output) return []
  const lines = output.split('\n')
  return lines.map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return { type: 'added' as const, content: line.slice(1) }
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return { type: 'removed' as const, content: line.slice(1) }
    }
    return { type: 'context' as const, content: line.startsWith(' ') ? line.slice(1) : line }
  })
}

function countDiffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'added') added++
    if (l.type === 'removed') removed++
  }
  return { added, removed }
}

function extractFilePath(input: unknown): string {
  if (!input || typeof input !== 'object') return 'file'
  const obj = input as Record<string, unknown>
  return (obj.path ?? obj.file_path ?? obj.filePath ?? obj.file ?? 'file') as string
}

function shortenPath(path: string): { filename: string; dir: string } {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  const filename = parts.pop() ?? path
  const dir = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : parts.join('/')
  return { filename, dir }
}

export function EditToolPart({ part }: EditToolPartProps) {
  const [expanded, setExpanded] = useState(false)
  const state = part.state ?? {}
  const toolName = canonicalizeToolName(part.tool ?? '')
  const stateType = (state.type ?? state.status ?? 'pending') as string
  const isPending = stateType === 'pending' || stateType === 'running'
  const isInputStreaming = stateType === 'input-streaming'
  const isError = stateType === 'error'
  const isWrite = toolName === 'Write'

  const filePath = extractFilePath(state.input)
  const { filename, dir } = shortenPath(filePath)
  const Icon = isWrite ? FilePlus : FileEdit
  const actionLabel = isWrite ? 'Creating' : 'Editing'
  const doneLabel = isWrite ? 'Created file' : 'Edited file'

  const diffLines = useMemo(() => parseDiffFromOutput(state.output ?? ''), [state.output])
  const stats = useMemo(() => countDiffStats(diffLines), [diffLines])
  const hasDiff = diffLines.length > 0

  const duration =
    state.time?.start && state.time?.end
      ? `${((state.time.end - state.time.start) / 1000).toFixed(1)}s`
      : null

  if (isPending || isInputStreaming) {
    return (
      <div className="border border-border rounded-lg overflow-hidden my-1 bg-card">
        <div className="flex items-center gap-1.5 px-2.5 h-7">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground/60" />
          <span className="text-[12px] shimmer-text">
            {actionLabel}
          </span>
          <span className="text-[12px] text-muted-foreground/50 truncate">{filename}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden my-1 bg-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 pl-2.5 pr-1 h-7 bg-transparent border-none cursor-pointer text-left transition-default hover:bg-surface-hover"
      >
        <Icon className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
        <span className="text-[12px] text-muted-foreground whitespace-nowrap">{doneLabel}</span>
        <span className="text-[12px] text-foreground/70 font-medium truncate">{filename}</span>
        {dir && (
          <span className="text-[11px] text-muted-foreground/40 truncate min-w-0">{dir}</span>
        )}
        <div className="flex-1" />
        {stats.added > 0 && (
          <span className="text-[11px] text-primary tabular-nums flex-shrink-0">+{stats.added}</span>
        )}
        {stats.removed > 0 && (
          <span className="text-[11px] text-destructive tabular-nums flex-shrink-0 ml-1">-{stats.removed}</span>
        )}
        {!isError && <Check className="size-3 text-primary flex-shrink-0 ml-1" />}
        {isError && <AlertCircle className="size-3 text-destructive flex-shrink-0 ml-1" />}
        {duration && (
          <span className="text-[11px] text-muted-foreground/50 tabular-nums flex-shrink-0 ml-1">{duration}</span>
        )}
        <ChevronRight
          className={cn(
            'size-3 text-muted-foreground/40 flex-shrink-0 transition-transform duration-200',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-border max-h-[300px] overflow-y-auto scrollbar-hide">
          {hasDiff ? (
            <div className="font-mono text-[11px] leading-5">
              {diffLines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex px-3 py-0 whitespace-pre-wrap break-all',
                    line.type === 'added' && 'bg-primary/8 text-primary',
                    line.type === 'removed' && 'bg-destructive/8 text-destructive',
                    line.type === 'context' && 'text-foreground/40'
                  )}
                >
                  <span className="w-4 shrink-0 select-none text-muted-foreground/30">
                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                  </span>
                  <span className="whitespace-pre">{line.content}</span>
                </div>
              ))}
            </div>
          ) : state.output ? (
            <pre className="m-0 px-2.5 py-1.5 text-[12px] text-muted-foreground font-mono whitespace-pre-wrap break-words">
              {state.output}
            </pre>
          ) : null}
          {state.error && (
            <div className="px-2.5 py-1.5 text-[12px] text-destructive bg-destructive/5">
              {state.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
