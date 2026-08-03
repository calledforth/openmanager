import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AvailableCommand,
  ContentBlock,
  SubtaskUpdate,
  TokenUsage,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentpack/contract'
import type { SubtaskAdapter } from '../../backends/acp/extensions.js'
import type { BackendEvent, BackendRoute } from '../../backends/Backend.js'
import type { HostDeps } from '../../host.js'
import { number, object, routeEvent, string } from '../wire.js'
import {
  claudeToolContentFromInput,
  claudeToolKind,
  claudeToolLocations,
  claudeToolTitle,
  planUpdateFromTodoWrite,
} from './claude-tools.js'

/** What the runtime does with a translated message. `events` are forwarded
 * verbatim; `completed` is the turn-terminal *candidate* the runtime matches
 * against its active dispatch — the translator deliberately does not know
 * which turn is active, because "is this result mine?" is lifecycle state and
 * belongs with the state machine that owns it.
 *
 * `prompt_completed` is therefore emitted by the runtime and not here: a
 * result belonging to a subagent, or arriving late for a turn that already
 * settled, must not tell the UI the user's turn is over. `usage` rides along
 * with it because it is the same decision — the counts belong to the turn the
 * runtime decides this result ended, or to nobody. */
export type TranslatedMessage = {
  events: BackendEvent[]
  completed?: {
    sessionId: string
    stopReason?: string
    isError: boolean
    errorText?: string
    /** Did this turn end because somebody stopped it?
     *
     * Separate from `isError` because the SDK does not separate them: an
     * interrupt lands as a `result` whose subtype is an error like any other,
     * and the only thing distinguishing "the user pressed Stop" from "Claude
     * ran out of turns" is `terminal_reason`. Reporting the first as a failure
     * makes every cancelled job show up as broken. */
    interrupted: boolean
    usage?: TokenUsage
  }
}

/** One streaming content block, identified by its position in the *current*
 * assistant message.
 *
 * Positions are meaningless across messages — every `message_start` resets the
 * index space to zero — which is why this map is cleared per message and why
 * `tool_result` correlation never uses an index. */
type BlockState =
  | { kind: 'text'; streamed: boolean }
  | { kind: 'thinking' }
  | {
      kind: 'tool'
      toolUseId: string
      toolName: string
      /** Accumulated `input_json_delta` fragments. Only parsed, never shown. */
      json: string
      /** The accumulated string we last emitted an update for, so a buffer that
       * happens to parse on several successive fragments does not re-emit an
       * identical input. */
      emitted: string | undefined
    }
  | { kind: 'other' }

/** Mutable token counters, kept separate from the contract's `TokenUsage`
 * because a partially-accumulated turn has no meaningful `totalTokens` yet. */
type UsageAccumulator = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  seen: boolean
}

const emptyUsage = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  seen: false,
})

/** How many tool ids we remember names for. Purely a cap so a very long session
 * cannot grow the map without bound; a session never has thousands of tool
 * calls in flight, so eviction only ever touches long-settled entries. */
const MAX_TRACKED_TOOL_NAMES = 4096

export type ClaudeMessageTranslatorDeps = {
  route: () => BackendRoute
  log: Pick<HostDeps, 'log'>['log']
  /** The provider's subtask classifier, invoked exactly the way
   * `AcpSessionRuntimeImpl.subtaskFromTool` invokes it. Absent for a provider
   * that does not classify subtasks. */
  subtasks?: SubtaskAdapter
}

/** SDK messages in, `BackendEvent`s out.
 *
 * A class rather than a pure function because almost nothing Claude Code emits
 * is self-contained: partial tool-input JSON accumulated across
 * `input_json_delta`s, the content-block index -> block identity map that
 * `stream_event` positions are meaningless without, tool_use_id -> tool_result
 * correlation spanning assistant and user messages, and the subagent
 * (`parent_tool_use_id`) tree.
 *
 * State has three lifetimes here and confusing them is the bug class this
 * comment exists to prevent:
 * - MESSAGE-scoped (`blocks`, `thinkingTokens`): content-block indices restart
 *   at 0 on every `message_start`, so a map keyed by index must die with the
 *   message. Carrying it over makes index 0 of the next message inherit the
 *   previous message's identity — text deltas mistaken for tool JSON.
 * - TURN-scoped (`usage`, the drop counter): reset only when a *top-level*
 *   result lands, because that is the only frame meaning "the user's turn is
 *   over". A subagent result must not zero the user's token counts.
 * - SESSION-scoped (`toolNames`, `claimedSubtasks`, `contentFromInput`): a
 *   `tool_result` is correlated by `tool_use_id` and is not bounded by the
 *   message that opened the call, so those maps outlive both.
 *
 * The one rule that outranks everything else: NEVER throw on an unknown
 * message. `SDKMessage` is a 38-member union today and the CLI adds members in
 * point releases; a translator that throws turns a new informational banner
 * into a dead session. Unknown shapes are logged and dropped. */
