import { useState, useMemo } from 'react'
import { FileEdit, FilePlus, ChevronRight, AlertCircle } from 'lucide-react'
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
  const hasOutput = hasDiff || !!state.output || !!state.error

  const duration =
    state.time?.start && state.time?.end
      ? `${((state.time.end - state.time.start) / 1000).toFixed(1)}s`
      : null

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={cn(
          'w-full flex items-start gap-2 py-0.5 px-0 bg-transparent border-none text-left transition-default',
          hasOutput ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
        )}
      >
        <span className="mt-[4px] flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/60">
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-2 text-[14px] leading-relaxed">
          <span
            className={cn(
              'whitespace-nowrap',
              isPending || isInputStreaming ? 'shimmer-text font-medium' : 'text-foreground',
            )}
          >
            {isPending || isInputStreaming ? actionLabel : doneLabel}
          </span>
          <span className="text-muted-foreground truncate">{filename}</span>

          {(isPending || isInputStreaming) && (
            <span className="custom-loader text-primary shrink-0 ml-1" />
          )}

          {dir && !isPending && !isInputStreaming && (
            <span className="text-[12px] text-muted-foreground/40 truncate min-w-0">{dir}</span>
          )}

          {!isPending && !isInputStreaming && (
            <>
              {stats.added > 0 && (
                <span className="text-[12px] text-primary tabular-nums flex-shrink-0 ml-auto">
                  +{stats.added}
                </span>
              )}
              {stats.removed > 0 && (
                <span className="text-[12px] text-destructive tabular-nums flex-shrink-0 ml-1">
                  -{stats.removed}
                </span>
              )}
              {isError && <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 ml-1" />}
              {duration && (
                <span className="text-[12px] text-muted-foreground/50 tabular-nums flex-shrink-0 ml-2">
                  {duration}
                </span>
              )}
              {hasOutput && (
                <ChevronRight
                  className={cn(
                    'h-4 w-4 text-muted-foreground/40 flex-shrink-0 ml-1 transition-transform duration-200',
                    expanded && 'rotate-90',
                  )}
                />
              )}
            </>
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-1 mb-2 ml-6 pl-3 border-l border-border max-h-[300px] overflow-y-auto scrollbar-hide">
          {hasDiff ? (
            <div className="font-mono text-[12px] leading-relaxed">
              {diffLines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex px-2 py-0 whitespace-pre-wrap break-all',
                    line.type === 'added' && 'bg-primary/8 text-primary',
                    line.type === 'removed' && 'bg-destructive/8 text-destructive',
                    line.type === 'context' && 'text-foreground/40',
                  )}
                >
                  <span className="w-5 shrink-0 select-none text-muted-foreground/30">
                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                  </span>
                  <span className="whitespace-pre">{line.content}</span>
                </div>
              ))}
            </div>
          ) : state.output ? (
            <pre className="m-0 text-[12px] text-muted-foreground font-mono whitespace-pre-wrap break-words leading-relaxed">
              {state.output}
            </pre>
          ) : null}
          {state.error && (
            <div className="mt-1 text-[12px] text-destructive bg-destructive/5 px-2 py-1 rounded">
              {state.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
