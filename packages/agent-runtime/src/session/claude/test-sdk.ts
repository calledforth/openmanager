import type {
  Options,
  PermissionMode,
  SDKControlGetContextUsageResponse,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeQuerySession, ClaudeSdk } from './sdk.js'

/** The `ClaudeSdk` seam, faked — `test-connection.ts` for the SDK transport.
 *
 * Same philosophy, and for the same reason: a test that reaches into a
 * runtime's private fields stops exercising the code that matters. Startup
 * ordering, turn binding and exit settlement are *most* of what
 * `ClaudeSessionRuntime` does, so the tests drive them through the real
 * entry points and this file supplies the only thing a test cannot have —
 * a Claude Code subprocess.
 *
 * Everything here exists only for tests; nothing in the shipping paths
 * imports it. */

const DEFAULT_INITIALIZE: SDKControlInitializeResponse = {
  commands: [{ name: 'compact', description: 'Compact the conversation', argumentHint: '' }],
  agents: [],
  output_style: 'default',
  available_output_styles: ['default'],
  models: [],
  account: { email: 'test@example.com', subscriptionType: 'Claude Pro' },
} as SDKControlInitializeResponse

export class FakeClaudeQuery implements ClaudeQuerySession {
  /** Prompts the runtime pushed onto the input stream, in order. */
  readonly prompts: SDKUserMessage[] = []
  readonly models: (string | undefined)[] = []
  readonly modes: PermissionMode[] = []
  interrupts = 0
  closed = false
  returned = false

  /** Set to make `initializationResult()` reject — a CLI that starts and then
   * fails to authenticate, or dies on a bad flag. */
  initializeError: Error | undefined
  /** Set to make `interrupt()` reject. */
  interruptError: Error | undefined
  /** Set to make `getContextUsage()` reject — an older CLI that does not answer
   * the control request. A turn must still settle when it does. */
  contextUsageError: Error | undefined
  contextUsageCalls = 0
  contextUsage = {
    categories: [],
    totalTokens: 12_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 6,
    model: 'claude-opus-5',
  } as unknown as SDKControlGetContextUsageResponse

  private readonly pending: SDKMessage[] = []
  private waiting: ((message: SDKMessage | undefined) => void) | undefined
  private ended = false
  private failure: unknown

  /** The session id these helpers stamp by default.
   *
   * Derived from the launch options exactly as the real CLI derives it: the
   * caller's pre-generated `sessionId` for a fresh transcript, the `resume`
   * id for a resumed one. A fake that invented its own would make every test
   * exercise the "the CLI reported a different id" path by accident. */
  sessionId: string

  constructor(
    readonly options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
    private readonly initialize: SDKControlInitializeResponse = DEFAULT_INITIALIZE,
  ) {
    this.sessionId = options.sessionId ?? options.resume ?? 'session-unknown'
    // Drain the runtime's input queue the way the real subprocess does, so a
    // test can assert what was actually sent rather than what was intended.
    void (async () => {
      for await (const message of prompt) this.prompts.push(message)
    })().catch(() => undefined)
  }

  // ------------------------------------------------------------- driver side