export class ClaudeMessageTranslator {
  private readonly route: () => BackendRoute
  private readonly log: Pick<HostDeps, 'log'>['log']
  private readonly subtasks: SubtaskAdapter | undefined

  // -- message-scoped ------------------------------------------------------
  private blocks = new Map<number, BlockState>()
  /** Monotonic within a thinking run: `estimated_tokens` is a running total and
   * a repeated or re-ordered frame must not walk the counter backwards. */
  private thinkingTokens: number | undefined

  // -- turn-scoped ---------------------------------------------------------
  private usage = emptyUsage()
  /** Messages dropped because they belonged to a subagent. Counted rather than
   * silently discarded: without this the loss is invisible, and "the subagent's
   * work never appeared" is indistinguishable from "the subagent did nothing". */
  private droppedSubagentMessages = 0

  // -- session-scoped ------------------------------------------------------
  private readonly toolNames = new Map<string, string>()
  /** toolCallIds the subtask adapter has claimed. Mirrors
   * `AcpSessionRuntimeImpl.subtaskToolIds`: a claimed id never emits a raw tool
   * event again, so a later status-only update still lands on the subtask row. */
  private readonly claimedSubtasks = new Set<string>()
  /** Tool ids whose renderable content was already derived from their input, so
   * a `tool_result` does not overwrite an accurate diff with raw output text —
   * the projector and the renderer both REPLACE `content` wholesale. */
  private readonly contentFromInput = new Set<string>()

  constructor(deps: ClaudeMessageTranslatorDeps) {
    this.route = deps.route
    this.log = deps.log
    this.subtasks = deps.subtasks
  }

  translate(message: SDKMessage): TranslatedMessage {
    try {
      return this.dispatch(message)
    } catch (error) {
      // A malformed frame must cost one message, not the session. The runtime
      // keeps pumping and the turn still settles on its `result`.
      this.log({
        scope: 'claude',
        level: 'warn',
        message: 'Claude message translation failed',
        // `object()` rather than a property read: the handler must survive a
        // null or primitive frame too, or the never-throw rule fails in the one
        // place it exists to hold.
        data: { type: object(message).type, error: `${error}` },
      })
      return { events: [] }
    }
  }

  private dispatch(message: SDKMessage): TranslatedMessage {
    const parent = string(object(message).parent_tool_use_id)
    // Everything a subagent produces is dropped in v1. Without this, a Task's
    // inner assistant text and its inner tool calls render as top-level
    // activity: the user sees tools they never asked for interleaved with the
    // main agent's, and the subagent's prose appears as the main agent's
    // answer. What survives is only the signal keeping the parent `Task` row
    // alive, which is the one place that work is legitimately visible.
    if (parent) return { events: this.subagentSignal(message, parent) }

    switch (message.type) {
      case 'stream_event':
        return { events: this.streamEvent(message) }
      case 'assistant':
        return { events: this.assistantSnapshot(message) }
      case 'user':
        return { events: this.userMessage(message) }
      case 'system':
        return { events: this.systemMessage(message) }
      case 'result':
        return this.result(message)
      default:
        // Members of the union carrying nothing the contract can express —
        // status banners, hook frames, task notifications, plugin installs.
        // Logged at info rather than warn: they are expected traffic, and a
        // warning per frame would bury the ones that matter.
        this.log({
          scope: 'claude',
          level: 'info',
          message: `[sdk] <- ${message.type}`,
          data: { subtype: string(object(message).subtype) },
        })
        return { events: [] }
    }
  }

  // ------------------------------------------------------------------ stream

