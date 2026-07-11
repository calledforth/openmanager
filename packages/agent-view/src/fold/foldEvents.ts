import type {
  AgentEvent,
  PermissionRequest,
  PlanUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '@agentpack/contract'

export type ConnectionState = 'idle' | 'spawned' | 'initialized' | 'authenticated' | 'error'

export type FoldedToolRawEvent = {
  event: 'tool_call' | 'tool_call_update' | 'tool_call_content'
  data: unknown
}

export type FoldedToolRow = {
  type: 'tool'
  id: string
  toolCallId: string
  title: string
  kind?: ToolKind
  status?: ToolCallStatus
  rawInput?: unknown
  rawOutput?: unknown
  metadata?: Record<string, unknown>
  locations?: ToolCallLocation[]
  contentItems: ToolCallContent[]
  resultLinks?: string[]
  permission?: PermissionRequest
  rawEvents: FoldedToolRawEvent[]
}

export type FoldedExploreGroupRow = {
  type: 'explore_group'
  id: string
  kind: 'search' | 'read'
  items: FoldedToolRow[]
}

export type FoldedWorkedGroupRow = {
  type: 'worked_group'
  id: string
  durationMs: number
  durationMinutes: number
  label: string
  items: FoldedRow[]
}

export type FoldedSubagentRow = {
  type: 'subagent'
  id: string
  title: string
  subtitle?: string
  status: 'running' | 'completed' | 'failed' | 'unknown'
  model?: string
  toolCount?: number
  targetSessionId?: string
  raw: unknown
}

export type FoldedRow =
  | { type: 'user'; id: string; text: string }
  | { type: 'assistant'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string }
  | FoldedToolRow
  | FoldedExploreGroupRow
  | FoldedWorkedGroupRow
  | FoldedSubagentRow
  | { type: 'permission'; id: string; data: PermissionRequest }
  | {
      type: 'extension'
      id: string
      event: 'extension_request' | 'extension_notification'
      method: string
      data: unknown
    }
  | { type: 'plan'; id: string; data: PlanUpdate }
  | { type: 'error'; id: string; event: AgentEvent['event']; data: unknown }

export type FoldEventsOptions = {
  includeDetachedPermissions?: boolean
  summarizeWork?: boolean
}

export function sortAgentEvents(events: readonly AgentEvent[]): AgentEvent[] {
  return [...events].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq
    const timestamp = a.timestamp.localeCompare(b.timestamp)
    return timestamp || a.id.localeCompare(b.id)
  })
}

export function deriveConnectionState(events: readonly AgentEvent[]): ConnectionState {
  let state: ConnectionState = 'idle'
  for (const event of sortAgentEvents(events)) {
    if (event.event === 'process_spawned') state = 'spawned'
    if (event.event === 'rpc_error' || event.event === 'runtime_error') state = 'error'
    else if (state !== 'error' && event.event === 'initialized') state = 'initialized'
    else if (state !== 'error' && event.event === 'authenticated') state = 'authenticated'
  }
  return state
}

function textFromContent(event: Extract<AgentEvent, { category: 'stream' }>): string {
  const block = event.data.content
  if (block.type === 'text') return block.text
  if (block.type === 'resource_link') return block.uri
  if (block.type === 'resource') return block.text ?? block.uri ?? ''
  return ''
}

function collectUrls(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\bhttps?:\/\/[^\s)'"`<>]+/gi)) {
      if (!output.includes(match[0])) output.push(match[0])
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, output)
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>))
      collectUrls(nested, output)
  }
}

function mergeUrls(row: FoldedToolRow, ...values: unknown[]): void {
  const urls = row.resultLinks ? [...row.resultLinks] : []
  for (const value of values) collectUrls(value, urls)
  if (urls.length) row.resultLinks = urls
}

type ToolPatch = {
  title?: string
  kind?: ToolKind
  status?: ToolCallStatus
  rawInput?: unknown
  rawOutput?: unknown
  content?: ToolCallContent[]
  locations?: ToolCallLocation[]
  metadata?: Record<string, unknown>
}

