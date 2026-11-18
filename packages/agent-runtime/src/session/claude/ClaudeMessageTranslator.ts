import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AvailableCommand,
  ContentBlock,
  ProviderNotice,
  ProviderProblem,
  SubtaskStatus,
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
  claudeAnsweredInput,
  claudeToolContentFromInput,
  claudeToolKind,
  claudeToolLocations,
  claudeToolResultExtras,
  claudeToolTitle,
  planUpdateFromTodoWrite,
  subtaskFromAgentOutput,
} from './claude-tools.js'
import { claudeTaskKind } from './claude-background.js'
import {
  classifyClaudeFailure,
  compactionNotice,
  informationalNotice,
  notificationNotice,
  providerDetail,
  recoveredErrorNotice,
  refusalFallbackNotice,
  refusalNotice,
  retryProblem,
  usageWarningNotice,
  type ClaudeRateLimit,
} from './claude-problems.js'
import { claudeUsageObservation } from './claude-usage-limits.js'

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
    /** Why a failed turn failed, typed. Absent unless `isError` and not
     * `interrupted`. */
    problem?: ProviderProblem
  }
}

/** One streaming content block, identified by its position in the *current*
 * assistant message.
 *
 * Positions are meaningless across messages — every `message_start` resets the
 * index space to zero — which is why this map is cleared per message and why
 * `tool_result` correlation never uses an index. */
type BlockState =
  | {
      kind: 'text'
      /** Every `text_delta` so far, so the `assistant` frame's copy of this
       * block can be recognised by content rather than by position. */
      text: string
      /** An `assistant` frame already accounted for this block. */
      matched: boolean
    }
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

/** What the translator knows about one subagent, by its `taskId` (the id of
 * the `Agent` call that started it). */
type SubagentRecord = {
  taskId: string
  depth: number
  /** The subagent whose transcript holds the call that started this one. */
  parentTaskId?: string
  /** Claude Code's own id for it, from `task_started` or the call's result. */
  agentId?: string
  background: boolean
  /** The current run ended on a task frame. The `Agent` call's result can
   * arrive after that, and must not overwrite how the run ended. */
  settled: boolean
  /** The current run already reported its answer. */
  answered: boolean
}

const SETTLED: ReadonlySet<SubtaskStatus> = new Set(['completed', 'failed', 'cancelled'])

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
  /** Whether a turn is open. Absent means one always is. */
  turnOpen?: () => boolean
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
 * A subagent's frames go through the same mappings as the main agent's, and
 * every event they produce carries `subtaskId`, the id of the `Agent` call that
 * started the subagent, so the host can file it in the subagent's own session.
 * They arrive as whole blocks (Claude Code streams no deltas for a subagent),
 * and they touch none of the turn's state: a subagent's tokens, results and
 * blocks are not the user's turn's.
 *
 * State has three lifetimes here and confusing them is the bug class this
 * comment exists to prevent:
 * - MESSAGE-scoped (`blocks`, `thinkingTokens`): content-block indices restart
 *   at 0 on every `message_start`, so a map keyed by index must die with the
 *   message. Carrying it over makes index 0 of the next message inherit the
 *   previous message's identity — text deltas mistaken for tool JSON.
 * - TURN-scoped (`usage`, `apiError`, `refused`, `shownNotices`): reset when a *top-level* result lands, the only frame
 *   meaning "the user's turn is over", so a subagent result cannot zero the
 *   user's token counts. Also reset by `beginTurn`, because a result nobody
 *   waited for is dropped untranslated and cannot be relied on to clear them.
 * - SESSION-scoped (`toolNames`, `claimedSubtasks`, `contentFromInput`,
 *   `subagents`, `agentTaskIds`): a `tool_result` is correlated by
 *   `tool_use_id` and is not bounded by the message that opened the call, and
 *   a subagent outlives the turn that started it, so those maps outlive both.
 *
 * The one rule that outranks everything else: NEVER throw on an unknown
 * message. `SDKMessage` is a 38-member union today and the CLI adds members in
 * point releases; a translator that throws turns a new informational banner
 * into a dead session. Unknown shapes are logged and dropped. */