  /** The raw Anthropic streaming envelope.
   *
   * The same `content_block_delta` frame delivers assistant prose, thinking,
   * tool-input JSON and citations depending on the delta's own `type`, and the
   * `index` identifying which block it belongs to is only meaningful against
   * the map built by `content_block_start`. */
  private streamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>): BackendEvent[] {
    const event = object(message.event)
    const sessionId = message.session_id
    switch (string(event.type)) {
      case 'message_start':
        this.blocks.clear()
        return []
      case 'content_block_start':
        return this.blockStart(sessionId, number(event.index) ?? 0, object(event.content_block))
      case 'content_block_delta':
        return this.blockDelta(sessionId, number(event.index) ?? 0, object(event.delta))
      case 'content_block_stop':
        return this.blockStop(sessionId, number(event.index) ?? 0)
      case 'message_delta':
        this.accumulateUsage(object(event.usage))
        return []
      default:
        return []
    }
  }

  private blockStart(
    sessionId: string,
    index: number,
    block: Record<string, unknown>,
  ): BackendEvent[] {
    const type = string(block.type)
    if (type === 'text') {
      this.blocks.set(index, { kind: 'text', streamed: false })
      return []
    }
    if (type === 'thinking' || type === 'redacted_thinking') {
      this.blocks.set(index, { kind: 'thinking' })
      this.thinkingTokens = undefined
      // The block's existence is the whole signal. Claude Code's thinking text
      // is live-verified empty on every model, so `start` is what opens the
      // "Thinking..." indicator that `stop` later closes — nothing else can.
      return [
        routeEvent(this.route(), sessionId, 'stream', 'agent_thought_chunk', { phase: 'start' }),
      ]
    }
    // `server_tool_use` (web search) and `mcp_tool_use` are ordinary tool calls
    // that happen to execute somewhere else. The contract has no way to say
    // "ran remotely" and the user does not care where a search ran.
    if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
      const toolUseId = string(block.id) ?? ''
      const toolName = string(block.name) ?? 'tool'
      this.blocks.set(index, { kind: 'tool', toolUseId, toolName, json: '', emitted: undefined })
      if (!toolUseId) return []
      this.rememberToolName(toolUseId, toolName)
      // `input` is `{}` here for every streamed tool call — the arguments
      // arrive as `input_json_delta` fragments — so this row opens with a name
      // and nothing else, and the input lands on the first update that parses.
      const call: ToolCall = {
        toolCallId: toolUseId,
        title: claudeToolTitle(toolName),
        kind: claudeToolKind(toolName),
        status: 'pending',
        rawInput: object(block.input),
      }
      return [this.toolEvent(sessionId, call, 'call')]
    }
    this.blocks.set(index, { kind: 'other' })
    return []
  }

  private blockDelta(
    sessionId: string,
    index: number,
    delta: Record<string, unknown>,
  ): BackendEvent[] {
    const type = string(delta.type)
    if (type === 'text_delta') {
      const block = this.blocks.get(index)
      if (block?.kind === 'text') block.streamed = true
      const text = string(delta.text)
      if (!text) return []
      return [
        routeEvent(this.route(), sessionId, 'stream', 'agent_message_chunk', {
          content: { type: 'text', text },
        }),
      ]
    }

    if (type === 'thinking_delta') {
      // NEVER `delta.thinking`. It is the empty string on every model and every
      // frame — the real payload is the encrypted `signature` blob, which
      // exists for API round-tripping and is not renderable text. Emitting it
      // produces blank reasoning rows: the renderer drops whitespace-only
      // buffers, so the UI freezes silently for the seconds the model thinks.
      const incoming = number(delta.estimated_tokens)
      if (incoming === undefined) return []
      this.thinkingTokens = Math.max(this.thinkingTokens ?? 0, incoming)
      return [
        routeEvent(this.route(), sessionId, 'stream', 'agent_thought_chunk', {
          phase: 'delta',
          tokens: this.thinkingTokens,
        }),
      ]
    }

    if (type === 'input_json_delta') {
      const block = this.blocks.get(index)
      if (block?.kind !== 'tool') return []
      block.json += string(delta.partial_json) ?? ''
      // Nothing is emitted until the WHOLE accumulated string parses. A partial
      // fragment is not "the input so far" — it is a truncated object whose
      // last value is half-typed, and shipping it makes the row flicker through
      // states the model never asked for.
      const parsed = parseJson(block.json)
      if (parsed === undefined) return []
      if (block.emitted === block.json) return []
      block.emitted = block.json
      return this.toolInputResolved(sessionId, block.toolUseId, block.toolName, parsed)
    }

    // `signature_delta` and `citations_delta` deliberately fall through: the
    // signature is an encrypted blob and citations have no contract shape.
    return []
  }

  private blockStop(sessionId: string, index: number): BackendEvent[] {
    const block = this.blocks.get(index)
    // A tool block stopping means its ARGUMENTS are complete, not the tool. The
    // call finishes when its `tool_result` arrives, possibly seconds later;
    // completing it here would show every tool as done the instant it started.
    if (block?.kind !== 'thinking') return []
    return [
      routeEvent(this.route(), sessionId, 'stream', 'agent_thought_chunk', {
        phase: 'stop',
        ...(this.thinkingTokens !== undefined ? { tokens: this.thinkingTokens } : {}),
      }),
    ]
  }

  /** The tool's arguments finally parsed. This — not `content_block_start` — is
   * where everything derived from the input is emitted, because the input is
   * empty at start. */
  private toolInputResolved(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: unknown,
  ): BackendEvent[] {
    const content = claudeToolContentFromInput(toolName, input)
    if (content) this.contentFromInput.add(toolUseId)
    const locations = claudeToolLocations(input)
    const update: ToolCallUpdate = {
      toolCallId: toolUseId,
      title: claudeToolTitle(toolName),
      kind: claudeToolKind(toolName),
      status: 'in_progress',
      rawInput: input,
      ...(content ? { content } : {}),
      ...(locations ? { locations } : {}),
    }
    const events = [this.toolEvent(sessionId, update, 'update')]
    // TodoWrite is Claude Code's plan surface: its input IS the plan, re-sent
    // in full every time, so the tool row and the checklist are two views of
    // the same call and both are emitted.
    if (toolName === 'TodoWrite') {
      const plan = planUpdateFromTodoWrite(input)
      if (plan) events.push(routeEvent(this.route(), sessionId, 'session', 'plan_update', plan))
    }
    return events
  }

  // --------------------------------------------------------------- snapshots

  /** The finished assistant message, which arrives after its deltas.
   *
   * Its only job here is backfill. Text that streamed needs nothing — it is
   * already on screen and re-emitting would duplicate the paragraph — but a
   * text block that produced no delta at all (a cached completion, an
   * interrupted stream, a build with partial messages disabled) would otherwise
   * never be shown at all. Positional, because the snapshot's content array is
   * in the same order as the block indices that produced it. */
  private assistantSnapshot(message: Extract<SDKMessage, { type: 'assistant' }>): BackendEvent[] {
    const content = object(message.message).content
    const blocks = Array.isArray(content) ? content : []
    const events: BackendEvent[] = []
    blocks.forEach((raw, index) => {
      const block = object(raw)
      if (string(block.type) !== 'text') return
      const streaming = this.blocks.get(index)
      if (streaming?.kind === 'text' && streaming.streamed) return
      const text = string(block.text)
      if (!text) return
      events.push(
        routeEvent(this.route(), message.session_id, 'stream', 'agent_message_chunk', {
          messageId: message.uuid,
          content: { type: 'text', text },
        }),
      )
    })
    // The message is over; its index space dies with it.
    this.blocks.clear()
    return events
  }

  /** A `user` frame is almost never the user. The CLI reports tool outcomes by
   * synthesizing a user message whose content blocks are `tool_result`s, and
   * that is the only place a tool's result is ever reported. */
  private userMessage(message: Extract<SDKMessage, { type: 'user' }>): BackendEvent[] {
    const content = object(message.message).content
    if (!Array.isArray(content)) return []
    const events: BackendEvent[] = []
    for (const raw of content) {
      const block = object(raw)
      if (string(block.type) !== 'tool_result') continue
      // BY ID, never by position. Results arrive out of order relative to the
      // calls (a fast Read answers while a slow Bash is still running) and
      // several may share one user message, so a stream index here would
      // attribute one tool's output to another tool's row.
      const toolUseId = string(block.tool_use_id)
      if (!toolUseId) continue
      const failed = block.is_error === true
      const resultContent = this.contentFromInput.has(toolUseId)
        ? undefined
        : toolResultContent(block.content)
      const update: ToolCallUpdate = {
        toolCallId: toolUseId,
        status: failed ? 'failed' : 'completed',
        rawOutput: block.content,
        // Content is supplied only when the input produced none. `content` is
        // replaced wholesale downstream, so publishing result text for an Edit
        // would discard the diff that call already emitted.
        ...(resultContent ? { content: resultContent } : {}),
      }
      // `SDKUserMessage.session_id` is optional in the SDK's own types, unlike
      // every other frame's. Undefined routes the event without one rather than
      // dropping a tool's only completion signal.
      events.push(this.toolEvent(string(message.session_id), update, 'update'))
    }
    return events
  }

  // ----------------------------------------------------------------- system

  private systemMessage(message: Extract<SDKMessage, { type: 'system' }>): BackendEvent[] {
    const raw = object(message)
    switch (message.subtype) {
      case 'commands_changed': {
        const commands = Array.isArray(raw.commands) ? raw.commands : []
        const availableCommands = commands.flatMap((value): AvailableCommand[] => {
          const command = object(value)
          const name = string(command.name)
          if (!name) return []
          const hint = string(command.argumentHint)
          return [
            {
              name,
              description: string(command.description) ?? '',
              ...(hint ? { input: { type: 'unstructured' as const, placeholder: hint } } : {}),
            },
          ]
        })
        return [
          routeEvent(this.route(), message.session_id, 'session', 'available_commands_update', {
            availableCommands,
          }),
        ]
      }
      case 'api_retry':
        // Recoverable by construction: the CLI is retrying and the turn is
        // still alive. Reporting it as a plain error would show a failure for a
        // request that then succeeds.
        return [
          routeEvent(this.route(), message.session_id, 'error', 'rpc_error', {
            source: 'claude/api',
            message: `Retrying after ${string(raw.error) ?? 'an API error'} (attempt ${
              number(raw.attempt) ?? 0
            }/${number(raw.max_retries) ?? 0})`,
            recoverable: true,
            ...(number(raw.error_status) !== undefined ? { code: number(raw.error_status) } : {}),
          }),
        ]
      case 'compact_boundary': {
        // Deliberately NOT a `usage_update`. `SessionUsage` is occupancy —
        // `{used, size}` — and a compaction reports `pre_tokens`/`post_tokens`
        // with no context size at all. Publishing `used` against an unknown or
        // stale `size` draws a meter at an invented percentage. Real occupancy
        // comes from `getContextUsage()`, which the runtime asks for directly.
        const metadata = object(raw.compact_metadata)
        this.log({
          scope: 'claude',
          level: 'info',
          message: 'Claude Code compacted the conversation',
          data: {
            trigger: string(metadata.trigger),
            preTokens: number(metadata.pre_tokens),
            postTokens: number(metadata.post_tokens),
          },
        })
        return []
      }
      case 'permission_denied': {
        // The auto-deny short circuit: a deny rule, `dontAsk`, or the auto-mode
        // classifier refused the tool without ever reaching `canUseTool`, so
        // nothing else will ever complete this row.
        const toolUseId = string(raw.tool_use_id)
        if (!toolUseId) return []
        const toolName = string(raw.tool_name)
        const update: ToolCallUpdate = {
          toolCallId: toolUseId,
          status: 'failed',
          ...(toolName ? { title: claudeToolTitle(toolName) } : {}),
        }
        return [this.toolEvent(message.session_id, update, 'update')]
      }
      default:
        this.log({
          scope: 'claude',
          level: 'info',
          message: `[sdk] <- system/${message.subtype}`,
        })
        return []
    }
  }

  // ----------------------------------------------------------------- result

  private result(message: Extract<SDKMessage, { type: 'result' }>): TranslatedMessage {
    const usage = this.settleTurnUsage(message)
    return {
      events: [],
      completed: {
        sessionId: message.session_id,
        ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
        isError: message.is_error === true || message.subtype !== 'success',
        interrupted: isInterrupted(message),
        ...(message.subtype === 'success'
          ? {}
          : { errorText: message.errors?.join('; ') || message.subtype }),
        ...(usage ? { usage } : {}),
      },
    }
  }

  /** Close the turn's books and reset the turn-scoped state.
   *
   * Only top-level results reach here — subagent frames were dropped upstream —
   * so what resets is exactly what belongs to the user's turn. */
  private settleTurnUsage(
    message: Extract<SDKMessage, { type: 'result' }>,
  ): TokenUsage | undefined {
    if (this.droppedSubagentMessages > 0) {
      this.log({
        scope: 'claude',
        level: 'info',
        message: 'Dropped subagent messages during this turn',
        data: { count: this.droppedSubagentMessages, sessionId: message.session_id },
      })
      this.droppedSubagentMessages = 0
    }
    const accumulated = this.usage
    this.usage = emptyUsage()
    this.thinkingTokens = undefined
    // The result's own `usage` is a fallback, not the primary source: a
    // streamed turn reports its tokens through `message_delta` and folding both
    // would double count. It matters for turns that stream nothing at all (a
    // refusal, an interrupt) and for builds with partial messages disabled.
    if (!accumulated.seen) {
      const fallback = usageFrom(object(object(message).usage))
      return fallback.seen ? toTokenUsage(fallback) : undefined
    }
    return toTokenUsage(accumulated)
  }

  private accumulateUsage(raw: Record<string, unknown>): void {
    const delta = usageFrom(raw)
    if (!delta.seen) return
    this.usage.input += delta.input
    this.usage.output += delta.output
    this.usage.cacheRead += delta.cacheRead
    this.usage.cacheWrite += delta.cacheWrite
    this.usage.seen = true
  }

  // --------------------------------------------------------------- subagents

  /** What survives from a dropped subagent frame.
   *
   * Everything a subagent emits is suppressed as top-level activity, but the
   * parent `Task` row is a legitimate home for it, and a row that never changes
   * reads as a hung task. So an inner assistant snapshot contributes a one-line
   * `currentActivity` and a running tool count, and nothing else crosses over.
   * Per-token deltas are dropped without comment — they would be one subtask
   * update per token. */
  private subagentSignal(message: SDKMessage, parentToolUseId: string): BackendEvent[] {
    this.droppedSubagentMessages += 1
    if (message.type !== 'assistant') return []
    const sessionId = string((message as { session_id?: unknown }).session_id)
    if (!sessionId) return []
    const content = object(object(message).message).content
    const blocks = Array.isArray(content) ? content : []
    let activity: string | undefined
    let toolCallCount = 0
    for (const raw of blocks) {
      const block = object(raw)
      const type = string(block.type)
      if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
        toolCallCount += 1
        activity ??= string(block.name)
        continue
      }
      if (type === 'text' && activity === undefined) {
        const text = string(block.text)?.trim().split('\n')[0]
        if (text) activity = text.length > 120 ? `${text.slice(0, 117)}...` : text
      }
    }
    if (activity === undefined && toolCallCount === 0) return []
    const update: SubtaskUpdate = {
      taskId: parentToolUseId,
      status: 'running',
      statusSource: 'task_event',
      ...(activity !== undefined ? { currentActivity: activity } : {}),
      ...(toolCallCount > 0 ? { toolCallCount } : {}),
    }
    return [routeEvent(this.route(), sessionId, 'session', 'subtask_update', update)]
  }

  // ----------------------------------------------------------------- helpers

  /** Route a tool event through the provider's subtask classifier, exactly as
   * `AcpSessionRuntimeImpl.subtaskFromTool` does. A claimed toolCallId never
   * emits a raw tool event again, so a `Task`'s later status-only update lands
   * on the subtask row instead of resurrecting a tool row beside it. */
  private toolEvent(
    sessionId: string | undefined,
    tool: ToolCall | ToolCallUpdate,
    phase: 'call' | 'update',
  ): BackendEvent {
    const subtask = this.subtaskFromTool(tool, phase)
    return subtask
      ? routeEvent(this.route(), sessionId, 'session', 'subtask_update', subtask)
      : routeEvent(
          this.route(),
          sessionId,
          'tool',
          phase === 'call' ? 'tool_call' : 'tool_call_update',
          tool,
        )
  }

  private subtaskFromTool(
    tool: ToolCall | ToolCallUpdate,
    phase: 'call' | 'update',
  ): SubtaskUpdate | undefined {
    const fromToolCall = this.subtasks?.fromToolCall
    if (!fromToolCall || !tool.toolCallId) return undefined
    const tracked = this.claimedSubtasks.has(tool.toolCallId)
    // A `tool_result` update carries no title, so the classifier is handed the
    // name recorded when the call opened. Without it a claimed Task's
    // completion would arrive unidentifiable and fall back to a tool row.
    const title = tool.title ?? this.toolNames.get(tool.toolCallId)
    const named: ToolCallUpdate = { ...tool, ...(title ? { title } : {}) }
    const update = fromToolCall(named, { phase, tracked })
    if (!update) return undefined
    this.claimedSubtasks.add(tool.toolCallId)
    return update.status
      ? { ...update, statusSource: update.statusSource ?? 'task_event' }
      : update
  }

  private rememberToolName(toolUseId: string, toolName: string): void {
    if (this.toolNames.size >= MAX_TRACKED_TOOL_NAMES) {
      const oldest = this.toolNames.keys().next()
      if (!oldest.done) this.toolNames.delete(oldest.value)
    }
    this.toolNames.set(toolUseId, toolName)
  }
}

