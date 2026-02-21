import { useState } from 'react'
import { TextShimmer } from '../ui/text-shimmer'
import { cn } from '../../lib/utils'

interface ToolPartData {
  type: 'tool'
  id: string
  tool?: string
  callID?: string
  state?: {
    type?: 'pending' | 'running' | 'completed' | 'error'
    status?: 'pending' | 'running' | 'completed' | 'error'
    input?: unknown
    output?: string
    title?: string
    error?: string
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number }
  }
}

const stateIndicator: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'text-violet-400' },
  running: { label: 'Running', color: 'text-amber-400' },
  completed: { label: 'Done', color: 'text-emerald-400' },
  error: { label: 'Error', color: 'text-red-400' },
}

export function ToolCallPart({ part }: { part: ToolPartData }) {
  const [expanded, setExpanded] = useState(false)
  const toolName = part.tool ?? 'tool'
  const state = part.state ?? {}
  const stateType = (state.type ?? state.status ?? 'pending') as keyof typeof stateIndicator
  const indicator = stateIndicator[stateType] ?? stateIndicator.pending
  const isPending = stateType === 'pending' || stateType === 'running'
  const title = state.title ?? toolName
  const duration =
    state.time?.start && state.time?.end
      ? `${((state.time.end - state.time.start) / 1000).toFixed(1)}s`
      : null

  return (
    <div className="my-1.5 rounded-lg border border-border overflow-hidden bg-input-background/50">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-background/40 hover:bg-background/60 border-none cursor-pointer text-foreground text-[13px] text-left transition-colors"
      >
        <span className={cn('text-[10px] flex-shrink-0', indicator.color)}>
          {stateType === 'running' ? '◌' : stateType === 'completed' ? '✓' : stateType === 'error' ? '✗' : '○'}
        </span>
        <span className="font-mono text-violet-400 text-xs flex-shrink-0">{toolName}</span>
        <span className="text-muted-foreground flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs">
          {isPending ? <TextShimmer duration={1.2}>{title}</TextShimmer> : title}
        </span>
        {duration && (
          <span className="text-muted-foreground/70 text-[11px] flex-shrink-0 tabular-nums">{duration}</span>
        )}
        <span className="text-muted-foreground/60 text-[10px] flex-shrink-0 transition-transform duration-200" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
          ▸
        </span>
      </button>

      {expanded && (
        <div className="px-3 py-2 bg-[#0d0d0d] border-t border-border text-xs">
          {state.input != null && (
            <div className="mb-2">
              <div className="text-muted-foreground text-[11px] mb-1">Input</div>
              <pre className="m-0 p-2 bg-[#0a0a0a] rounded text-muted-foreground font-mono text-xs leading-relaxed whitespace-pre-wrap break-words overflow-x-auto">
                {typeof state.input === 'string' ? state.input : JSON.stringify(state.input, null, 2)}
              </pre>
            </div>
          )}
          {state.output != null && (
            <div>
              <div className="text-muted-foreground text-[11px] mb-1">Output</div>
              <pre className="m-0 p-2 bg-[#0a0a0a] rounded text-muted-foreground font-mono text-xs leading-relaxed whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto overflow-x-auto">
                {state.output}
              </pre>
            </div>
          )}
          {state.error != null && (
            <div className="text-red-400 p-2 bg-red-950/30 rounded">
              {state.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