export class ClaudeMessageTranslator {
  private readonly route: () => BackendRoute
  private readonly log: Pick<HostDeps, 'log'>['log']
  private readonly subtasks: SubtaskAdapter | undefined
  private readonly turnOpen: () => boolean

  // -- message-scoped ------------------------------------------------------
  private blocks = new Map<number, BlockState>()
  /** Monotonic within a thinking run: `estimated_tokens` is a running total and
   * a repeated or re-ordered frame must not walk the counter backwards. */
  private thinkingTokens: number | undefined

  // -- turn-scoped ---------------------------------------------------------
  private usage = emptyUsage()
  /** A top-level assistant message the CLI flagged with `error`: its text is
   * Claude Code's own "API Error: ..." line, not the model's reply, so it is
   * held back and becomes the turn's typed failure (or a notice, if the turn
   * recovers) instead of chat text. */
  private apiError: { error: string; text: string } | undefined
  /** The model declined this turn with no fallback to retry it. */
  private refused = false
  /** Notification lines already shown this turn; the CLI repeats them. */
  private readonly shownNotices = new Set<string>()

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
  /** The latest `rate_limit_info`: the only structured source of when a
   * usage limit resets, read when a turn then fails on that limit. */
  private rateLimit: ClaudeRateLimit | undefined
  /** Limits already warned about, so each threshold is announced once per
   * allowance window. */
  private readonly warnedLimits = new Set<string>()
  /** Every subagent seen this session, by `taskId`. */
  private readonly subagents = new Map<string, SubagentRecord>()
  /** Claude Code's `agentId` -> our `taskId`. `task_*` frames name a subagent
   * only by `agentId`, and a revived one keeps it, so this is never pruned. */
  private readonly agentTaskIds = new Map<string, string>()

  constructor(deps: ClaudeMessageTranslatorDeps) {
    this.route = deps.route
    this.log = deps.log
    this.subtasks = deps.subtasks
    this.turnOpen = deps.turnOpen ?? (() => true)
  }