  /** One assistant text delta, the only stream shape 3a translates. */
  emitText(text: string, sessionId = this.sessionId): void {
    this.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: sessionId,
    } as unknown as SDKMessage)
  }

  /** A terminal result. `parentToolUseId` makes it a subagent's result, which
   * must not settle the user's turn. */
  emitResult(
    overrides: {
      sessionId?: string
      subtype?: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd'
      stopReason?: string | null
      parentToolUseId?: string
      /** `SDKResultError.errors`, which is where the human-readable failure is. */
      errors?: string[]
      /** The field that separates an abort from a genuine failure; both arrive
       * on an error-subtype result. */
      terminalReason?: string
      /** `SDKResultSuccess.user_message_uuid` — the correlation the runtime
       * matches a result against the dispatch that produced it. */
      userMessageUuid?: string
    } = {},
  ): void {
    this.emit({
      type: 'result',
      subtype: overrides.subtype ?? 'success',
      stop_reason: overrides.stopReason ?? 'end_turn',
      is_error: (overrides.subtype ?? 'success') !== 'success',
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: 'ok',
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      errors: overrides.errors ?? [],
      uuid: crypto.randomUUID(),
      session_id: overrides.sessionId ?? this.sessionId,
      ...(overrides.terminalReason ? { terminal_reason: overrides.terminalReason } : {}),
      ...(overrides.userMessageUuid ? { user_message_uuid: overrides.userMessageUuid } : {}),
      ...(overrides.parentToolUseId ? { parent_tool_use_id: overrides.parentToolUseId } : {}),
    } as unknown as SDKMessage)
  }

  emitAssistant(text: string, sessionId = this.sessionId): void {
    this.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: sessionId,
    } as unknown as SDKMessage)
  }

  emitUser(text: string, sessionId = this.sessionId): void {
    this.emit({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: sessionId,
    } as unknown as SDKMessage)
  }

  /** Any `system` frame. `hook_started`/`hook_progress`/`hook_response` are
   * the ones whose session id must never be adopted. */
  emitSystem(subtype: string, sessionId: string, extra: Record<string, unknown> = {}): void {
    this.emit({
      type: 'system',
      subtype,
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      ...extra,
    } as unknown as SDKMessage)
  }

  // ------------------------------------------------------- streaming frames

  /** One raw Anthropic streaming envelope. Everything below is sugar over it. */
  emitStream(event: Record<string, unknown>, parentToolUseId: string | null = null): void {
    this.emit({
      type: 'stream_event',
      event,
      parent_tool_use_id: parentToolUseId,
      uuid: crypto.randomUUID(),
      session_id: this.sessionId,
    } as unknown as SDKMessage)
  }

  /** Opens a fresh content-block index space, exactly as the CLI does between
   * assistant messages within one turn. */
  emitMessageStart(): void {
    this.emitStream({ type: 'message_start', message: { role: 'assistant', content: [] } })
  }

  emitMessageDelta(usage: Record<string, number>, parentToolUseId: string | null = null): void {
    this.emitStream({ type: 'message_delta', delta: {}, usage }, parentToolUseId)
  }

  emitTextBlock(index: number, chunks: string[]): void {
    this.emitStream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    for (const text of chunks)
      this.emitStream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
    this.emitStream({ type: 'content_block_stop', index })
  }

  /** A thinking block. `thinking` is always the empty string on the wire — the
   * fake reproduces that deliberately, because a fake that emitted text would
   * hide the bug this provider's whole reasoning story exists to avoid. */
  emitThinkingStart(index: number): void {
    this.emitStream({
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
  }
  emitThinkingDelta(index: number, estimatedTokens: number): void {
    this.emitStream({
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: '', estimated_tokens: estimatedTokens },
    })
  }
  emitBlockStop(index: number): void {
    this.emitStream({ type: 'content_block_stop', index })
  }

  /** A tool call opening. `input` is `{}` on the wire; the arguments arrive as
   * `input_json_delta` fragments. */
  emitToolStart(index: number, id: string, name: string, type = 'tool_use'): void {
    this.emitStream({
      type: 'content_block_start',
      index,
      content_block: { type, id, name, input: {} },
    })
  }
  emitToolInput(index: number, partialJson: string): void {
    this.emitStream({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    })
  }

  /** The synthesized user message the CLI reports a tool's outcome through. */
  emitToolResult(toolUseId: string, content: unknown, isError = false): void {
    this.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: this.sessionId,
    } as unknown as SDKMessage)
  }

  /** A finished assistant message. `parentToolUseId` makes it a subagent's. */
  emitAssistantBlocks(blocks: unknown[], parentToolUseId: string | null = null): void {
    this.emit({
      type: 'assistant',
      message: { role: 'assistant', content: blocks },
      parent_tool_use_id: parentToolUseId,
      uuid: crypto.randomUUID(),
      session_id: this.sessionId,
    } as unknown as SDKMessage)
  }

  /** Drive the runtime's `canUseTool` the way the CLI does. The abort
   * controller is returned so a test can abort a parked interaction. */
  useTool(
    toolName: string,
    input: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): { result: Promise<unknown>; controller: AbortController } {
    const controller = new AbortController()
    const canUseTool = this.options.canUseTool
    if (!canUseTool) throw new Error('the runtime did not install a canUseTool callback')
    const result = canUseTool(toolName, input, {
      signal: controller.signal,
      toolUseID: `toolu_${toolName}`,
      requestId: crypto.randomUUID(),
      ...overrides,
    } as Parameters<typeof canUseTool>[2])
    void result.catch(() => undefined)
    return { result, controller }
  }

  /** A member of the union this build knows nothing about — the case the
   * translator must survive rather than throw on. */
  emitUnknown(type: string): void {
    this.emit({
      type,
      uuid: crypto.randomUUID(),
      session_id: this.sessionId,
    } as unknown as SDKMessage)
  }

  emit(message: SDKMessage): void {
    if (this.ended) return
    const waiting = this.waiting
    if (waiting) {
      this.waiting = undefined
      waiting(message)
      return
    }
    this.pending.push(message)
  }

  /** The CLI closing its side cleanly. */
  endStream(): void {
    if (this.ended) return
    this.ended = true
    const waiting = this.waiting
    this.waiting = undefined
    waiting?.(undefined)
  }

  /** The CLI dying. The output pump rejects, which must reject the active turn
   * and settle the exit. */
  crash(error: Error): void {
    if (this.ended) return
    this.failure = error
    this.endStream()
  }

  // ---------------------------------------------------------- ClaudeQuerySession

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const buffered = this.pending.shift()
      if (buffered) {
        yield buffered
        continue
      }
      if (this.ended) {
        if (this.failure) throw this.failure
        return
      }
      const next = await new Promise<SDKMessage | undefined>((resolve) => {
        this.waiting = resolve
      })
      if (next === undefined) {
        if (this.failure) throw this.failure
        return
      }
      yield next
    }
  }

  async interrupt(): Promise<unknown> {
    this.interrupts += 1
    if (this.interruptError) throw this.interruptError
    return undefined
  }
  async setModel(model?: string): Promise<void> {
    this.models.push(model)
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.modes.push(mode)
  }
  async initializationResult(): Promise<SDKControlInitializeResponse> {
    if (this.initializeError) throw this.initializeError
    return this.initialize
  }
  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    this.contextUsageCalls += 1
    if (this.contextUsageError) throw this.contextUsageError
    return this.contextUsage
  }
  close(): void {
    this.closed = true
    this.endStream()
  }
  async return(): Promise<unknown> {
    this.returned = true
    this.endStream()
    return { done: true, value: undefined }
  }
}

