import type {
  Options,
  PermissionMode,
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
      subtype?: 'success' | 'error_during_execution'
      stopReason?: string | null
      parentToolUseId?: string
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
      errors: [],
      uuid: crypto.randomUUID(),
      session_id: overrides.sessionId ?? this.sessionId,
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
