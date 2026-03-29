import { AlertCircle } from 'lucide-react'
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
    <span className="custom-loader text-primary shrink-0" />
  ) : isError ? (
    <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
  ) : null

  return (
    <div className="py-0.5">
      <div className="flex items-start gap-2 text-[14px] leading-relaxed">
        {canonicalName !== 'Read' ? (
          <span className="mt-[4px] flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/60">
            <ToolIcon className="h-4 w-4" />
          </span>
        ) : (
          <span className="mt-[4px] flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/60">
            <ToolIcon className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {canonicalName === 'Read' ? (
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'shrink-0',
                  isPending ? 'shimmer-text font-medium' : 'text-foreground',
                )}
              >
                Read
              </span>
              <span className="truncate text-muted-foreground/70 font-mono text-[13px]">
                {readTarget || title.replace(/^Read\s+/, '')}
              </span>
              {statusIcon && <span className="ml-2 flex items-center">{statusIcon}</span>}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'truncate',
                    isPending ? 'shimmer-text font-medium' : 'text-foreground',
                  )}
                >
                  {title}
                </span>
                {subtitle && canonicalName === 'Grep' && (
                  <span className="truncate text-muted-foreground/70 font-mono text-[13px]">
                    {subtitle}
                  </span>
                )}
                {statusIcon && <span className="flex items-center">{statusIcon}</span>}
              </div>
              {subtitle && canonicalName !== 'Grep' && (
                <div className="truncate text-[12px] text-muted-foreground/60 mt-0.5">
                  {subtitle}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
