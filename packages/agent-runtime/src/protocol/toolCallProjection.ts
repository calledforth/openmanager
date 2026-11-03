import { createHash, type Hash } from 'node:crypto'
import type {
  ToolCall,
  ToolCallContent,
  ToolCallUpdate as AgentToolCallUpdate,
} from '@agentpack/contract'
import {
  isSettledToolStatus,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolLocation,
} from '@openmanager/protocol'

type AgentTool = ToolCall | AgentToolCallUpdate
type ToolKind = NonNullable<AgentTool['kind']>
type OutputFields = Pick<ToolCallUpdate, 'output' | 'outputDelta'>

/**
 * Keys that hold the body of an edit rather than where it goes. Chat never
 * carries diffs or file contents, so an edit tool's input keeps its paths and
 * flags and loses these. Claude Code's are `old_string`/`new_string` (Edit,
 * and each of MultiEdit's `edits`), `content` (Write) and `new_source`
 * (NotebookEdit); the rest are the spellings other agents use.
 */
const EDIT_BODY_KEYS = new Set([
  'old_string',
  'new_string',
  'oldString',
  'newString',
  'old_text',
  'new_text',
  'oldText',
  'newText',
  'old_source',
  'new_source',
  'content',
  'contents',
])
/**
 * Keys whose string value is a patch or diff body, whatever the tool says it
 * is: OpenCode's `apply_patch` sends its whole patch as `patchText`. For any
 * tool only a string is a body, so a `diff: true` flag stays; an edit tool
 * loses the key whatever it holds.
 */
const PATCH_BODY_KEYS = new Set([
  'patch',
  'patchText',
  'patch_text',
  'diff',
  'diffText',
  'diff_text',
  'unifiedDiff',
  'unified_diff',
])
/** Claude Code's edit tools, recognised by name even on an update that carries no kind. */
const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The input without edit bodies (an edit tool's) or patch bodies (any tool's). */
function stripBodies(value: unknown, edit: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => stripBodies(item, edit))
  if (!value || typeof value !== 'object') return value
  const kept: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    // Cursor's own marker for the tool's name, which `toolName` carries.
    if (key === '_toolName') continue
    if (edit && EDIT_BODY_KEYS.has(key)) continue
    if (PATCH_BODY_KEYS.has(key) && (edit || typeof item === 'string')) continue
    kept[key] = item && typeof item === 'object' ? stripBodies(item, edit) : item
  }
  return kept
}

export const isEdit = (kind: ToolKind | undefined, toolName: string | undefined) =>
  kind === 'edit' || kind === 'delete' || (toolName !== undefined && EDIT_TOOL_NAMES.has(toolName))

/**
 * A tool that shows paths, never the file: reads and edits. A listing reports
 * as a read on OpenCode, and names files rather than holding one, so its
 * output stays.
 */
export function isPathOnly(
  kind: ToolKind | undefined,
  toolName: string | undefined,
  title: string | undefined,
): boolean {
  if (isEdit(kind, toolName) || toolName === 'Read') return true
  return kind === 'read' && !/^(list|ls)\b/i.test(toolName ?? title ?? '')
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  const block = value as { type?: unknown; text?: unknown }
  return block.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

type RawReport = {
  output?: unknown
  error?: unknown
  stdout?: unknown
  stderr?: unknown
  rejected?: unknown
  permissionDenied?: unknown
  totalMatches?: unknown
  totalFiles?: unknown
  resultCount?: unknown
  referenceCount?: unknown
}

const report = (raw: unknown): RawReport | undefined =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RawReport) : undefined

const counted = (value: unknown, one: string, many: string) =>
  Number.isSafeInteger(value) ? `${String(value)} ${value === 1 ? one : many}` : undefined

/**
 * A provider-shaped raw output's text. OpenCode reports `{ output }` or
 * `{ error }` beside `metadata`, which can hold a diff and is never read.
 * Cursor's shell reports `{ stdout, stderr }`, and its searches report only a
 * count, which is all there is to say of them.
 */