  /** A new turn was dispatched. What the last one flagged, refused, showed or
   * counted belongs to it: a result nobody waited for is dropped untranslated,
   * so its settlement cannot be relied on to clear this. */
  beginTurn(): void {
    this.usage = emptyUsage()
    this.apiError = undefined
    this.refused = false
    this.shownNotices.clear()
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
    // A subagent's work, never the main agent's: it must not reach the turn's
    // block map, usage or result handling, and everything it produces is
    // tagged so it lands in the subagent's session rather than the parent's.
    if (parent) return { events: tagged(this.subagentFrame(message, parent), parent) }

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
      case 'rate_limit_event':
        return { events: this.rateLimitEvent(message) }
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
      this.blocks.set(index, { kind: 'text', text: '', matched: false })
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
        toolName,
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
      const text = string(delta.text)
      if (!text) return []
      const block = this.blocks.get(index)
      if (block?.kind === 'text') block.text += text
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
    subtaskId?: string,
  ): BackendEvent[] {
    const content = claudeToolContentFromInput(toolName, input)
    if (content) this.contentFromInput.add(toolUseId)
    const locations = claudeToolLocations(input)
    const update: ToolCallUpdate = {
      toolCallId: toolUseId,
      title: claudeToolTitle(toolName),
      toolName,
      kind: claudeToolKind(toolName),
      status: 'in_progress',
      rawInput: input,
      ...(content ? { content } : {}),
      ...(locations ? { locations } : {}),
    }
    const events = [this.toolEvent(sessionId, update, 'update', { subtaskId })]
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

  /** An `assistant` frame: the CLI's own copy of content that (usually) already
   * streamed.
   *
   * Its only job here is backfill. Text that streamed needs nothing — it is
   * already on screen and re-emitting would duplicate the paragraph — but a
   * text block that produced no delta at all (a cached completion, an
   * interrupted stream, a build with partial messages disabled) would otherwise
   * never be shown at all.
   *
   * NOT positional, and NOT the end of the message. Live-verified (claude CLI,
   * 2026-09) with partial messages on: the CLI emits one `assistant` frame PER
   * content block, each with a single-element `content` (so the block always
   * sits at index 0 whatever its stream index was), all sharing `message.id`,
   * and each arriving BEFORE that block's `content_block_stop`. Looking the
   * block up by position therefore misses whenever anything preceded it —
   * every thinking-first answer — and clearing the index map here killed the
   * still-streaming message's state (the thinking block never got its `stop`,
   * the text block's snapshot found no record of having streamed, and the whole
   * answer was emitted a second time). So a snapshot text block is matched to
   * the streamed block that produced its text, and the map lives until the
   * next `message_start`, which is the only real message boundary. */
  private assistantSnapshot(message: Extract<SDKMessage, { type: 'assistant' }>): BackendEvent[] {
    const content = object(message.message).content
    const blocks = Array.isArray(content) ? content : []
    // `error` marks Claude Code's own synthetic message ("API Error: 529 ...",
    // a usage-limit line): never streamed, and not the model's words. Text
    // that did stream is left alone; the rest is held for the turn's outcome.
    const flagged = string(object(message).error)
    const events: BackendEvent[] = []
    for (const raw of blocks) {
      const block = object(raw)
      if (string(block.type) !== 'text') continue
      const text = string(block.text)
      if (!text) continue
      if (this.claimStreamedText(text)) continue
      if (flagged) {
        const held = this.apiError?.text
        this.apiError = { error: flagged, text: held ? `${held}\n${text}` : text }
        continue
      }
      events.push(
        routeEvent(this.route(), message.session_id, 'stream', 'agent_message_chunk', {
          messageId: message.uuid,
          content: { type: 'text', text },
        }),
      )
    }
    if (flagged) {
      this.apiError ??= { error: flagged, text: '' }
      this.log({
        scope: 'claude',
        level: 'info',
        message: 'Claude Code flagged an assistant message as an API error',
        data: { error: flagged },
      })
    }
    return events
  }

  /** Is `text` a block that already streamed? Claims the block so two identical
   * paragraphs in one message each get one match.
   *
   * Prefix rather than equality: the frame is built from the completed block,
   * so the deltas normally add up to exactly its text — but if the tail is
   * still in flight, or was lost, re-emitting the whole block would duplicate
   * everything already on screen, which is the worse outcome. */
  private claimStreamedText(text: string): boolean {
    for (const block of this.blocks.values()) {
      if (block.kind !== 'text' || block.matched || !block.text) continue
      if (!text.startsWith(block.text)) continue
      block.matched = true
      return true
    }
    return false
  }

  /** A `user` frame is almost never the user. The CLI reports tool outcomes by
   * synthesizing a user message whose content blocks are `tool_result`s, and
   * that is the only place a tool's result is ever reported. */
  private userMessage(
    message: Extract<SDKMessage, { type: 'user' }>,
    subtaskId?: string,
  ): BackendEvent[] {
    const content = object(message.message).content
    if (!Array.isArray(content)) return []
    const events: BackendEvent[] = []
    // The structured result rides the message, not the block, so it can only
    // be attributed when the message reports exactly one tool's result.
    const results = content.filter((raw) => string(object(raw).type) === 'tool_result')
    const structured = results.length === 1 ? object(message).tool_use_result : undefined
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
      const toolName = this.toolNames.get(toolUseId)
      const extras = claudeToolResultExtras(toolName, structured)
      const answered = claudeAnsweredInput(toolName, structured)
      const resultContent = this.contentFromInput.has(toolUseId)
        ? undefined
        : toolResultContent(block.content)
      const update: ToolCallUpdate = {
        toolCallId: toolUseId,
        ...(toolName ? { toolName } : {}),
        status: failed || extras.outcome ? 'failed' : 'completed',
        ...extras,
        ...(answered ? { rawInput: answered } : {}),
        rawOutput: block.content,
        // Content is supplied only when the input produced none. `content` is
        // replaced wholesale downstream, so publishing result text for an Edit
        // would discard the diff that call already emitted.
        ...(resultContent ? { content: resultContent } : {}),
      }
      // `SDKUserMessage.session_id` is optional in the SDK's own types, unlike
      // every other frame's. Undefined routes the event without one rather than
      // dropping a tool's only completion signal.
      events.push(
        this.toolEvent(string(message.session_id), update, 'update', {
          subtaskId,
          result: { output: structured },
        }),
      )
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
            problem: retryProblem(raw),
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
        // A marker in the transcript: the turns above it are summarized.
        return [this.notice(message.session_id, compactionNotice(raw))]
      }
      case 'status': {
        if (raw.status === 'compacting') {
          return [
            this.notice(message.session_id, {
              kind: 'compacting',
              message: 'Compacting the conversation',
            }),
          ]
        }
        if (raw.compact_result !== 'failed') return []
        const detail = string(raw.compact_error)
        return [
          this.notice(message.session_id, {
            kind: 'warning',
            message: 'The conversation could not be compacted',
            ...(detail ? { detail } : {}),
          }),
        ]
      }
      case 'model_refusal_fallback':
        // The refused partial stays on screen: the retracted uuids are SDK
        // message ids the transcript does not keep.
        return [this.notice(message.session_id, refusalFallbackNotice(raw))]
      case 'model_refusal_no_fallback':
        this.refused = true
        return [this.notice(message.session_id, refusalNotice(raw))]
      case 'informational': {
        const notice = informationalNotice(raw)
        return notice ? [this.notice(message.session_id, notice)] : []
      }
      case 'notification': {
        const notice = notificationNotice(raw)
        if (!notice) return []
        const key = `${string(raw.key) ?? ''}:${notice.message}`
        if (this.shownNotices.has(key)) return []
        this.shownNotices.add(key)
        return [this.notice(message.session_id, notice)]
      }
      case 'permission_denied':
        return this.permissionDenied(message.session_id, raw)
      case 'task_started':
        return this.taskStarted(message.session_id, raw)
      case 'task_progress':
        return this.taskProgress(message.session_id, raw)
      case 'task_updated':
        return this.taskUpdated(message.session_id, raw)
      case 'task_notification':
        return this.taskNotification(message.session_id, raw)
      default:
        this.log({
          scope: 'claude',
          level: 'info',
          message: `[sdk] <- system/${message.subtype}`,
        })
        return []
    }
  }

  /** The auto-deny short circuit: a deny rule, `dontAsk`, or the auto-mode
   * classifier refused the tool without ever reaching `canUseTool`, so nothing
   * else will ever complete this row. */
  private permissionDenied(
    sessionId: string,
    raw: Record<string, unknown>,
    subtaskId?: string,
  ): BackendEvent[] {
    const toolUseId = string(raw.tool_use_id)
    if (!toolUseId) return []
    const toolName = string(raw.tool_name)
    const update: ToolCallUpdate = {
      toolCallId: toolUseId,
      status: 'failed',
      // Refused by a rule, not broken: the tool never ran.
      outcome: 'declined',
      ...(toolName ? { title: claudeToolTitle(toolName), toolName } : {}),
    }
    return [
      this.toolEvent(sessionId, update, 'update', { subtaskId, result: { output: undefined } }),
    ]
  }

  // ----------------------------------------------------------------- result

  private result(message: Extract<SDKMessage, { type: 'result' }>): TranslatedMessage {
    const apiError = this.apiError
    const refused = this.refused
    const usage = this.settleTurnUsage(message)
    const isError = message.is_error === true || message.subtype !== 'success'
    const interrupted = isInterrupted(message)
    const raw = object(message)
    const terminalReason = string(raw.terminal_reason)
    const apiErrorStatus = number(raw.api_error_status)
    // Claude Code's own words for the failure: its flagged message, else what
    // the result says. An API error can arrive as subtype `success` with
    // `is_error`, so the result's text counts there too. Logged by the host as
    // the error text, and shown to the user under the typed reason.
    const resultText =
      message.subtype === 'success' ? (string(raw.result) ?? '') : (message.errors ?? []).join('\n')
    const providerText = apiError?.text || resultText
    const detail = providerDetail(providerText)
    const classified =
      isError && !interrupted
        ? classifyClaudeFailure({
            ...(apiError ? { apiError } : {}),
            ...(terminalReason ? { terminalReason } : {}),
            ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
            ...(apiErrorStatus !== undefined ? { apiErrorStatus } : {}),
            text: resultText,
            ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}),
            refused,
          })
        : undefined
    const problem = classified && detail ? { ...classified, detail } : classified
    // A flagged message on a turn that went on to finish is still worth a
    // line: its text was held back and would otherwise vanish.
    const events =
      apiError && !isError
        ? [this.notice(message.session_id, recoveredErrorNotice(apiError.error, apiError.text))]
        : []
    return {
      events,
      completed: {
        sessionId: message.session_id,
        ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
        isError,
        interrupted,
        ...(message.subtype !== 'success'
          ? { errorText: message.errors?.join('; ') || apiError?.text || message.subtype }
          : isError && providerText
            ? { errorText: providerText }
            : {}),
        ...(usage ? { usage } : {}),
        ...(problem ? { problem } : {}),
      },
    }
  }

  /** `rate_limit_event`: remembered for a failure's reset time, and announced
   * once per threshold when a limit is getting close. */
  private rateLimitEvent(
    message: Extract<SDKMessage, { type: 'rate_limit_event' }>,
  ): BackendEvent[] {
    const info = object(message.rate_limit_info)
    this.rateLimit = info
    // The provider's limits move whether or not a turn is open to warn in.
    const observation = claudeUsageObservation(info)
    const update = observation
      ? [
          routeEvent(
            this.route(),
            message.session_id,
            'session',
            'usage_limits_update',
            observation,
          ),
        ]
      : []
    if (string(info.status) !== 'allowed_warning') return update
    // A notice belongs to a turn: with none open it would be dropped, and
    // remembering it here would lose the warning for its whole window.
    if (!this.turnOpen()) return update
    // Keyed by the allowance window too: the same threshold in the next window
    // is a new warning, not a repeat.
    const key = [info.rateLimitType, info.surpassedThreshold, info.resetsAt]
      .map((part) => (typeof part === 'string' || typeof part === 'number' ? part : ''))
      .join(':')
    if (this.warnedLimits.has(key)) return update
    this.warnedLimits.add(key)
    return [...update, this.notice(message.session_id, usageWarningNotice(info))]
  }

  private notice(sessionId: string, notice: ProviderNotice): BackendEvent {
    return routeEvent(this.route(), sessionId, 'session', 'provider_notice', notice)
  }

  /** Close the turn's books and reset the turn-scoped state.
   *
   * Only top-level results reach here — subagent frames are routed apart in
   * `dispatch` — so what resets is exactly what belongs to the user's turn. */
  private settleTurnUsage(
    message: Extract<SDKMessage, { type: 'result' }>,
  ): TokenUsage | undefined {
    const accumulated = this.usage
    this.usage = emptyUsage()
    this.thinkingTokens = undefined
    this.apiError = undefined
    this.refused = false
    this.shownNotices.clear()
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

  /** The `taskId` of the subagent Claude Code calls `agentId`, once its
   * `task_started` has been seen. A permission request from inside a subagent
   * names it only this way. */
  subtaskIdForAgent(agentId: string): string | undefined {
    return this.agentTaskIds.get(agentId)
  }

  /** Claude Code's `agentId` for a subagent, which is what `stopTask` takes. */
  agentIdForSubtask(taskId: string): string | undefined {
    return this.subagents.get(taskId)?.agentId
  }

  /** One frame of a subagent's own work, translated as the main agent's would
   * be. Untagged here; `dispatch` tags the lot.
   *
   * No `stream_event` arrives for a subagent, so its text, thinking and tool
   * calls come only from whole `assistant` frames, and those are emitted in
   * full rather than matched against a stream. */
  private subagentFrame(message: SDKMessage, taskId: string): BackendEvent[] {
    switch (message.type) {
      case 'assistant':
        return this.subagentAssistant(message, taskId)
      case 'user':
        return this.userMessage(message, taskId)
      case 'system':
        if (message.subtype === 'permission_denied')
          return this.permissionDenied(message.session_id, object(message), taskId)
        return []
      default:
        // Stream envelopes, results and progress frames: a subagent's are not
        // expected, and if one arrives it must not reach the turn's state.
        return []
    }
  }

  private subagentAssistant(
    message: Extract<SDKMessage, { type: 'assistant' }>,
    taskId: string,
  ): BackendEvent[] {
    const sessionId = message.session_id
    const content = object(message.message).content
    const events: BackendEvent[] = []
    for (const raw of Array.isArray(content) ? content : []) {
      const block = object(raw)
      const type = string(block.type)
      if (type === 'text') {
        const text = string(block.text)
        if (!text) continue
        events.push(
          routeEvent(this.route(), sessionId, 'stream', 'agent_message_chunk', {
            messageId: message.uuid,
            content: { type: 'text', text },
          }),
        )
        continue
      }
      if (type === 'thinking' || type === 'redacted_thinking') {
        // The text is empty, as it is for the main agent; a whole block is
        // both the start and the end of the indicator.
        events.push(
          routeEvent(this.route(), sessionId, 'stream', 'agent_thought_chunk', { phase: 'start' }),
          routeEvent(this.route(), sessionId, 'stream', 'agent_thought_chunk', { phase: 'stop' }),
        )
        continue
      }
      if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
        const toolUseId = string(block.id)
        if (!toolUseId) continue
        const toolName = string(block.name) ?? 'tool'
        this.rememberToolName(toolUseId, toolName)
        const call: ToolCall = {
          toolCallId: toolUseId,
          title: claudeToolTitle(toolName),
          toolName,
          kind: claudeToolKind(toolName),
          status: 'pending',
          rawInput: object(block.input),
        }
        events.push(this.toolEvent(sessionId, call, 'call', { subtaskId: taskId }))
        events.push(
          ...this.toolInputResolved(sessionId, toolUseId, toolName, block.input ?? {}, taskId),
        )
      }
    }
    return events
  }

  /** The record for `taskId`, made on first sight. `parentTaskId` is the
   * subagent whose frame carried the call, for a nested one. */
  private subagentRecord(taskId: string, parentTaskId?: string, depth?: number): SubagentRecord {
    const known = this.subagents.get(taskId)
    if (known) return known
    const parent = parentTaskId ? this.subagents.get(parentTaskId) : undefined
    const record: SubagentRecord = {
      taskId,
      depth: depth ?? (parentTaskId ? (parent?.depth ?? 1) + 1 : 1),
      ...(parentTaskId ? { parentTaskId } : {}),
      background: false,
      settled: false,
      answered: false,
    }
    this.subagents.set(taskId, record)
    return record
  }

  /** The subagent a `task_*` frame is about, or undefined when it is not about
   * one: a subagent's own foreground `Bash` reports `task_started` too. */
  private taskRecord(raw: Record<string, unknown>): SubagentRecord | undefined {
    const agentId = string(raw.task_id)
    if (!agentId) return undefined
    const known = this.agentTaskIds.get(agentId)
    if (known) return this.subagents.get(known)
    const toolUseId = string(raw.tool_use_id)
    const record = toolUseId ? this.subagents.get(toolUseId) : undefined
    if (!record) return undefined
    record.agentId = agentId
    this.agentTaskIds.set(agentId, record.taskId)
    return record
  }

  /** A subagent began, or a finished one was revived by `SendMessage`. A
   * revival keeps its `agentId`, so it goes back to running under the
   * `taskId` it already has. */
  private taskStarted(sessionId: string, raw: Record<string, unknown>): BackendEvent[] {
    const agentId = string(raw.task_id)
    if (!agentId) return []
    let record = this.taskRecord(raw)
    const fresh = !record
    if (!record) {
      // An agent whose `Agent` call we never saw (it was made before this
      // process attached). Still a subagent; it is keyed by what we have.
      if (claudeTaskKind(string(raw.task_type)) !== 'agent') return []
      const parentAgent = string(raw.parent_task_id)
      const parentTaskId = parentAgent ? this.agentTaskIds.get(parentAgent) : undefined
      const spawnDepth = number(raw.spawn_depth)
      record = this.subagentRecord(string(raw.tool_use_id) ?? agentId, parentTaskId, spawnDepth)
      record.agentId = agentId
      this.agentTaskIds.set(agentId, record.taskId)
    }
    record.settled = false
    record.answered = false
    if (typeof raw.is_backgrounded === 'boolean') record.background = raw.is_backgrounded
    // A revival (`SendMessage`) runs on its own, after the call that revived
    // it returned: it must not end with whatever parent turn is running.
    else if (!fresh) record.background = true
    const description = string(raw.description)
    const prompt = string(raw.prompt)
    const subagentType = string(raw.subagent_type)
    return this.subtaskEvent(sessionId, record, {
      taskId: record.taskId,
      toolCallId: record.taskId,
      status: 'running',
      statusSource: 'task_event',
      providerTaskId: agentId,
      depth: record.depth,
      ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
      background: record.background,
      stoppable: true,
      promptable: false,
      ...(fresh && description ? { title: description } : {}),
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
      ...(subagentType ? { subagentType } : {}),
    })
  }

  private taskProgress(sessionId: string, raw: Record<string, unknown>): BackendEvent[] {
    const record = this.taskRecord(raw)
    if (!record) return []
    // A progress summary, when this frame has one, says more than a tool name.
    const activity = string(raw.summary) ?? string(raw.last_tool_name)
    return this.subtaskEvent(sessionId, record, {
      taskId: record.taskId,
      ...taskUsage(raw.usage),
      ...(activity ? { currentActivity: activity } : {}),
    })
  }

  private taskUpdated(sessionId: string, raw: Record<string, unknown>): BackendEvent[] {
    const record = this.taskRecord(raw)
    if (!record) return []
    const patch = object(raw.patch)
    const status = taskPatchStatus(string(patch.status))
    if (typeof patch.is_backgrounded === 'boolean') record.background = patch.is_backgrounded
    if (status) record.settled = SETTLED.has(status)
    const error = string(patch.error)
    const description = string(patch.description)
    const update: SubtaskUpdate = {
      taskId: record.taskId,
      ...(status ? { status, statusSource: 'task_event' as const } : {}),
      ...(status ? { stoppable: !SETTLED.has(status) } : {}),
      ...(error ? { statusReason: error } : {}),
      ...(typeof patch.is_backgrounded === 'boolean' ? { background: record.background } : {}),
      ...(description ? { description } : {}),
    }
    return Object.keys(update).length > 1 ? this.subtaskEvent(sessionId, record, update) : []
  }

  /** The end of a subagent's run. For a background one this is the only end
   * there is: its `Agent` call returned long ago. */
  private taskNotification(sessionId: string, raw: Record<string, unknown>): BackendEvent[] {
    const record = this.taskRecord(raw)
    if (!record) return []
    const reported = string(raw.status)
    const status: SubtaskStatus | undefined =
      reported === 'completed'
        ? 'completed'
        : reported === 'failed'
          ? 'failed'
          : reported === 'stopped'
            ? 'cancelled'
            : undefined
    const summary = string(raw.summary)
    if (status) record.settled = true
    // A foreground run's answer comes whole from its `Agent` result; the
    // summary stands in only where that has not arrived.
    const resultText = status === 'completed' && !record.answered ? summary : undefined
    if (resultText) record.answered = true
    return this.subtaskEvent(sessionId, record, {
      taskId: record.taskId,
      ...(status ? { status, statusSource: 'task_event' as const, stoppable: false } : {}),
      ...(resultText ? { resultText } : {}),
      ...(status && status !== 'completed' && summary ? { statusReason: summary } : {}),
      ...taskUsage(raw.usage),
    })
  }

  /** A `subtask_update` for `record`, filed where the call that started it
   * is: the parent's transcript, or for a nested subagent, its parent
   * subagent's. */
  private subtaskEvent(
    sessionId: string,
    record: SubagentRecord,
    update: SubtaskUpdate,
  ): BackendEvent[] {
    const event = routeEvent(this.route(), sessionId, 'session', 'subtask_update', update)
    return record.parentTaskId ? tagged([event], record.parentTaskId) : [event]
  }

  // ----------------------------------------------------------------- helpers

  /** Route a tool event through the provider's subtask classifier, exactly as
   * `AcpSessionRuntimeImpl.subtaskFromTool` does. A claimed toolCallId never
   * emits a raw tool event again, so an `Agent` call's later status-only
   * update lands on the subtask row instead of resurrecting a tool row beside
   * it.
   *
   * `subtaskId` names the subagent whose frame carried the call, and `result`
   * marks the call's final outcome, with its structured output. */
  private toolEvent(
    sessionId: string | undefined,
    tool: ToolCall | ToolCallUpdate,
    phase: 'call' | 'update',
    context: ToolEventContext = {},
  ): BackendEvent {
    const subtask = this.subtaskFromTool(tool, phase, context)
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
    context: ToolEventContext,
  ): SubtaskUpdate | undefined {
    const fromToolCall = this.subtasks?.fromToolCall
    if (!fromToolCall || !tool.toolCallId) return undefined
    const tracked = this.claimedSubtasks.has(tool.toolCallId)
    // A `tool_result` update carries no title, so the classifier is handed the
    // name recorded when the call opened. Without it a claimed call's
    // completion would arrive unidentifiable and fall back to a tool row.
    const title = tool.title ?? this.toolNames.get(tool.toolCallId)
    const named: ToolCallUpdate = { ...tool, ...(title ? { title } : {}) }
    const classified = fromToolCall(named, { phase, tracked })
    if (!classified) return undefined
    this.claimedSubtasks.add(tool.toolCallId)
    const record = this.subagentRecord(classified.taskId, context.subtaskId)
    if (classified.background) record.background = true
    let update: SubtaskUpdate = {
      ...classified,
      depth: record.depth,
      ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
      promptable: false,
    }
    if (context.result) update = this.subagentResult(record, update, context.result.output)
    return update.status ? { ...update, statusSource: update.statusSource ?? 'task_event' } : update
  }

  /** Fold the `Agent` call's result into its subtask.
   *
   * The call ending is not always the subagent ending: a background run
   * returns at once and finishes later, and a run a task frame already settled
   * (stopped, say) must keep the status that frame gave it. */
  private subagentResult(
    record: SubagentRecord,
    update: SubtaskUpdate,
    output: unknown,
  ): SubtaskUpdate {
    const agent = subtaskFromAgentOutput(output)
    if (agent) {
      const { agentId, ...fields } = agent
      if (agentId) {
        record.agentId = agentId
        this.agentTaskIds.set(agentId, record.taskId)
      }
      if (fields.background) record.background = true
      // Stopped first, answered after: the stop stands, the answer is kept.
      if (fields.status === 'completed' && record.settled) {
        record.answered = true
        return { ...withoutStatus(update), ...withoutStatus(fields), stoppable: false }
      }
      if (fields.status === 'completed') {
        record.settled = true
        record.answered = true
        return { ...update, ...fields, stoppable: false }
      }
      return { ...update, ...(record.settled ? withoutStatus(fields) : fields) }
    }
    if (record.background || record.settled) return withoutStatus(update)
    if (update.status && SETTLED.has(update.status)) {
      record.settled = true
      return { ...update, stoppable: false }
    }
    return update
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

/** Who a tool event belongs to and whether it is the call's outcome; see
 * `ClaudeMessageTranslator.toolEvent`. */
type ToolEventContext = {
  subtaskId?: string | undefined
  result?: { output: unknown }
}

/** Mark events as a subagent's work. */
function tagged(events: BackendEvent[], subtaskId: string): BackendEvent[] {
  return events.map((event) => ({ ...event, subtaskId }))
}

function withoutStatus<T extends Partial<SubtaskUpdate>>(
  update: T,
): Omit<T, 'status' | 'statusSource'> {
  const { status: _status, statusSource: _source, ...rest } = update
  return rest
}

/** The running totals a `task_progress` or `task_notification` carries. */
function taskUsage(raw: unknown): Pick<SubtaskUpdate, 'tokens' | 'toolCallCount' | 'durationMs'> {
  const usage = object(raw)
  const tokens = number(usage.total_tokens)
  const toolCallCount = number(usage.tool_uses)
  const durationMs = number(usage.duration_ms)
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(toolCallCount !== undefined ? { toolCallCount } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

/** `task_updated`'s status, in the contract's words. `paused` has none and
 * says nothing about whether the run is over. */
function taskPatchStatus(status: string | undefined): SubtaskStatus | undefined {
  switch (status) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
      return status
    case 'killed':
      return 'cancelled'
    default:
      return undefined
  }
}
