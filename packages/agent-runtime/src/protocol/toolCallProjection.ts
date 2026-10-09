import { createHash, type Hash } from 'node:crypto'
import type {
  ToolCall,
  ToolCallContent,
  ToolCallUpdate as AgentToolCallUpdate,
} from '@agentpack/contract'
import {
  TOOL_LOCATION_PATH_MAX_LENGTH,
  TOOL_LOCATIONS_MAX,
  TOOL_NAME_MAX_LENGTH,
  TOOL_OUTPUT_MAX_BYTES,
  appendToolOutput,
  boundToolInput,
  boundToolOutput,
  isTerminalToolStatus,
  jsonStringBytes,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolLocation,
  type ToolOutput,
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
    if (edit && EDIT_BODY_KEYS.has(key)) continue
    if (PATCH_BODY_KEYS.has(key) && (edit || typeof item === 'string')) continue
    kept[key] = item && typeof item === 'object' ? stripBodies(item, edit) : item
  }
  return kept
}

export const isEdit = (kind: ToolKind | undefined, toolName: string | undefined) =>
  kind === 'edit' || (toolName !== undefined && EDIT_TOOL_NAMES.has(toolName))

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  const block = value as { type?: unknown; text?: unknown }
  return block.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/**
 * A provider-shaped raw output's text: `{ output }` on success or `{ error }`
 * on failure, the shape OpenCode reports with its `metadata` beside it. The
 * metadata (which can hold a diff) is never read.
 */
function reportedText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const report = value as { output?: unknown; error?: unknown }
  if (typeof report.output === 'string' && report.output) return report.output
  if (typeof report.error === 'string' && report.error) return report.error
  return undefined
}

/**
 * The output a tool update reports, as text, whole (a replacement of what
 * came before). Text and embedded-resource content first; for a tool with no
 * such content, a raw output that is text (Claude Code's tool result: a string
 * or a list of text blocks) or a report's `output` or `error` string. Images
 * are left out: the environment moves them into the reply. Diffs and terminals
 * are left out: chat carries no diff, and a terminal is only a handle. An
 * edit's own content is its body, never output.
 */
export function toolOutputText(tool: AgentTool, edit: boolean): string | undefined {
  const text = reportedOutputText(tool, edit)
  // An edit's result can quote what it wrote; only its message line is kept.
  return edit && text !== undefined ? editResultMessage(text) || undefined : text
}

/**
 * An edit tool's result reduced to its one-line message, never what was
 * written. Results can quote the edit: Claude Code's NotebookEdit answers
 * `Updated cell <id> with <new_source>`, a failed Edit ends with
 * `String: <old_string>` inside `<tool_use_error>`, and older CLIs followed a
 * successful Edit or Write with a `cat -n` snippet. So the error wrapper goes,
 * a quoted `String:` is cut off, only the first line stays, and a cell message
 * stops before ` with `.
 */
export function editResultMessage(text: string): string {
  let message = text.trim()
  const wrapped = /^<tool_use_error>([\s\S]*?)(?:<\/tool_use_error>)?$/.exec(message)
  if (wrapped) message = wrapped[1]!.trim()
  message = message.split(/\s*\bString:/)[0]!
  message = message.split('\n')[0]!.trim()
  const cell = /^((?:Updated|Inserted|Deleted|Replaced) cell \S+?) with\b/.exec(message)
  return cell ? cell[1]! : message
}

