import type { MessagePhase, v2 } from '@openmanager/codex-app-server-protocol'
import type { ServerRequestMethod, ServerRequestParams } from '../CodexAppServerClient.js'
import {
  agentMessageItem,
  buildThreadStartResponse,
  buildTurn,
  commandApprovalParams,
  commandExecutionItem,
  elicitationParams,
  FAKE_NOW_MS,
  fileChangeApprovalParams,
  fileChangeItem,
  permissionsApprovalParams,
  reasoningItem,
  subAgentActivityItem,
  threadTokenUsage,
  userInputParams,
  userMessageItem,
} from './builders.js'
import type { FakeCodexAppServer, FakeServerAnswer } from './FakeCodexAppServer.js'

type Item = v2.ThreadItem

/** One thread on a `FakeCodexAppServer`, speaking in the notifications Codex
 * 0.170 sends for it.
 *
 * Every method writes at once, in call order, so the order of calls is the
 * order on the wire. That is what makes the awkward cases easy to script: a
 * child thread's notifications interleaved with its parent's are calls on two
 * threads, alternated; a notification after a turn ended is a call after
 * `completed()`. */
export class FakeCodexThread {
  constructor(
    readonly server: FakeCodexAppServer,
    public thread: v2.Thread,
  ) {}

  get id(): string {
    return this.thread.id
  }

  /** `thread/started`. Codex sends it after answering `thread/start`, and
   * sends none for a subagent's thread. */
  started(): this {
    this.server.notify('thread/started', { thread: this.thread })
    return this
  }

  status(status: v2.ThreadStatus): this {
    this.thread = { ...this.thread, status }
    this.server.notify('thread/status/changed', { threadId: this.id, status })
    return this
  }

  /** The answer to `thread/start` for this thread. */
  startResponse(overrides: Partial<v2.ThreadStartResponse> = {}): v2.ThreadStartResponse {
    return buildThreadStartResponse(this.thread, overrides)
  }

  /** A new turn on this thread. Nothing is sent until `started()`. */
  turn(overrides: Partial<v2.Turn> = {}): FakeCodexTurn {
    return new FakeCodexTurn(this, buildTurn(overrides))
  }

  /** A subagent's thread under this one. Codex announces it through the
   * parent's `subAgentActivity` item (see `FakeCodexTurn.spawnSubagent`), not
   * with `thread/started`. */
  child(overrides: Partial<v2.Thread> = {}): FakeCodexThread {
    return this.server.thread({
      parentThreadId: this.id,
      sessionId: this.thread.sessionId,
      agentNickname: 'helper',
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: this.id,
            depth: 1,
            agent_path: '/root/helper',
            agent_nickname: 'helper',
            agent_role: null,
          },
        },
      },
      ...overrides,
    })
  }
}

export type CommandScript = {
  /** stdout and stderr, aggregated, as the deltas deliver it. */
  output?: string
  /** Split `output` into these deltas instead of sending it in one. */
  chunks?: string[]
  exitCode?: number
  status?: v2.CommandExecutionStatus
  durationMs?: number
}

/** One turn: `started()`, then items, then `completed()`. */
export class FakeCodexTurn {
  /** Items completed so far, in order. */
  readonly items: Item[] = []

  constructor(
    readonly thread: FakeCodexThread,
    public turn: v2.Turn,
  ) {}

  get id(): string {
    return this.turn.id
  }

  get threadId(): string {
    return this.thread.id
  }

  private get server(): FakeCodexAppServer {
    return this.thread.server
  }

  /** The answer to `turn/start`: the turn in progress, not yet stamped with
   * a start time (Codex stamps it on `turn/started`). */
  startResponse(): v2.TurnStartResponse {
    return { turn: { ...this.turn, startedAt: null } }
  }

  /** `thread/status/changed` to active, then `turn/started`. */
  started(): this {
    this.thread.status({ type: 'active', activeFlags: [] })
    this.server.notify('turn/started', { threadId: this.threadId, turn: this.turn })
    return this
  }

  itemStarted<T extends Item>(item: T): T {
    this.server.notify('item/started', {
      item: { ...item, startedAtMs: FAKE_NOW_MS, completedAtMs: null },
      threadId: this.threadId,
      turnId: this.id,
      startedAtMs: FAKE_NOW_MS,
    })
    return item
  }