function toolStatusRank(status: ToolCallStatus | undefined): number {
  if (status === 'completed' || status === 'failed') return 2
  if (status === 'in_progress') return 1
  return 0
}

function mergeTool(row: FoldedToolRow, patch: ToolPatch): void {
  if (patch.title !== undefined) row.title = patch.title
  if (patch.kind !== undefined) row.kind = patch.kind
  if (patch.status !== undefined && toolStatusRank(patch.status) >= toolStatusRank(row.status)) {
    row.status = patch.status
  }
  if (patch.rawInput !== undefined) row.rawInput = patch.rawInput
  if (patch.rawOutput !== undefined) row.rawOutput = patch.rawOutput
  if (patch.content !== undefined) row.contentItems = [...patch.content]
  if (patch.locations !== undefined) row.locations = [...patch.locations]
  if (patch.metadata !== undefined) row.metadata = { ...patch.metadata }
  mergeUrls(row, patch.rawOutput, patch.content)
}

function exploreKind(row: FoldedToolRow): 'search' | 'read' | undefined {
  if (row.kind === 'search' || /\b(grep|web\s*search|codesearch)\b/i.test(row.title))
    return 'search'
  return row.kind === 'read' ? 'read' : undefined
}

function foldExploreGroups(rows: FoldedRow[]): FoldedRow[] {
  const output: FoldedRow[] = []
  let group: { kind: 'search' | 'read'; items: FoldedToolRow[] } | undefined
  const flush = () => {
    if (!group) return
    if (group.items.length === 1) output.push(group.items[0]!)
    else
      output.push({
        type: 'explore_group',
        id: `explore:${group.kind}:${group.items[0]!.toolCallId}`,
        kind: group.kind,
        items: group.items,
      })
    group = undefined
  }
  for (const row of rows) {
    const kind = row.type === 'tool' ? exploreKind(row) : undefined
    if (!kind) {
      flush()
      output.push(row)
    } else if (!group || group.kind !== kind) {
      flush()
      group = { kind, items: [row as FoldedToolRow] }
    } else group.items.push(row as FoldedToolRow)
  }
  flush()
  return output
}

function firstToolTitle(row: FoldedToolRow): string {
  for (const raw of row.rawEvents) {
    if (raw.event === 'tool_call' || raw.event === 'tool_call_update') {
      const title = (raw.data as { title?: unknown }).title
      if (typeof title === 'string' && title.trim()) return title.trim()
    }
  }
  return row.title.trim()
}

function isTodo(row: FoldedRow): row is FoldedToolRow {
  return row.type === 'tool' && /^todo(?:write)?$/i.test(firstToolTitle(row))
}

function dedupeSegment(rows: FoldedRow[]): FoldedRow[] {
  const plans: number[] = []
  const todos: number[] = []
  rows.forEach((row, index) => {
    if (row.type === 'plan') plans.push(index)
    if (isTodo(row)) todos.push(index)
  })
  const replacements = new Map<number, FoldedRow>()
  const removed = new Set<number>()
  for (const indexes of [plans, todos]) {
    if (indexes.length < 2) continue
    const first = indexes[0]!
    const latest = rows[indexes[indexes.length - 1]!]!
    if (isTodo(latest)) {
      const rawEvents = indexes.flatMap((index) => {
        const row = rows[index]!
        return isTodo(row) ? row.rawEvents : []
      })
      replacements.set(first, { ...latest, id: `todo:${latest.toolCallId}`, rawEvents })
    } else replacements.set(first, latest)
    indexes.forEach((index) => removed.add(index))
    removed.delete(first)
  }
  return rows.flatMap((row, index) => (removed.has(index) ? [] : [replacements.get(index) ?? row]))
}

function dedupePlansAndTodos(rows: FoldedRow[]): FoldedRow[] {
  const output: FoldedRow[] = []
  let segment: FoldedRow[] = []
  const flush = () => {
    output.push(...dedupeSegment(segment))
    segment = []
  }
  for (const row of rows) {
    if (row.type === 'user') {
      flush()
      output.push(row)
    } else segment.push(row)
  }
  flush()
  return output.map((row) =>
    row.type === 'worked_group' ? { ...row, items: dedupePlansAndTodos(row.items) } : row,
  )
}

