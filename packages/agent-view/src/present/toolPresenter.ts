import type { PermissionRequest, ToolCallStatus, ToolKind } from '@agentpack/contract'
import type { FoldedToolRow } from '../fold/foldEvents.js'
import { extractDiff, type StructuredDiff } from './diff.js'

export type ToolViewKind =
  'file-read' | 'file-edit' | 'shell' | 'search' | 'web-fetch' | 'subagent' | 'mcp' | 'generic'

export type ToolPresentationStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled'

export type ToolViewModel = {
  kind: ToolViewKind
  path?: string
  diff?: StructuredDiff
  status: ToolPresentationStatus
  permission?: PermissionRequest
  raw: FoldedToolRow
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function firstString(value: unknown, keys: readonly string[]): string | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  for (const nested of Object.values(record)) {
    const found = firstString(nested, keys)
    if (found) return found
  }
  return undefined
}

function firstRawTitle(row: FoldedToolRow): string {
  for (const raw of row.rawEvents) {
    if (raw.event !== 'tool_call' && raw.event !== 'tool_call_update') continue
    const title = asRecord(raw.data)?.title
    if (typeof title === 'string' && title.trim()) return title.trim()
  }
  return row.title.trim()
}

function isMcp(row: FoldedToolRow): boolean {
  const metadata = row.metadata
  return Boolean(
    metadata?.mcp ||
    metadata?.serverName ||
    metadata?.serverId ||
    /^(mcp[:._-]|mcp\b)/i.test(firstRawTitle(row)),
  )
}

function toolViewKind(row: FoldedToolRow): ToolViewKind {
  const title = firstRawTitle(row).toLowerCase()
  if (isMcp(row)) return 'mcp'
  if (title === 'task' || /\b(subagent|subtask)\b/i.test(title)) return 'subagent'
  const mapping: Partial<Record<ToolKind, ToolViewKind>> = {
    read: 'file-read',
    edit: 'file-edit',
    delete: 'file-edit',
    move: 'file-edit',
    execute: 'shell',
    search: 'search',
    fetch: 'web-fetch',
  }
  if (row.kind && mapping[row.kind]) return mapping[row.kind]!
  if (/\b(grep|search|codesearch|web\s*search)\b/i.test(title)) return 'search'
  if (/\b(bash|shell|terminal|command)\b/i.test(title)) return 'shell'
  return 'generic'
}

export function presentToolStatus(
  status: ToolCallStatus | undefined,
  row?: FoldedToolRow,
): ToolPresentationStatus {
  const rawStatus =
    firstString(row?.metadata, ['status', 'state']) ??
    firstString(row?.rawOutput, ['status', 'state'])
  if (rawStatus && /cancel(?:led|ed)/i.test(rawStatus)) return 'cancelled'
  if (status === 'in_progress') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'error'
  if (status === 'pending') return 'pending'
  return 'pending'
}

function toolPath(row: FoldedToolRow, diff: StructuredDiff | undefined): string | undefined {
  return (
    diff?.hunks[0]?.path ??
    row.locations?.[0]?.path ??
    firstString(row.rawInput, [
      'path',
      'filePath',
      'filepath',
      'file',
      'target',
      'uri',
      'location',
    ]) ??
    pathFromText(row.title)
  )
}

function pathFromText(text: string): string | undefined {
  const fileUri = text.match(/\bfile:\/\/[^\s)'"`<>]+/i)?.[0]
  if (fileUri) return fileUri
  const windowsPath = text.match(/\b[A-Za-z]:\\[^\s)'"`<>]+/)?.[0]
  if (windowsPath) return windowsPath
  const unixPath = text.match(/(?:^|\s)(\/[^\s)'"`<>]+)/)?.[1]
  if (unixPath) return unixPath
  return text.match(/(?:^|\s|[`'"])([^\s`'"]+\.[A-Za-z0-9]{1,8})(?=$|\s|[`'"])/)?.[1]
}

export function presentTool(row: FoldedToolRow): ToolViewModel {
  const diff = extractDiff(row.contentItems)
  const path = toolPath(row, diff)
  return {
    kind: toolViewKind(row),
    ...(path ? { path } : {}),
    ...(diff ? { diff } : {}),
    status: presentToolStatus(row.status, row),
    ...(row.permission ? { permission: row.permission } : {}),
    raw: row,
  }
}

export const presentToolRow = presentTool