  itemCompleted<T extends Item>(item: T): T {
    this.items.push(item)
    this.server.notify('item/completed', {
      item: { ...item, startedAtMs: FAKE_NOW_MS, completedAtMs: FAKE_NOW_MS },
      threadId: this.threadId,
      turnId: this.id,
      contentTokenCount: null,
      completedAtMs: FAKE_NOW_MS,
    })
    return item
  }

  /** The user's prompt as Codex echoes it at the start of a turn (and again
   * for each `turn/steer`). */
  userMessage(text: string): Item {
    const item = userMessageItem(text)
    this.itemStarted(item)
    return this.itemCompleted(item)
  }

  /** An assistant message: started empty, streamed as deltas, completed whole. */
  agentMessage(text: string, options: { chunks?: string[]; phase?: MessagePhase | null } = {}): Item {
    const item = agentMessageItem(text, options.phase !== undefined ? { phase: options.phase } : {})
    this.itemStarted({ ...item, text: '' })
    for (const delta of options.chunks ?? [text])
      this.server.notify('item/agentMessage/delta', { threadId: this.threadId, turnId: this.id, itemId: item.id, delta })
    return this.itemCompleted(item)
  }

  /** Reasoning with summary parts, each streamed as summary-text deltas. It
   * only arrives non-empty when the turn asked for `summary: "detailed"`. */
  reasoning(summary: string[]): Item {
    const item = reasoningItem(summary)
    this.itemStarted({ ...item, summary: [] })
    summary.forEach((part, summaryIndex) => {
      if (summaryIndex > 0)
        this.server.notify('item/reasoning/summaryPartAdded', {
          threadId: this.threadId,
          turnId: this.id,
          itemId: item.id,
          summaryIndex,
        })
      this.server.notify('item/reasoning/summaryTextDelta', {
        threadId: this.threadId,
        turnId: this.id,
        itemId: item.id,
        delta: part,
        summaryIndex,
      })
    })
    return this.itemCompleted(item)
  }

  /** A command, run to the end: started, output deltas, completed. */
  command(command: string, script: CommandScript = {}): Item {
    const item = this.commandStarted(command)
    return this.commandCompleted(item, script)
  }

  /** The first half of `command`, for a test that puts an approval (or an
   * interrupt) between the start and the end. */
  commandStarted(command: string): Extract<Item, { type: 'commandExecution' }> {
    return this.itemStarted(commandExecutionItem(command))
  }

  commandCompleted(item: Extract<Item, { type: 'commandExecution' }>, script: CommandScript = {}): Item {
    const output = script.output ?? ''
    for (const delta of script.chunks ?? (output ? [output] : []))
      this.server.notify('item/commandExecution/outputDelta', {
        threadId: this.threadId,
        turnId: this.id,
        itemId: item.id,
        delta,
      })
    const exitCode = script.exitCode ?? 0
    return this.itemCompleted({
      ...item,
      processId: '4243',
      source: 'unifiedExecStartup',
      status: script.status ?? (exitCode === 0 ? 'completed' : 'failed'),
      aggregatedOutput: output || null,
      exitCode,
      durationMs: script.durationMs ?? 100,
    })
  }

  /** A patch, applied: started, completed. */
  fileChange(changes: v2.FileUpdateChange[], status: v2.PatchApplyStatus = 'completed'): Item {
    const item = this.fileChangeStarted(changes)
    return this.itemCompleted({ ...item, status })
  }

  fileChangeStarted(changes: v2.FileUpdateChange[]): Extract<Item, { type: 'fileChange' }> {
    return this.itemStarted(fileChangeItem(changes))
  }

  /** The parent's `subAgentActivity` item for a child starting. Follow it with
   * the child thread's own notifications (`child.turn().started()` …). */
  spawnSubagent(child: FakeCodexThread): Item {
    const item = subAgentActivityItem(child.id, 'started')
    this.itemStarted(item)
    return this.itemCompleted(item)
  }

  /** The parent's `subAgentActivity` item for a child finishing. */
  subagentCompleted(child: FakeCodexThread): Item {
    const item = subAgentActivityItem(child.id, 'completed', { model: null, reasoningEffort: null })
    this.itemStarted(item)
    return this.itemCompleted(item)
  }

