import { canonicalizeToolName, getToolLabels } from './tool-meta'

export type ToolUiKind =
  | 'search'
  | 'expand'
  | 'read'
  | 'edit'
  | 'terminal'
  | 'web'
  | 'generic'

export interface ToolPresenterModel {
  uiKind: ToolUiKind
  verb: string
  detail: string
  isRunning: boolean
  isError: boolean
  expandedText?: string
  diffAdds?: number
  diffDels?: number
  readTarget?: string
}

interface ToolPartData {
  tool?: string
  state?: {
    type?: string
    status?: string
    input?: unknown
    output?: unknown
    title?: string
    error?: string
  }
}

/**
 * ACP deliberately allows provider-owned structured tool output. Keep that
 * flexibility at the contract boundary, but never pass the raw value through
 * to React: Cursor, for example, wraps its result as { output, metadata }.
 */
export function formatToolOutput(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }

  if (Array.isArray(value)) {
    return value.map(formatToolOutput).filter(Boolean).join('\n')
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('output' in record && record.output !== value) return formatToolOutput(record.output)
    if (record.type === 'text' && typeof record.text === 'string') return record.text

    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  return String(value)
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

function extractCommand(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  const cmd = String(obj.command ?? obj.description ?? '')
  return cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd
}

function countDiffStats(output: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

export function getToolStateType(state: ToolPartData['state']): string {
  return (state?.type ?? state?.status ?? 'pending') as string
}

export function isToolRunning(stateType: string): boolean {
  return stateType === 'pending' || stateType === 'running' || stateType === 'input-streaming'
}

export function presentToolPart(part: ToolPartData): ToolPresenterModel {
  const toolName = part.tool ?? 'tool'
  const state = part.state ?? {}
  const stateType = getToolStateType(state)
  const isRunning = isToolRunning(stateType)
  const isError = stateType === 'error'
  const canonical = canonicalizeToolName(toolName)
  const meta = getToolLabels(toolName)
  const title = state.title ?? meta.getTitle(state.input)
  const subtitle = meta.getSubtitle(state.input)
  const output = formatToolOutput(state.output ?? state.error)

  if (canonical === 'Read') {
    const target = basename(extractPath(state.input))
    return {
      uiKind: 'read',
      verb: 'Read',
      detail: target || title.replace(/^Read\s+/, ''),
      isRunning,
      isError,
      readTarget: target,
      expandedText: output || undefined,
    }
  }

  if (canonical === 'Bash') {
    const command = extractCommand(state.input)
    const verb = isRunning
      ? stateType === 'input-streaming'
        ? 'bash'
        : 'bash'
      : 'bash'
    return {
      uiKind: 'terminal',
      verb,
      detail: command || subtitle,
      isRunning,
      isError,
      expandedText: output || undefined,
    }
  }

  if (canonical === 'Edit' || canonical === 'Write' || canonical === 'MultiEdit') {
    const file = basename(extractPath(state.input))
    const stats = countDiffStats(output)
    const diffSuffix =
      !isRunning && (stats.added > 0 || stats.removed > 0)
        ? ` +${stats.added} -${stats.removed}`
        : ''
    return {
      uiKind: 'edit',
      verb: canonical === 'Write' ? 'Wrote' : 'Edited',
      detail: `${file}${diffSuffix}`,
      isRunning,
      isError,
      diffAdds: stats.added,
      diffDels: stats.removed,
      expandedText: output || undefined,
    }
  }

  if (canonical === 'Grep' || canonical === 'Glob') {
    return {
      uiKind: 'search',
      verb: canonical === 'Grep' ? 'grep' : 'glob',
      detail: subtitle || title.replace(/^(Grep|Glob)\s+/, ''),
      isRunning,
      isError,
      expandedText: output || undefined,
    }
  }

  if (canonical === 'WebSearch' || canonical === 'WebFetch') {
    return {
      uiKind: 'web',
      verb: canonical === 'WebSearch' ? 'Searched' : 'Fetched',
      detail: subtitle || title,
      isRunning,
      isError,
      expandedText: output || undefined,
    }
  }

  return {
    uiKind: 'generic',
    verb: title.split(' ')[0] ?? toolName,
    detail: subtitle || title.split(' ').slice(1).join(' '),
    isRunning,
    isError,
    expandedText: output || undefined,
  }
}
