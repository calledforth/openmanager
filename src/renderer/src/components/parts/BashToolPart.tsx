import { useState } from 'react'
import { Terminal, ChevronRight, AlertCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

interface BashToolPartProps {
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

function parseExitCode(output: string | undefined): number | null {
  if (!output) return null
  const match = output.match(/exit code[:\s]*(\d+)/i)
  return match ? parseInt(match[1], 10) : null
}

export function BashToolPart({ part }: BashToolPartProps) {
  const [expanded, setExpanded] = useState(false)
  const state = part.state ?? {}
  const stateType = (state.type ?? state.status ?? 'pending') as string
  const isPending = stateType === 'pending' || stateType === 'running'
  const isInputStreaming = stateType === 'input-streaming'

  const input = state.input as Record<string, unknown> | undefined
  const command = (input?.command as string) ?? ''
  const output = state.output ?? ''
  const error = state.error ?? ''
  const exitCode = parseExitCode(output)
  const isError = stateType === 'error' || (exitCode !== null && exitCode !== 0) || !!error

  const duration =
    state.time?.start && state.time?.end
      ? `${((state.time.end - state.time.start) / 1000).toFixed(1)}s`
      : null

  const displayCommand = command.length > 120 ? command.slice(0, 117) + '...' : command
  const hasOutput = !!output || !!error

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
          <Terminal className="h-4 w-4" />
        </span>
        <div className="text-14-regular leading-readable flex flex-1 min-w-0 items-center gap-2">
          <span
            className={cn(
              'truncate',
              isPending || isInputStreaming ? 'shimmer-text font-medium' : 'text-foreground',
            )}
          >
            {isInputStreaming
              ? 'Generating command'
              : isPending
                ? 'Running command'
                : 'Ran command'}
          </span>
          {displayCommand && !isPending && !isInputStreaming && (
            <span className="truncate text-muted-foreground/70 text-[13px] font-mono">
              {displayCommand}
            </span>
          )}
          {(isPending || isInputStreaming) && (
            <span className="custom-loader text-primary shrink-0" />
          )}
          {isError && !isPending && !isInputStreaming && (
            <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />
          )}
          {duration && !isPending && (
            <span className="text-[12px] text-muted-foreground/50 tabular-nums flex-shrink-0 ml-auto">
              {duration}
            </span>
          )}
          {hasOutput && !isPending && (
            <ChevronRight
              className={cn(
                'h-4 w-4 text-muted-foreground/40 flex-shrink-0 transition-transform duration-200',
                expanded && 'rotate-90',
              )}
            />
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-1 mb-2 ml-6 pl-3 border-l border-border max-h-[300px] overflow-y-auto scrollbar-hide">
          {command && (
            <div className="flex items-start gap-1.5 mb-1.5">
              <span className="text-primary font-mono text-[13px] flex-shrink-0">$</span>
              <code className="font-mono text-[13px] text-foreground/80 whitespace-pre-wrap break-all">
                {command}
              </code>
            </div>
          )}
          {output && (
            <pre className="m-0 font-mono text-[12px] leading-readable whitespace-pre-wrap break-words text-muted-foreground">
              {output}
            </pre>
          )}
          {error && (
            <pre className="m-0 mt-1 font-mono text-[12px] leading-readable whitespace-pre-wrap break-words text-destructive">
              {error}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
