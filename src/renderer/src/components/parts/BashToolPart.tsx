import { useState } from 'react'
import { Terminal, ChevronRight, Check, AlertCircle, Loader2 } from 'lucide-react'
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
  const isSuccess = stateType === 'completed' && (exitCode === null || exitCode === 0) && !error
  const isError = stateType === 'error' || (exitCode !== null && exitCode !== 0) || !!error

  const duration =
    state.time?.start && state.time?.end
      ? `${((state.time.end - state.time.start) / 1000).toFixed(1)}s`
      : null

  const displayCommand = command.length > 120 ? command.slice(0, 117) + '...' : command
  const hasOutput = !!output || !!error

  if (isPending || isInputStreaming) {
    return (
      <div className="border border-border rounded-lg overflow-hidden my-1 bg-card">
        <div className="flex items-center gap-2 px-2.5 h-7">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground/60" />
          <span className="text-[12px] shimmer-text">
            {isInputStreaming ? 'Generating command' : 'Running command'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden my-1 bg-card">
      <button
        type="button"
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={cn(
          'w-full flex items-center gap-1.5 pl-2.5 pr-1 h-7 bg-transparent border-none text-left transition-default',
          hasOutput ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-default'
        )}
      >
        <Terminal className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
        <span className="text-[12px] text-muted-foreground flex-1 min-w-0 truncate">
          Ran command
        </span>
        {isSuccess && <Check className="size-3 text-primary flex-shrink-0" />}
        {isError && <AlertCircle className="size-3 text-destructive flex-shrink-0" />}
        {duration && (
          <span className="text-[11px] text-muted-foreground/50 tabular-nums flex-shrink-0">{duration}</span>
        )}
        {hasOutput && (
          <ChevronRight
            className={cn(
              'size-3 text-muted-foreground/40 flex-shrink-0 transition-transform duration-200',
              expanded && 'rotate-90'
            )}
          />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border px-2.5 py-1.5 max-h-[300px] overflow-y-auto scrollbar-hide">
          {command && (
            <div className="flex items-start gap-1.5 mb-1">
              <span className="text-primary font-mono text-[12px] flex-shrink-0">$</span>
              <code className="font-mono text-[12px] text-foreground/80 whitespace-pre-wrap break-all">
                {displayCommand}
              </code>
            </div>
          )}
          {output && (
            <pre className="m-0 text-[12px] text-muted-foreground font-mono whitespace-pre-wrap break-words leading-relaxed">
              {output}
            </pre>
          )}
          {error && (
            <pre className="m-0 text-[12px] text-destructive font-mono whitespace-pre-wrap break-words leading-relaxed">
              {error}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
