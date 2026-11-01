import { canonicalizeToolName, getToolLabels } from './tool-meta'

export type ToolUiKind =
  'search' | 'expand' | 'read' | 'edit' | 'terminal' | 'web' | 'mcp' | 'agent' | 'generic'

/** How a call ended, when it did not simply complete. */
export type ToolOutcome = 'failed' | 'declined' | 'cancelled'

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
  /** What the row leads with once the verb has been said, in mono where it is code. */
  detailIsCode?: boolean
  /** The whole command or query, where the row's detail is one line of it. */
  fullDetail?: string
  /** Every file the call named, whole paths. */
  files: string[]
  outcome?: ToolOutcome
  /** How long the call ran, once it has ended. */
  durationMs?: number
}

export interface ToolPartData {
  tool?: string
  /** The provider's own name, when it gave one. */
  toolName?: string
  /** A human title; for Cursor, the only place some tools say what they did. */
  title?: string
  /** The ACP tool kind. */
  kind?: string
  locations?: readonly { path: string; line?: number }[]
  lineChanges?: { added: number; removed: number }
  time?: { start: number; end?: number }
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
  return String(obj.path ?? obj.filePath ?? obj.file_path ?? obj.notebook_path ?? obj.file ?? '')
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
  return String(obj.command ?? obj.description ?? '')
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** What a provider's title or kind says a call was, when its name alone does not. */
interface ResolvedTool {
  canonical: string
  /** What the title named: a command, a path, a pattern, a query. */
  subject?: string
  /** The lines a read covered, as the title gave them. */
  range?: string
}

/**
 * Which tool a part is. Claude Code and OpenCode name their tools; Cursor mostly
 * does not, and says what happened in its title (`git status` in backticks,
 * Read src/a.ts (1 - 40), Find followed by a pattern, a rebuilt grep command).
 * With a fast model the title stays generic (Read File, grep) and only the ACP
 * kind is left. Every shape here is one a provider really sends.
 */
export function resolveTool(part: ToolPartData): ResolvedTool {
  const named = canonicalizeToolName(part.toolName ?? part.tool ?? '')
  const title = part.title ?? part.tool ?? ''
  if (KNOWN_TOOLS.has(named)) return { canonical: named }
  const command = /^`([\s\S]+)`$/.exec(title)
  if (command) return { canonical: 'Bash', subject: command[1] }
  const edited = /^(Edit|Delete) `(.+)`$/.exec(title)
  if (edited) return { canonical: edited[1]!, subject: edited[2] }
  const read = /^Read (?!File$)(.+?)(?: \((\d+ - \d+)\))?$/.exec(title)
  if (read && part.kind === 'read') {
    return { canonical: 'Read', subject: read[1], ...(read[2] ? { range: read[2] } : {}) }
  }
  const listed = /^List the `(.+)` directory's contents$/.exec(title)
  if (listed) return { canonical: 'List', subject: listed[1] }
  if (/^List the current directory's contents$/.test(title)) {
    return { canonical: 'List', subject: '.' }
  }
  const found = /^Find(?: `(.+?)`)?(?: `(.+?)`)?$/.exec(title)
  if (found) return { canonical: 'Glob', subject: found[2] ?? found[1] }
  const grep = /^grep\b(.*)$/s.exec(title)
  if (grep) {
    const quoted = [...grep[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1]
    return { canonical: 'Grep', subject: quoted ?? (grep[1]!.trim() || undefined) }
  }
  const search = /^(?:Search|Web Search)(?:: "(.+)")?$/.exec(title)
  if (search) {
    return { canonical: title.startsWith('Web') ? 'WebSearch' : 'Search', subject: search[1] }
  }
  if (title === 'Codebase Search') return { canonical: 'Search' }
  const fetched = /^(?:Web )?Fetch(?:: (.+))?$/.exec(title)
  if (fetched) return { canonical: 'WebFetch', subject: fetched[1] }
  const task = /^Task: (.+)$/.exec(title)
  if (task) return { canonical: 'Task', subject: task[1] }
  if (/^Update TODOs\b/.test(title)) return { canonical: 'TodoWrite' }
  if (/^Generate Image\b/.test(title)) return { canonical: 'GenerateImage' }
  switch (part.kind) {
    case 'execute':
      return { canonical: 'Bash' }
    case 'edit':
      return { canonical: 'Edit' }
    case 'delete':
      return { canonical: 'Delete' }
    case 'read':
      return { canonical: 'Read' }
    case 'search':
      return { canonical: 'Search' }
    case 'fetch':
      return { canonical: 'WebFetch' }
    default:
      return { canonical: named }
  }
}

const KNOWN_TOOLS = new Set([
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'Delete',
  'Read',
  'Grep',
  'Glob',
  'List',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'Task',
  'AskUserQuestion',
  'GenerateImage',
])

function outcomeOf(stateType: string): ToolOutcome | undefined {
  if (stateType === 'error' || stateType === 'failed') return 'failed'
  return stateType === 'declined' || stateType === 'cancelled' ? stateType : undefined
}

/** `mcp__server__tool`, or Cursor's input for the same thing. */
function mcpCall(part: ToolPartData): { server: string; tool: string } | undefined {
  const name = part.toolName ?? part.tool ?? ''
  const named = /^mcp__(.+?)__(.+)$/.exec(name)
  if (named) return { server: named[1]!, tool: named[2]! }
  const input = (part.state?.input ?? {}) as Record<string, unknown>
  const server = text(input.providerIdentifier)
  return server ? { server, tool: text(input.toolName) } : undefined
}

function quoted(value: string): string {
  return value ? `"${value}"` : ''
}

/** The input's search subject, in the spellings the providers use. */
function searchSubject(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  return text(obj.pattern) || text(obj.query) || text(obj.searchTerm) || text(obj.glob_pattern)
}

/** Where a search looked, when it says. */
function searchScope(input: unknown): string {
  const path = extractPath(input)
  return path && path !== '.' ? ` in ${path}` : ''
}

export function countDiffStats(output: string): { added: number; removed: number } {
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

/** A line count from the provider, or else from a diff the output holds (desktop). */
function lineCounts(part: ToolPartData, output: string) {
  const reported = part.lineChanges
  const stats = reported ?? countDiffStats(output)
  return { added: stats.added, removed: stats.removed }
}

export function isToolRunning(stateType: string): boolean {
  return stateType === 'pending' || stateType === 'running' || stateType === 'input-streaming'
}

/**
 * What a row says about a call. It has to read well from the input alone: a
 * settled tool's output is not on the client until the row is opened.
 */
export function presentToolPart(part: ToolPartData): ToolPresenterModel {
  const state = part.state ?? {}
  const stateType = getToolStateType(state)
  const isRunning = isToolRunning(stateType)
  const isError = stateType === 'error'
  const outcome = outcomeOf(stateType)
  const { canonical, subject, range } = resolveTool(part)
  const toolName = part.toolName ?? part.tool ?? 'tool'
  const meta = getToolLabels(canonical || toolName)
  const title = state.title ?? part.title ?? meta.getTitle(state.input)
  const subtitle = meta.getSubtitle(state.input)
  const output = formatToolOutput(state.output ?? state.error)
  const expandedText = output || undefined
  const files = (part.locations ?? []).map((location) => location.path)
  const time = part.time
  const base = {
    isRunning,
    isError,
    expandedText,
    files,
    ...(outcome ? { outcome } : {}),
    ...(time?.end !== undefined ? { durationMs: Math.max(0, time.end - time.start) } : {}),
  }
  const path = extractPath(state.input) || subject || files[0] || ''

  if (canonical === 'Read') {
    const target = basename(path)
    return {
      ...base,
      uiKind: 'read',
      verb: isRunning ? 'Reading' : 'Read',
      detail: `${target || title.replace(/^Read\s+/, '')}${range ? ` (${range})` : ''}`,
      readTarget: target,
      fullDetail: path || undefined,
    }
  }

  if (canonical === 'Bash') {
    const command = extractCommand(state.input) || subject || ''
    return {
      ...base,
      uiKind: 'terminal',
      verb: isRunning ? 'Running' : 'Ran',
      detail: firstLine(command) || subtitle,
      detailIsCode: true,
      fullDetail: command || undefined,
    }
  }

  if (
    canonical === 'Edit' ||
    canonical === 'Write' ||
    canonical === 'MultiEdit' ||
    canonical === 'Delete'
  ) {
    const stats = lineCounts(part, output)
    const verbs = {
      Delete: ['Deleting', 'Deleted'],
      Write: ['Writing', 'Wrote'],
      Edit: ['Editing', 'Edited'],
      MultiEdit: ['Editing', 'Edited'],
    }[canonical]
    return {
      ...base,
      uiKind: 'edit',
      verb: isRunning ? verbs[0] : verbs[1],
      detail: basename(path) || 'file',
      fullDetail: path || undefined,
      ...(stats.added > 0 || stats.removed > 0
        ? { diffAdds: stats.added, diffDels: stats.removed }
        : {}),
    }
  }

  if (canonical === 'Grep' || canonical === 'Search') {
    const pattern = searchSubject(state.input) || subject || ''
    return {
      ...base,
      uiKind: 'search',
      verb: isRunning ? 'Searching for' : 'Searched for',
      detail: `${quoted(pattern)}${searchScope(state.input)}`.trim() || 'code',
      fullDetail: pattern || undefined,
    }
  }

  if (canonical === 'Glob' || canonical === 'List') {
    const target =
      canonical === 'List' ? path : searchSubject(state.input) || subject || subtitle || ''
    return {
      ...base,
      uiKind: 'search',
      verb:
        canonical === 'List' ? (isRunning ? 'Listing' : 'Listed') : isRunning ? 'Finding' : 'Found',
      detail: target || 'files',
      detailIsCode: true,
    }
  }

  if (canonical === 'WebSearch') {
    const query = searchSubject(state.input) || subject || ''
    return {
      ...base,
      uiKind: 'web',
      verb: isRunning ? 'Searching the web for' : 'Searched the web for',
      detail: quoted(query) || 'an answer',
    }
  }

  if (canonical === 'WebFetch') {
    const url = text((state.input as { url?: unknown } | undefined)?.url) || subject || ''
    return {
      ...base,
      uiKind: 'web',
      verb: isRunning ? 'Fetching' : 'Fetched',
      detail: url || 'a page',
      fullDetail: url || undefined,
    }
  }

  if (canonical === 'Task') {
    const description = subtitle || subject || ''
    return {
      ...base,
      uiKind: 'agent',
      verb: isRunning ? 'Running subagent' : 'Ran subagent',
      detail: description,
    }
  }

  const mcp = mcpCall(part)
  if (mcp) {
    return {
      ...base,
      uiKind: 'mcp',
      verb: mcp.server.replace(/^(?:claude_ai_|plugin_)/, '').replaceAll('_', ' '),
      detail: mcp.tool.replaceAll('_', ' '),
    }
  }

  return {
    ...base,
    uiKind: 'generic',
    verb: title.split(' ')[0] ?? toolName,
    detail: subtitle || title.split(' ').slice(1).join(' '),
  }
}