function reportedOutputText(tool: AgentTool, edit: boolean): string | undefined {
  if (!edit && tool.content?.length) {
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

/** The text of one content item, if it has any to show as output. */
export function contentText(item: ToolCallContent): string | undefined {
  if (item.type !== 'content') return undefined
  const block = item.content
  if (block.type === 'text') return block.text
  if (block.type === 'resource') return block.text
  return undefined
}

function boundLocations(locations: AgentTool['locations']): ToolLocation[] | undefined {
  if (!Array.isArray(locations)) return undefined
  const kept = locations.flatMap((location): ToolLocation[] => {
    const path = location?.path
    if (typeof path !== 'string' || !path || path.length > TOOL_LOCATION_PATH_MAX_LENGTH) return []
    const line = location.line
    return [
      Number.isSafeInteger(line) && (line as number) >= 0
        ? { path, line: line as number }
        : { path },
    ]
  })
  return kept.length > 0 ? kept.slice(0, TOOL_LOCATIONS_MAX) : undefined
}

/**
 * Everything a tool event says about its call except output, in wire terms.
 * `kind` is the call's kind as far as is known (an update often omits it).
 */
export function toolFields(
  tool: AgentTool,
  options: { kind?: ToolKind; opens: boolean; timestamp: string },
): Omit<ToolCallUpdate, 'toolCallId' | 'turnId' | 'output' | 'outputDelta'> {
  const toolName =
    typeof tool.toolName === 'string' && tool.toolName.length > 0
      ? tool.toolName.slice(0, TOOL_NAME_MAX_LENGTH)
      : undefined
  const edit = isEdit(tool.kind ?? options.kind, toolName)
  const input =
    tool.rawInput === undefined ? undefined : boundToolInput(stripBodies(tool.rawInput, edit))
  // An outcome only ever explains a call that did not complete.
  const status: ToolCallStatus | undefined =
    tool.outcome && tool.status !== 'completed' ? tool.outcome : tool.status
  const locations = boundLocations(tool.locations)
  const lineChanges = tool.lineChanges
  return {
    ...(toolName ? { toolName } : {}),
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.kind ? { kind: tool.kind } : {}),
    ...(status ? { status } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(locations ? { locations } : {}),
    ...(lineChanges &&
    Number.isSafeInteger(lineChanges.added) &&
    Number.isSafeInteger(lineChanges.removed) &&
    lineChanges.added >= 0 &&
    lineChanges.removed >= 0
      ? { lineChanges: { added: lineChanges.added, removed: lineChanges.removed } }
      : {}),
    ...(options.opens ? { startedAt: options.timestamp } : {}),
    ...(status && isTerminalToolStatus(status) ? { finishedAt: options.timestamp } : {}),
  }
}

/** A delta small enough to travel as one; larger ones go out as the whole bounded output. */
const fitsAsDelta = (delta: string) => jsonStringBytes(delta) <= TOOL_OUTPUT_MAX_BYTES

/** Output fields with no memory of earlier updates: every update replaces. */
export function statelessOutput(text: string | undefined): OutputFields {
  return text ? { output: boundToolOutput(text) } : {}
}

/** An appended delta with no memory: a huge one keeps its newest end. */
export function statelessDelta(delta: string): OutputFields {
  if (!delta) return {}
  if (fitsAsDelta(delta)) return { outputDelta: delta }
  const bounded = boundToolOutput(delta)
  return { outputDelta: bounded.tail ?? bounded.text }
}

type TrackedCall = {
  /** A tool event went out for it; a call only declined has no row to settle. */
  seen: boolean
  kind?: ToolKind
  status?: ToolCallStatus
  declined: boolean
  output?: ToolOutput
  /** The raw output received so far, as a length and a running digest. */
  raw?: { length: number; digest: Hash }
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')

/**
 * What the environment remembers about one turn's tool calls while the turn
 * runs, so their events can stream:
 *
 * - Output. Providers report output either as appended content or by sending
 *   the whole output again with every update (ACP's `content` replaces). A
 *   resend that extends what came before goes out as an `outputDelta` of the
 *   new part only; anything else replaces the output. The bounded output is
 *   kept so a delta too large for one event can go out as the whole instead.
 * - The call's kind, which later updates usually omit.
 * - Whether the user declined the call's permission, so the failure that
 *   follows reads as declined.
 * - Which calls are still open, so the end of the turn can settle them.
 */
export class ToolCallTracker {
  private readonly calls = new Map<string, TrackedCall>()

  private call(toolCallId: string): TrackedCall {
    let call = this.calls.get(toolCallId)
    if (!call) {
      call = { seen: false, declined: false }
      this.calls.set(toolCallId, call)
    }
    return call
  }

  has(toolCallId: string): boolean {
    return this.calls.has(toolCallId)
  }

  kindOf(toolCallId: string): ToolKind | undefined {
    return this.calls.get(toolCallId)?.kind
  }

  isDeclined(toolCallId: string): boolean {
    return this.calls.get(toolCallId)?.declined ?? false
  }

  /** The user refused this call's permission. */
  decline(toolCallId: string): void {
    this.call(toolCallId).declined = true
  }

  /** Record what was sent for a call. */
  observe(toolCallId: string, fields: { kind?: ToolKind; status?: ToolCallStatus }): void {
    const call = this.call(toolCallId)
    call.seen = true
    if (fields.kind) call.kind = fields.kind
    if (fields.status && !isTerminalToolStatus(call.status)) call.status = fields.status
  }

  /** The whole output as the provider now reports it. */
  replace(toolCallId: string, text: string): OutputFields {
    const call = this.call(toolCallId)
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
      return this.appended(call, delta)
    }
    call.raw = { length: text.length, digest: createHash('sha1').update(text) }
    call.output = boundToolOutput(text)
    return { output: call.output }
  }

  /** Output the provider appended. */
  append(toolCallId: string, delta: string): OutputFields {
    if (!delta) return {}
    const call = this.call(toolCallId)
    call.raw ??= { length: 0, digest: createHash('sha1') }
    call.raw.digest.update(delta)
    call.raw.length += delta.length
    return this.appended(call, delta)
  }

  private appended(call: TrackedCall, delta: string): OutputFields {
    call.output = appendToolOutput(call.output, delta)
    return fitsAsDelta(delta) ? { outputDelta: delta } : { output: call.output }
  }

  /**
   * Close every call still open when the turn ends: declined if the user
   * refused it, cancelled otherwise. Returns what each now is.
   */
  settle(): Array<{ toolCallId: string; status: 'declined' | 'cancelled' }> {
    const settled: Array<{ toolCallId: string; status: 'declined' | 'cancelled' }> = []
    for (const [toolCallId, call] of this.calls) {
      if (!call.seen || isTerminalToolStatus(call.status)) continue
      const status = call.declined ? 'declined' : 'cancelled'
      call.status = status
      settled.push({ toolCallId, status })
    }
    return settled
  }
}