/** `undefined` for anything that is not a complete JSON value, which is the
 * caller's signal to keep accumulating. A truncated object throws in here,
 * which is exactly how "still partial" is detected. */
function parseJson(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Did somebody stop this turn, as opposed to it failing?
 *
 * `terminal_reason` is the authoritative signal — `aborted_streaming` and
 * `aborted_tools` are the two the SDK raises for an abort, and they arrive on a
 * result whose subtype is an ordinary error. `stop_reason` is checked as well
 * because it is the field the ACP providers populate for the same situation and
 * because an older CLI may send no `terminal_reason` at all; the cost of the
 * extra test is a turn that was going to be reported as cancelled either way. */
function isInterrupted(message: Extract<SDKMessage, { type: 'result' }>): boolean {
  const terminalReason = string(object(message).terminal_reason)
  if (terminalReason === 'aborted_streaming' || terminalReason === 'aborted_tools') return true
  return /abort|cancel|interrupt/i.test(message.stop_reason ?? '')
}

/** Anthropic usage as it appears on `message_delta` and on the result. Cache
 * tokens count as input because that is what they are — the same prompt, billed
 * differently — and are also reported separately so a UI can show the saving. */
function usageFrom(raw: Record<string, unknown>): UsageAccumulator {
  const input = number(raw.input_tokens)
  const output = number(raw.output_tokens)
  const cacheWrite = number(raw.cache_creation_input_tokens)
  const cacheRead = number(raw.cache_read_input_tokens)
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheWrite: cacheWrite ?? 0,
    cacheRead: cacheRead ?? 0,
    seen:
      input !== undefined ||
      output !== undefined ||
      cacheWrite !== undefined ||
      cacheRead !== undefined,
  }
}