function reportedText(value: unknown): string | undefined {
  const raw = report(value)
  if (!raw) return undefined
  if (typeof raw.output === 'string' && raw.output) return raw.output
  if (typeof raw.error === 'string' && raw.error) return raw.error
  const streams = [raw.stdout, raw.stderr].filter(
    (stream): stream is string => typeof stream === 'string' && stream.length > 0,
  )
  if (streams.length > 0) return streams.join('\n')
  return (
    counted(raw.totalMatches, 'match', 'matches') ??
    counted(raw.totalFiles, 'file', 'files') ??
    counted(raw.resultCount, 'result', 'results') ??
    counted(raw.referenceCount, 'reference', 'references')
  )
}

/**
 * The output a tool update reports, as text, whole. Text and embedded-resource
 * content first; for a tool with no such content, a raw output that is text
 * (Claude Code's tool result: a string or a list of text blocks) or a report.
 * Images are left out: the environment moves them into the reply. Diffs and
 * terminals are left out: chat carries no diff, and a terminal is only a handle.
 */
function reportedOutputText(tool: AgentTool): string | undefined {
  if (tool.content?.length) {
    const texts = tool.content.flatMap((item) => {
      const text = contentText(item)
      return text === undefined ? [] : [text]
    })
    if (texts.length > 0) return texts.join('\n')
  }
  const raw = tool.rawOutput
  if (typeof raw === 'string') return raw || undefined
  if (Array.isArray(raw)) {
    const texts = raw.flatMap((block) => {
      const text = textOf(block)
      return text === undefined ? [] : [text]
    })
    return texts.length > 0 ? texts.join('\n') : undefined
  }
  return textOf(raw) ?? reportedText(raw)
}

/**
 * An edit or read's result reduced to its one-line message, never what was
 * written or read. Results can quote the file: Claude Code's NotebookEdit
 * answers `Updated cell <id> with <new_source>`, a failed Edit ends with
 * `String: <old_string>` inside `<tool_use_error>`, and older CLIs followed a
 * successful Edit or Write with a `cat -n` snippet. So the error wrapper goes,
 * a quoted `String:` is cut off, only the first line stays, and a cell message
 * stops before ` with `.
 */
export function pathToolMessage(text: string): string {
  let message = text.trim()
  const wrapped = /^<tool_use_error>([\s\S]*?)(?:<\/tool_use_error>)?$/.exec(message)
  if (wrapped) message = wrapped[1]!.trim()
  message = message.split(/\s*\bString:/)[0]!
  message = message.split('\n')[0]!.trim()
  const cell = /^((?:Updated|Inserted|Deleted|Replaced) cell \S+?) with\b/.exec(message)
  return cell ? cell[1]! : message
}

/**
 * What a tool shows as output. A path-only tool has none, unless it failed:
 * then the one line that says why, which carries no body.
 */
export function toolOutputText(
  tool: AgentTool,
  options: { pathOnly: boolean; failed: boolean },
): string | undefined {
  if (!options.pathOnly) return reportedOutputText(tool)
  if (!options.failed) return undefined
  const raw = report(tool.rawOutput)
  const text =
    typeof raw?.error === 'string' && raw.error
      ? raw.error
      : typeof tool.rawOutput === 'string'
        ? tool.rawOutput
        : reportedOutputText({
            ...tool,
            rawOutput: Array.isArray(tool.rawOutput) ? tool.rawOutput : undefined,
          })
  return text ? pathToolMessage(text) || undefined : undefined
}

/** The text of one content item, if it has any to show as output. */
export function contentText(item: ToolCallContent): string | undefined {
  if (item.type !== 'content') return undefined
  const block = item.content
  if (block.type === 'text') return block.text
  if (block.type === 'resource') return block.text
  return undefined
}

/**
 * The files a call names. Cursor's edit carries its path only in the diff of
 * the update that completes it, so a diff's path counts, and only its path.
 */
function toolLocations(tool: AgentTool): ToolLocation[] | undefined {
  const named = Array.isArray(tool.locations) ? tool.locations : []
  const kept = named.flatMap((location): ToolLocation[] => {
    const path = location?.path
    if (typeof path !== 'string' || !path) return []
    const line = location.line
    return [
      Number.isSafeInteger(line) && (line as number) >= 0
        ? { path, line: line as number }
        : { path },
    ]
  })
  for (const item of tool.content ?? []) {
    if (item.type === 'diff' && item.path && !kept.some((held) => held.path === item.path)) {
      kept.push({ path: item.path })
    }
  }
  return kept.length > 0 ? kept : undefined
}

