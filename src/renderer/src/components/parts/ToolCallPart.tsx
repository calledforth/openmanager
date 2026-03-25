import { Check, AlertCircle, Loader2 } from 'lucide-react'
import { getToolMeta, canonicalizeToolName } from './ToolRegistry'
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

function extractPath(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  return String(obj.path ?? obj.filePath ?? obj.file_path ?? obj.file ?? '')
}

function basename(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function ToolCallPart({ part }: { part: ToolPartData }) {
  const toolName = part.tool ?? 'tool'
  const state = part.state ?? {}
  const stateType = (state.type ?? state.status ?? 'pending') as string
  const isPending = stateType === 'pending' || stateType === 'running'
  const isError = stateType === 'error'

  const meta = getToolMeta(toolName)
  const canonicalName = canonicalizeToolName(toolName)
  const ToolIcon = meta.icon
  const title = state.title ?? meta.getTitle(state.input)
  const subtitle = meta.getSubtitle(state.input)
  const readTarget = canonicalName === 'Read' ? basename(extractPath(state.input)) : ''

  const statusIcon = isPending ? (
    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/70" />
  ) : isError ? (
    <AlertCircle className="h-3 w-3 text-destructive" />
  ) : (
    <Check className="h-3 w-3 text-muted-foreground/70" />
  )

  return (
    <div className="py-0.5">
      <div className="flex items-start gap-2 text-[12px] leading-relaxed">
        {canonicalName !== 'Read' && (
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/60">
            <ToolIcon className="h-3.5 w-3.5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {canonicalName === 'Read' ? (
            <div className="flex items-center gap-2">
              <span className={cn('shrink-0', isPending ? 'shimmer-text' : 'text-foreground')}>
                Read
              </span>
              <span className="truncate text-muted-foreground">
                {readTarget || title.replace(/^Read\s+/, '')}
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <span
                  className={cn('truncate', isPending ? 'shimmer-text' : 'text-muted-foreground')}
                >
                  {title}
                </span>
                <span className="shrink-0">{statusIcon}</span>
              </div>
              {subtitle && (
                <div className="truncate text-[11px] text-muted-foreground/45">{subtitle}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