export class FakeClaudeSdk implements ClaudeSdk {
  readonly queries: FakeClaudeQuery[] = []
  /** Transcripts `getSessionInfo` knows about. Anything else reads as a
   * session the CLI never wrote. */
  readonly sessions = new Map<string, SDKSessionInfo>()
  /** Set to reject `getSessionInfo` outright — a disk error, as distinct from
   * a session that is genuinely not there. */
  sessionInfoError: Error | undefined
  initialize: SDKControlInitializeResponse = DEFAULT_INITIALIZE
  /** Applied to every query this factory builds, before the test gets it. */
  prepare: ((query: FakeClaudeQuery) => void) | undefined

  query(args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuerySession {
    const query = new FakeClaudeQuery(args.options, args.prompt, this.initialize)
    this.prepare?.(query)
    this.queries.push(query)
    return query
  }

  async getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
    if (this.sessionInfoError) throw this.sessionInfoError
    return this.sessions.get(sessionId)
  }

  /** Register a transcript so a resume of it succeeds. */
  knows(sessionId: string): void {
    this.sessions.set(sessionId, {
      sessionId,
      summary: 'A previous conversation',
      lastModified: Date.now(),
    } as SDKSessionInfo)
  }

  get last(): FakeClaudeQuery {
    const query = this.queries.at(-1)
    if (!query) throw new Error('no query has been started yet')
    return query
  }
}