function toTokenUsage(usage: UsageAccumulator): TokenUsage {
  const inputTokens = usage.input + usage.cacheWrite + usage.cacheRead
  return {
    totalTokens: inputTokens + usage.output,
    inputTokens,
    outputTokens: usage.output,
    ...(usage.cacheRead ? { cachedReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cachedWriteTokens: usage.cacheWrite } : {}),
  }
}

/** A tool result's model-visible content, as renderable blocks. Strings become
 * one text block; the array form is mapped block by block so an image result (a
 * screenshot, a rendered chart) survives instead of being stringified. */
function toolResultContent(content: unknown): ToolCallContent[] | undefined {
  if (typeof content === 'string')
    return content ? [{ type: 'content', content: { type: 'text', text: content } }] : undefined
  if (!Array.isArray(content)) return undefined
  const items = content.flatMap((raw): ToolCallContent[] => {
    const block = object(raw)
    const type = string(block.type)
    if (type === 'text') {
      const text = string(block.text)
      return text ? [{ type: 'content', content: { type: 'text', text } }] : []
    }
    if (type === 'image') {
      const source = object(block.source)
      const data = string(source.data)
      if (!data) return []
      const image: ContentBlock = {
        type: 'image',
        mimeType: string(source.media_type) ?? 'application/octet-stream',
        data,
      }
      return [{ type: 'content', content: image }]
    }
    return []
  })
  return items.length > 0 ? items : undefined
}