  /** `thread/tokenUsage/updated` for this turn. */
  tokenUsage(last: Partial<v2.TokenUsageBreakdown> = {}, total: Partial<v2.TokenUsageBreakdown> = last): this {
    this.server.notify('thread/tokenUsage/updated', {
      threadId: this.threadId,
      turnId: this.id,
      tokenUsage: threadTokenUsage(last, total),
    })
    return this
  }

  /** `turn/completed`, after the thread goes idle, as Codex orders them. A
   * completed turn carries its final answer (`itemsView: "summary"`); an
   * interrupted or failed one carries no items. */
  completed(options: { status?: Exclude<v2.TurnStatus, 'inProgress'>; error?: v2.TurnError | null } = {}): this {
    const status = options.status ?? 'completed'
    const finals = this.items.filter(
      (item) => item.type === 'agentMessage' && item.phase === 'final_answer',
    )
    this.turn = {
      ...this.turn,
      status,
      error: options.error ?? null,
      items: status === 'completed' ? finals : [],
      itemsView: status === 'completed' ? 'summary' : 'notLoaded',
      completedAt: this.turn.startedAt,
      durationMs: 1000,
    }
    this.thread.status({ type: 'idle' })
    this.server.notify('turn/completed', { threadId: this.threadId, turn: this.turn })
    return this
  }

  interrupted(): this {
    return this.completed({ status: 'interrupted' })
  }

  failed(message: string, codexErrorInfo: v2.CodexErrorInfo | null = null): this {
    return this.completed({
      status: 'failed',
      error: { message, codexErrorInfo, additionalDetails: null, misalignment: null },
    })
  }

  // ----------------------------------------------------------- server requests

  /** Ask the client to approve a command, as Codex does: the thread is marked
   * waiting, the request goes out, and once answered `serverRequest/resolved`
   * follows and the thread is active again. Resolves with the answer;
   * rejects if the fake exits before the client answers. */
  requestCommandApproval(
    item: { id: string },
    overrides: Partial<v2.CommandExecutionRequestApprovalParams> = {},
  ): Promise<FakeServerAnswer<'item/commandExecution/requestApproval'>> {
    return this.ask('item/commandExecution/requestApproval', commandApprovalParams(this.context(item.id), overrides))
  }

  requestFileChangeApproval(
    item: { id: string },
    overrides: Partial<v2.FileChangeRequestApprovalParams> = {},
  ): Promise<FakeServerAnswer<'item/fileChange/requestApproval'>> {
    return this.ask('item/fileChange/requestApproval', fileChangeApprovalParams(this.context(item.id), overrides))
  }

  /** The `request_permissions` tool asking for more access. */
  requestPermissions(
    overrides: Partial<v2.PermissionsRequestApprovalParams> = {},
  ): Promise<FakeServerAnswer<'item/permissions/requestApproval'>> {
    return this.ask(
      'item/permissions/requestApproval',
      permissionsApprovalParams(this.context(overrides.itemId ?? `exec-${this.id}`), overrides),
    )
  }

  requestUserInput(
    overrides: Partial<v2.ToolRequestUserInputParams> = {},
  ): Promise<FakeServerAnswer<'item/tool/requestUserInput'>> {
    return this.ask('item/tool/requestUserInput', userInputParams(this.context(overrides.itemId ?? `call_${this.id}`), overrides), 'waitingOnUserInput')
  }

  requestElicitation(
    overrides: Partial<v2.McpServerElicitationRequestParams> = {},
  ): Promise<FakeServerAnswer<'mcpServer/elicitation/request'>> {
    return this.ask(
      'mcpServer/elicitation/request',
      elicitationParams({ threadId: this.threadId, turnId: this.id }, overrides),
      'waitingOnUserInput',
    )
  }

  private context(itemId: string) {
    return { threadId: this.threadId, turnId: this.id, itemId }
  }

  private async ask<M extends ServerRequestMethod>(
    method: M,
    params: ServerRequestParams<M>,
    flag: v2.ThreadActiveFlag = 'waitingOnApproval',
  ): Promise<FakeServerAnswer<M>> {
    this.thread.status({ type: 'active', activeFlags: [flag] })
    const request = this.server.request(method, params)
    const answer = await request.answered
    this.server.resolved(this.threadId, request.id)
    this.thread.status({ type: 'active', activeFlags: [] })
    return answer
  }
}