/**
 * The provider's own name for the tool. Claude Code says so. Cursor marks some
 * tools with `rawInput._toolName`. OpenCode's first title is the tool's name,
 * one lowercase word, before later updates replace it with prose; Cursor's
 * unenriched `grep` looks the same and is its name too.
 */
function toolNameOf(tool: AgentTool, opens: boolean): string | undefined {
  if (typeof tool.toolName === 'string' && tool.toolName) return tool.toolName
  const marked = (tool.rawInput as { _toolName?: unknown } | undefined)?._toolName
  if (typeof marked === 'string' && marked) return marked
  return opens && tool.title && /^[a-z][a-z0-9_-]*$/.test(tool.title) ? tool.title : undefined
}

/**
 * Whether a report that says `completed` did not: Cursor has no `failed`
 * status, and says so with `rawOutput.error`, `rejected` or `permissionDenied`.
 */
function reportedOutcome(tool: AgentTool): ToolCallStatus | undefined {
  const raw = report(tool.rawOutput)
  if (!raw) return undefined
  if (raw.rejected === true || raw.permissionDenied === true) return 'declined'
  return typeof raw.error === 'string' && raw.error ? 'failed' : undefined
}

/**
 * Everything a tool event says about its call except output, in wire terms.
 * `kind` is the call's kind as far as is known (an update often omits it).
 */
export function toolFields(
  tool: AgentTool,
  options: { kind?: ToolKind; toolName?: string; opens: boolean; timestamp: string },
): Omit<ToolCallUpdate, 'toolCallId' | 'turnId' | 'output' | 'outputDelta' | 'outputBytes'> {
  const toolName = toolNameOf(tool, options.opens)
  const edit = isEdit(tool.kind ?? options.kind, toolName ?? options.toolName)
  const input = tool.rawInput === undefined ? undefined : stripBodies(tool.rawInput, edit)
  // An outcome only ever explains a call that did not complete.
  const outcome = tool.status === 'completed' ? undefined : tool.outcome
  const status: ToolCallStatus | undefined =
    outcome ?? (tool.status === 'completed' ? reportedOutcome(tool) : undefined) ?? tool.status
  const locations = toolLocations(tool)
  const lineChanges = tool.lineChanges
  return {
    ...(toolName ? { toolName } : {}),
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.kind ? { kind: tool.kind } : {}),
    ...(status ? { status } : {}),
    ...(input !== undefined ? { input: input as ToolCallUpdate['input'] } : {}),
    ...(locations ? { locations } : {}),
    ...(lineChanges &&
    Number.isSafeInteger(lineChanges.added) &&
    Number.isSafeInteger(lineChanges.removed) &&
    lineChanges.added >= 0 &&
    lineChanges.removed >= 0
      ? { lineChanges: { added: lineChanges.added, removed: lineChanges.removed } }
      : {}),
    ...(options.opens ? { startedAt: options.timestamp } : {}),
    ...(isSettledToolStatus(status) ? { finishedAt: options.timestamp } : {}),
  }
}