function parseSubagent(
  event: Extract<AgentEvent, { event: 'extension_request' | 'extension_notification' }>,
): FoldedSubagentRow | undefined {
  if (event.data.method !== 'cursor/task') return undefined
  const params =
    event.data.params && typeof event.data.params === 'object'
      ? (event.data.params as Record<string, unknown>)
      : {}
  const text = (...keys: string[]) => {
    for (const key of keys) {
      const value = params[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
  }
  const rawStatus = text('status', 'state', 'phase')?.toLowerCase() ?? ''
  const status: FoldedSubagentRow['status'] = /(run|progress|active|pending|starting)/.test(
    rawStatus,
  )
    ? 'running'
    : /(complete|done|success)/.test(rawStatus)
      ? 'completed'
      : /(fail|error|cancel)/.test(rawStatus)
        ? 'failed'
        : 'unknown'
  const count = params.toolCount ?? params.tools ?? params.toolCalls
  return {
    type: 'subagent',
    id: event.id,
    title: text('title', 'name', 'taskTitle', 'label') ?? 'Subagent',
    subtitle: text('description', 'subtitle', 'summary'),
    status,
    model: text('model', 'modelName', 'modelId', 'currentModel', 'currentModelId'),
    toolCount: typeof count === 'number' ? count : undefined,
    targetSessionId: text('sessionId', 'childSessionId', 'taskSessionId'),
    raw: event.data,
  }
}

function durationLabel(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000)
  return minutes < 1 ? 'Worked for <1 min' : `Worked for ${minutes} min${minutes === 1 ? '' : 's'}`
}

function foldLatestWorkedGroup(rows: FoldedRow[], events: readonly AgentEvent[]): FoldedRow[] {
  let start: AgentEvent | undefined
  let completed: { start: AgentEvent; end: AgentEvent } | undefined
  for (const event of events) {
    if (event.event === 'prompt_started') start = event
    if (event.event === 'prompt_completed' && start) {
      completed = { start, end: event }
      start = undefined
    }
  }
  if (!completed) return rows
  const assistantIndex = rows.findLastIndex((row) => row.type === 'assistant')
  if (assistantIndex < 0) return rows
  let userIndex = -1
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (rows[index]!.type === 'user') {
      userIndex = index
      break
    }
  }
  const groupStart = userIndex + 1
  const items = rows
    .slice(groupStart, assistantIndex)
    .filter((row) => row.type !== 'user' && row.type !== 'assistant')
  if (!items.length) return rows
  const startMs = Date.parse(completed.start.timestamp)
  const endMs = Date.parse(completed.end.timestamp)
  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : 0
  return [
    ...rows.slice(0, groupStart),
    {
      type: 'worked_group',
      id: `worked:${completed.end.id}`,
      durationMs,
      durationMinutes: Math.floor(durationMs / 60_000),
      label: durationLabel(durationMs),
      items,
    },
    ...rows.slice(assistantIndex),
  ]
}