type TrackedCall = {
  /** A tool event went out for it; a call only declined has no row to settle. */
  seen: boolean
  kind?: ToolKind
  toolName?: string
  title?: string
  status?: ToolCallStatus
  declined: boolean
  /** What was last sent for each field, to leave out what would only repeat it. */
  sent: Map<string, string>
  /** The running text sent so far, as a length, a running digest and its UTF-8 size. */
  raw?: { length: number; digest: Hash; bytes: number }
  /** The whole text of a call that settled with one, until the environment takes it. */
  body?: string
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')
const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/**
 * What the environment remembers about one turn's tool calls while the turn
 * runs:
 *
 * - Running text. Providers report it by appending, or by sending the whole
 *   text again with every update (ACP's `content` replaces). A resend that
 *   extends what came before goes out as an `outputDelta` of the new part,
 *   with only the fields that changed, so the batcher can coalesce it;
 *   anything else replaces. Only a length and a digest are held for that.
 * - The text a call settles with, which goes to the environment's store and
 *   not into the event (`takeBody`).
 * - The call's kind and name, which later updates usually omit.
 * - Whether the user declined the call's permission, so the failure that
 *   follows reads as declined.
 */
export class ToolCallTracker {
  private readonly calls = new Map<string, TrackedCall>()

  private call(toolCallId: string): TrackedCall {
    let call = this.calls.get(toolCallId)
    if (!call) {
      call = { seen: false, declined: false, sent: new Map() }
      this.calls.set(toolCallId, call)
    }
    return call
  }

  has(toolCallId: string): boolean {
    return this.calls.has(toolCallId)
  }

  known(toolCallId: string): Pick<TrackedCall, 'kind' | 'toolName' | 'title'> {
    const call = this.calls.get(toolCallId)
    return { kind: call?.kind, toolName: call?.toolName, title: call?.title }
  }

  isDeclined(toolCallId: string): boolean {
    return this.calls.get(toolCallId)?.declined ?? false
  }

  /** The user refused this call. Whether a row exists to say so on. */
  decline(toolCallId: string): boolean {
    const call = this.call(toolCallId)
    call.declined = true
    const open = call.seen && !isSettledToolStatus(call.status)
    // Settled here, by the event this answer leads to: text after it has nowhere to go.
    if (open) call.status = 'declined'
    return open
  }

  /** Whether a tool event went out for this call, so a row exists to update. */
  isSeen(toolCallId: string): boolean {
    return this.calls.get(toolCallId)?.seen ?? false
  }

  /** The fields that say something new, for an update whose point is its text. */
  changed<T extends Record<string, unknown>>(toolCallId: string, fields: T): Partial<T> {
    const sent = this.calls.get(toolCallId)?.sent
    return Object.fromEntries(
      Object.entries(fields).filter(([key, value]) => sent?.get(key) !== JSON.stringify(value)),
    ) as Partial<T>
  }

  /** Record what was sent for a call. */
  observe(
    toolCallId: string,
    fields: { kind?: ToolKind; toolName?: string; title?: string; status?: ToolCallStatus },
  ): void {
    const call = this.call(toolCallId)
    call.seen = true
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) call.sent.set(key, JSON.stringify(value))
    }
    if (fields.kind) call.kind = fields.kind
    if (fields.toolName) call.toolName = fields.toolName
    if (fields.title !== undefined) call.title ??= fields.title
    if (fields.status && !isSettledToolStatus(call.status)) call.status = fields.status
  }

  /** The whole text as the provider now reports it, on a call still running. */
  replace(toolCallId: string, text: string): OutputFields {
    const call = this.call(toolCallId)
    // Running text ends with the call: a client would drop it, so nothing sends it.
    if (isSettledToolStatus(call.status)) return {}
    const raw = call.raw
    if (
      raw &&
      text.length >= raw.length &&
      sha1(text.slice(0, raw.length)) === raw.digest.copy().digest('hex')
    ) {
      const delta = text.slice(raw.length)
      if (!delta) return {}
      raw.digest.update(delta)
      raw.length = text.length
      raw.bytes += utf8Bytes(delta)
      return { outputDelta: delta }
    }
    call.raw = {
      length: text.length,
      digest: createHash('sha1').update(text),
      bytes: utf8Bytes(text),
    }
    return { output: text }
  }

  /** Text the provider appended to a call still running. */
  append(toolCallId: string, delta: string): OutputFields {
    if (!delta) return {}
    const call = this.call(toolCallId)
    if (isSettledToolStatus(call.status)) return {}
    call.raw ??= { length: 0, digest: createHash('sha1'), bytes: 0 }
    call.raw.digest.update(delta)
    call.raw.length += delta.length
    call.raw.bytes += utf8Bytes(delta)
    return { outputDelta: delta }
  }

  /** The text a call settles with: it replaces whatever ran before it, once. */
  settleWith(toolCallId: string, text: string): void {
    const call = this.call(toolCallId)
    // Settled text does not change. A call refused before it said anything can
    // still take the failure that follows, which is the first text it has.
    if (isSettledToolStatus(call.status) && call.raw?.bytes) return
    call.body = text
    call.raw = {
      length: text.length,
      digest: createHash('sha1').update(text),
      bytes: utf8Bytes(text),
    }
  }

  /** The bytes of output this call holds. */
  outputBytes(toolCallId: string): number {
    return this.calls.get(toolCallId)?.raw?.bytes ?? 0
  }

  /** The text a call settled with, once: the environment stores it beside the event. */
  takeBody(toolCallId: string): string | undefined {
    const call = this.calls.get(toolCallId)
    const body = call?.body
    if (call) call.body = undefined
    return body
  }
}