export function foldEvents(
  events: readonly AgentEvent[],
  options: FoldEventsOptions = {},
): FoldedRow[] {
  const sorted = sortAgentEvents(events)
  const rows: FoldedRow[] = []
  const tools = new Map<string, FoldedToolRow>()
  let pendingPrompt: { id: string; text: string } | undefined
  let thinking: { id: string; text: string } | undefined
  let userMessageId: string | undefined
  let assistantMessageId: string | undefined
  let activeUser: Extract<FoldedRow, { type: 'user' }> | undefined
  let activeAssistant: Extract<FoldedRow, { type: 'assistant' }> | undefined

  const flushPrompt = () => {
    if (pendingPrompt?.text.trim()) rows.push({ type: 'user', ...pendingPrompt })
    pendingPrompt = undefined
  }
  const flushThinking = () => {
    if (thinking?.text.trim()) rows.push({ type: 'thinking', ...thinking })
    thinking = undefined
  }
  const ensureTool = (toolCallId: string, id: string): FoldedToolRow => {
    const existing = tools.get(toolCallId)
    if (existing) return existing
    const row: FoldedToolRow = {
      type: 'tool',
      id,
      toolCallId,
      title: '',
      contentItems: [],
      rawEvents: [],
    }
    tools.set(toolCallId, row)
    rows.push(row)
    return row
  }

  for (const event of sorted) {
    switch (event.event) {
      case 'prompt_started':
        flushThinking()
        flushPrompt()
        pendingPrompt = { id: event.id, text: event.data.prompt }
        activeUser = undefined
        activeAssistant = undefined
        userMessageId = undefined
        assistantMessageId = undefined
        break
      case 'user_message_chunk': {
        flushThinking()
        flushPrompt()
        const messageId = event.data.messageId
        const piece = textFromContent(event)
        if (
          activeUser &&
          (messageId === undefined || userMessageId === undefined || messageId === userMessageId)
        ) {
          activeUser.text += piece
          userMessageId ??= messageId
        } else {
          activeUser = { type: 'user', id: event.id, text: piece }
          rows.push(activeUser)
          userMessageId = messageId
        }
        break
      }
      case 'agent_thought_chunk':
        flushPrompt()
        thinking ??= { id: event.id, text: '' }
        thinking.text += textFromContent(event)
        break
      case 'agent_message_chunk': {
        flushThinking()
        flushPrompt()
        const messageId = event.data.messageId
        const piece = textFromContent(event)
        if (
          activeAssistant &&
          (messageId === undefined ||
            assistantMessageId === undefined ||
            messageId === assistantMessageId)
        ) {
          activeAssistant.text += piece
          assistantMessageId ??= messageId
        } else {
          activeAssistant = { type: 'assistant', id: event.id, text: piece }
          rows.push(activeAssistant)
          assistantMessageId = messageId
        }
        break
      }
      case 'tool_call':
      case 'tool_call_update': {
        flushThinking()
        flushPrompt()
        activeAssistant = undefined
        assistantMessageId = undefined
        const row = ensureTool(event.data.toolCallId, event.id)
        row.rawEvents.push({ event: event.event, data: event.data })
        mergeTool(row, event.data)
        break
      }
      case 'tool_call_content': {
        flushThinking()
        flushPrompt()
        activeAssistant = undefined
        assistantMessageId = undefined
        const row = ensureTool(event.data.toolCallId, event.id)
        row.rawEvents.push({ event: event.event, data: event.data })
        row.contentItems.push(event.data.item)
        mergeUrls(row, event.data.item)
        break
      }
      case 'permission_request': {
        flushThinking()
        activeAssistant = undefined
        const toolCallId = event.data.toolCall.toolCallId
        if (toolCallId) {
          const row = ensureTool(toolCallId, toolCallId)
          if (!row.title) row.title = event.data.toolCall.title
          row.permission = event.data
        } else if (options.includeDetachedPermissions) {
          rows.push({ type: 'permission', id: event.data.requestId, data: event.data })
        }
        break
      }
      case 'plan_update':
        flushThinking()
        activeAssistant = undefined
        rows.push({ type: 'plan', id: event.id, data: event.data })
        break
      case 'extension_request':
      case 'extension_notification':
        flushThinking()
        activeAssistant = undefined
        rows.push(
          parseSubagent(event) ?? {
            type: 'extension',
            id: event.id,
            event: event.event,
            method: event.data.method,
            data: event.data,
          },
        )
        break
      case 'rpc_error':
      case 'runtime_error':
      case 'auth_required':
      case 'capability_missing':
        flushThinking()
        activeAssistant = undefined
        rows.push({ type: 'error', id: event.id, event: event.event, data: event.data })
        break
      case 'prompt_completed':
        flushThinking()
        flushPrompt()
        activeUser = undefined
        activeAssistant = undefined
        userMessageId = undefined
        assistantMessageId = undefined
        break
      default:
        break
    }
  }
  flushThinking()
  flushPrompt()

  const explored = foldExploreGroups(rows)
  const worked =
    options.summarizeWork === false ? explored : foldLatestWorkedGroup(explored, sorted)
  return dedupePlansAndTodos(worked)
}

export const foldAgentEvents = foldEvents
