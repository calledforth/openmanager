import type {
  SubtaskStatus,
  SubtaskUpdate,
  ToolCall,
  ToolCallStatus,
  ToolCallUpdate,
} from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'

// ---------------------------------------------------------------------------
// Notification scope

/** Notifications that belong to the connection, not to a thread: account,
 * skills, apps, MCP servers, sandbox setup, config. Everything else Codex
 * sends is about one thread, and a session must never take a thread-scoped
 * notification as its own unless the thread is its own: a subagent's
 * notifications arrive on the parent's connection, tagged with the child's
 * thread id, and differ from the parent's in nothing else.
 *
 * MCP startup and `warning` carry a thread id when they concern one thread
 * (a child starting its MCP servers does); only without one are they global. */
export const CODEX_GLOBAL_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'account/updated',
  'account/gatewayOAuth/changed',
  'account/rateLimits/updated',
  'account/login/completed',
  'skills/changed',
  'app/list/updated',
  'project/changed',
  'fs/changed',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'mcpServer/event/stream/notification',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
  'configWarning',
  'deprecationNotice',
  'warning',
  'remoteControl/status/changed',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  // Standalone `command/exec` and `process/*`, which no thread owns.
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
])

export type CodexNotificationScope =
  | { kind: 'global' }
  | { kind: 'thread'; threadId: string }
  /** A thread-scoped notification that names no thread: nobody's, dropped. */
  | { kind: 'unscoped' }

/** Whose a notification is. A thread id wins over the allowlist, so a global
 * method that names a thread (MCP startup for a child) goes to that thread. */
export function codexNotificationScope(method: string, params: unknown): CodexNotificationScope {
  const record = (params ?? {}) as { threadId?: unknown; thread?: { id?: unknown } }
  if (typeof record.threadId === 'string') return { kind: 'thread', threadId: record.threadId }
  // `thread/started` names its thread inside the thread.
  if (method === 'thread/started' && typeof record.thread?.id === 'string')
    return { kind: 'thread', threadId: record.thread.id }
  return CODEX_GLOBAL_NOTIFICATIONS.has(method) ? { kind: 'global' } : { kind: 'unscoped' }
}

/** A subagent's thread: one with a parent, or one Codex says a subagent
 * spawned. Never a session of its own, so never listed or resumed as one. */
export function isCodexSubagentThread(
  thread: Pick<v2.Thread, 'parentThreadId' | 'source'>,
): boolean {
  if (thread.parentThreadId) return true
  const source = thread.source as unknown
  return typeof source === 'object' && source !== null && 'subAgent' in source
}

// ---------------------------------------------------------------------------
// Subagents

type CollabItem = Extract<v2.ThreadItem, { type: 'collabAgentToolCall' | 'subAgentActivity' }>

/** The items that start, reach or report on a subagent. They are the
 * subagent tracker's, not the turn translator's, wherever they appear. */
export function isCodexCollabItem(item: v2.ThreadItem): item is CollabItem {
  return item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity'
}

/** What the subagent tracker says, in openmanager's terms. The runtime stamps
 * the route. */
export type CodexSubagentOutput =
  | { event: 'subtask_update'; data: SubtaskUpdate }
  | { event: 'tool_call'; data: ToolCall }
  | { event: 'tool_call_update'; data: ToolCallUpdate }

type Child = {
  threadId: string
  /** The thread that started it: the session's own, or another child's. */
  parentThreadId: string
  depth: number
  /** The name Codex gave it, when it said: the card's title. */
  name: string | undefined
  status: SubtaskStatus
  /** Its turn in flight, once `turn/started` named it. */
  turnId: string | undefined
  /** Closed with `closeAgent` or `thread/closed`: it will not run again. */
  closed: boolean
  /** Its last answer, for the card. */
  resultText: string | undefined
  /** The last non-retrying error on its turn. */
  error: string | undefined
  tokens: number | undefined
  toolCallCount: number
  prompt: string | undefined
  modelId: string | undefined
}

/** Items that are a tool call of the child's, for its card's count. */
const TOOL_ITEMS: ReadonlySet<string> = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
])

/** Turns started on threads not (yet) known as children, kept until one is.
 * Codex has been seen to start a child's turn right after the parent's
 * `subAgentActivity` item, and nothing promises the order. */
const BUFFERED_TURNS_MAX = 32

const RUNNING: ReadonlySet<SubtaskStatus> = new Set(['pending', 'running'])

/** A Codex session's subagents: child threads on the parent's connection
 * (docs/decisions/codex-app-server.md, "Subagents").
 *
 * Codex sends a child's whole stream (status, turns, items, deltas, usage, MCP
 * startup) on the parent's connection under the child's thread id, and sends
 * no `thread/started` for it: a child is known only from the item that
 * started it, a `subAgentActivity` (`kind: "started"`) or, from older Codex,
 * a `collabAgentToolCall` `spawnAgent`. This keeps that stream out of the
 * parent: a child's notifications only move its own record here, never the
 * parent's turn, messages or usage.
 *
 * Until children have pages of their own (CAL-279), the parent shows them as
 * rows: each child is a subagent card (`subtask_update`, keyed by the child's
 * thread id, as docs/decisions/subagents.md says for Codex), running while it
 * runs and settled with its answer; the parent's other collab calls (wait,
 * send, resume, close, interrupt, list) are tool rows, so its waiting shows. */
export class CodexSubagents {
  private readonly children = new Map<string, Child>()
  /** Child thread id → its turn, for a turn that started before its thread
   * was known as a child. */
  private readonly bufferedTurns = new Map<string, string>()
  private waiters: (() => void)[] = []

  constructor(
    /** The session's own thread, once it has one. */
    private readonly rootThreadId: () => string | undefined,
    private readonly emit: (output: CodexSubagentOutput) => void,
  ) {}

  /** Whether any child has work under way, or was started and has not begun
   * it yet. Such a child lives in the parent's process, so the parent counts
   * as busy while it runs. */
  get running(): boolean {
    for (const child of this.children.values()) if (this.isRunning(child)) return true
    return false
  }

  has(threadId: string): boolean {
    return this.children.has(threadId)
  }

  /** Turns running on children, the session's whole tree, to interrupt. */
  activeTurns(under?: string): { threadId: string; turnId: string }[] {
    const turns: { threadId: string; turnId: string }[] = []
    for (const child of this.children.values()) {
      if (!child.turnId) continue
      if (under !== undefined && !this.isWithin(child, under)) continue
      turns.push({ threadId: child.threadId, turnId: child.turnId })
    }
    return turns
  }

  /** Whether `threadId`, or a child under it, has work under way. */
  runningWithin(threadId: string): boolean {
    for (const child of this.children.values())
      if (this.isWithin(child, threadId) && this.isRunning(child)) return true
    return false
  }

  /** Resolves on the next change to any child: one registered, a turn
   * started or ended. What a stop waits on to look again. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** A collab item on the session's own thread or a child's. `rows` says
   * whether the parent may show it as a tool row: only an item of the
   * parent's own turn in flight may; a child's calls are its own work.
   * Handles every activity kind and every collab tool; the rest are ignored
   * the way unknown items are. */
  item(
    senderThreadId: string,
    item: CollabItem,
    phase: 'started' | 'completed',
    rows: boolean,
  ): void {
    if (item.type === 'subAgentActivity') {
      this.activity(senderThreadId, item)
      return
    }
    const receivers = item.receiverThreadIds
    switch (item.tool) {
      case 'spawnAgent':
        // Older Codex: the call is the spawn, and its receiver the child, once
        // it has one. A failed spawn has none.
        for (const threadId of receivers)
          this.register(threadId, senderThreadId, {
            toolCallId: item.id,
            ...(item.prompt ? { prompt: item.prompt } : {}),
            ...(item.model ? { modelId: item.model } : {}),
          })
        break
      case 'sendInput':
      case 'sendMessage':
      case 'followupTask':
      case 'resumeAgent':
        // Reaching a child this runtime never saw start (one spawned before a
        // restart) makes it known, so its stream is kept out of the parent
        // too. Its next turn says it runs.
        for (const threadId of receivers) {
          this.register(threadId, senderThreadId, { toolCallId: item.id, status: 'pending' })
          const child = this.children.get(threadId)
          if (child && item.tool === 'resumeAgent') child.closed = false
        }
        break
      case 'closeAgent':
        if (phase === 'completed' && item.status === 'completed')
          for (const threadId of receivers) {
            const child = this.children.get(threadId)
            if (child) child.closed = true
          }
        break
      case 'wait':
      case 'interruptAgent':
      case 'listAgents':
        break
    }
    if (phase === 'completed') this.applyStates(item.agentsStates)
    if (rows && item.tool !== 'spawnAgent') this.row(item, phase)
    this.notify()
  }

  /** `thread/started` for another thread: Codex 0.170 sends none for a
   * child, but one that names a known parent is a child all the same. */
  threadStarted(thread: v2.Thread): void {
    const parent = thread.parentThreadId
    if (!parent || (parent !== this.rootThreadId() && !this.children.has(parent))) return
    this.register(thread.id, parent, {
      ...(thread.agentNickname ? { title: thread.agentNickname } : {}),
    })
  }

  /** A notification on a thread that is not the session's own. True when it
   * was a child's (or one buffered for a child to come), which is then
   * applied to that child's record and nothing else; false when it is
   * nobody's. */
  notification(method: string, threadId: string, params: unknown): boolean {
    const child = this.children.get(threadId)
    if (!child) return this.beforeRegistration(method, threadId, params)
    switch (method) {
      case 'turn/started': {
        const { turn } = params as v2.TurnStartedNotification
        child.turnId = turn.id
        child.error = undefined
        this.setStatus(child, 'running')
        break
      }
      case 'turn/completed': {
        const { turn } = params as v2.TurnCompletedNotification
        if (child.turnId !== undefined && child.turnId !== turn.id) break
        child.turnId = undefined
        this.settle(child, turn)
        break
      }
      case 'item/started':
      case 'item/completed': {
        const { item } = params as v2.ItemStartedNotification | v2.ItemCompletedNotification
        const phase = method === 'item/started' ? 'started' : 'completed'
        // A child's own subagents are children too, one level down.
        if (isCodexCollabItem(item)) this.item(threadId, item, phase, false)
        if (phase === 'completed') this.childItemCompleted(child, item)
        break
      }
      case 'thread/tokenUsage/updated':
        child.tokens = (
          params as v2.ThreadTokenUsageUpdatedNotification
        ).tokenUsage.total.totalTokens
        break
      case 'error': {
        const notice = params as v2.ErrorNotification
        if (!notice.willRetry) child.error = notice.error.message
        break
      }
      case 'thread/status/changed': {
        const { status } = params as v2.ThreadStatusChangedNotification
        if (status.type === 'systemError' && this.isRunning(child)) {
          child.turnId = undefined
          this.setStatus(child, 'failed', {
            statusReason: child.error ?? 'Codex reported a system error',
          })
        }
        break
      }
      case 'thread/closed':
        child.closed = true
        if (this.isRunning(child)) {
          child.turnId = undefined
          this.setStatus(child, 'cancelled')
        }
        break
      default:
        // Deltas, MCP startup, settings and the rest: the child's own work,
        // for its page once it has one (CAL-279).
        break
    }
    this.notify()
    return true
  }

  /** The parent's turn ended and these children run on: they are in the
   * background now, and the host must not end them with the turn. */
  parentTurnEnded(): void {
    for (const child of this.children.values())
      if (child.depth === 1 && this.isRunning(child))
        this.emit({ event: 'subtask_update', data: { taskId: child.threadId, background: true } })
  }

  /** The process is gone, and every child with it. The host ends their cards
   * on the exit; nothing here is running any more. */
  clear(): void {
    this.children.clear()
    this.bufferedTurns.clear()
    this.notify()
  }

  // -------------------------------------------------------------------------

  private activity(
    senderThreadId: string,
    item: Extract<CollabItem, { type: 'subAgentActivity' }>,
  ): void {
    const threadId = item.agentThreadId
    const known = this.children.get(threadId)
    switch (item.kind) {
      case 'started':
        this.register(threadId, senderThreadId, {
          toolCallId: item.id,
          title: titleOf(item.agentPath),
          ...(item.model ? { modelId: item.model } : {}),
        })
        break
      case 'interacted':
        // The parent reached it: a revival when it had settled. Its turn says
        // when it runs; until then it is known, so its stream is kept apart.
        if (!known)
          this.register(threadId, senderThreadId, {
            title: titleOf(item.agentPath),
            status: 'pending',
          })
        else known.closed = false
        break
      case 'interrupted':
      case 'completed':
        // The parent's view, which arrives before the child's own
        // `turn/completed`; that has the last word on how the turn ended, and
        // the child counts as running until it comes.
        if (known) this.setStatus(known, item.kind)
        break
    }
    this.notify()
  }

  private register(
    threadId: string,
    parentThreadId: string,
    report: Omit<SubtaskUpdate, 'taskId'> & { title?: string },
  ): void {
    if (threadId === this.rootThreadId()) return
    const existing = this.children.get(threadId)
    if (existing) {
      // A second report of the same child (the item's start, then its end;
      // the 0.170 activity and an older spawn call) only adds what was missing.
      const prompt = report.prompt && !existing.prompt ? report.prompt : undefined
      const modelId = report.modelId && !existing.modelId ? report.modelId : undefined
      existing.prompt ??= prompt
      existing.modelId ??= modelId
      if (prompt || modelId)
        this.emit({
          event: 'subtask_update',
          data: {
            taskId: threadId,
            ...(prompt ? { prompt } : {}),
            ...(modelId ? { modelId } : {}),
          },
        })
      return
    }
    const parent = this.children.get(parentThreadId)
    const child: Child = {
      threadId,
      parentThreadId,
      depth: (parent?.depth ?? 0) + 1,
      name: report.title,
      status: report.status ?? 'running',
      turnId: undefined,
      closed: false,
      resultText: undefined,
      error: undefined,
      tokens: undefined,
      toolCallCount: 0,
      prompt: report.prompt,
      modelId: report.modelId,
    }
    this.children.set(threadId, child)
    const buffered = this.bufferedTurns.get(threadId)
    if (buffered) {
      this.bufferedTurns.delete(threadId)
      child.turnId = buffered
      child.status = 'running'
    }
    this.emit({
      event: 'subtask_update',
      data: {
        ...report,
        taskId: threadId,
        title: child.name ?? 'Subagent',
        status: child.status,
        statusSource: 'task_event',
        depth: child.depth,
        ...(parent ? { parentTaskId: parent.threadId } : {}),
        stoppable: true,
        promptable: false,
      },
    })
    this.notify()
  }

  private beforeRegistration(method: string, threadId: string, params: unknown): boolean {
    switch (method) {
      case 'thread/started': {
        this.threadStarted((params as v2.ThreadStartedNotification).thread)
        return this.children.has(threadId)
      }
      case 'turn/started': {
        const { turn } = params as v2.TurnStartedNotification
        this.bufferedTurns.delete(threadId)
        this.bufferedTurns.set(threadId, turn.id)
        // Oldest first: a thread that never turned out to be a child goes.
        if (this.bufferedTurns.size > BUFFERED_TURNS_MAX)
          this.bufferedTurns.delete(this.bufferedTurns.keys().next().value!)
        return true
      }
      case 'turn/completed': {
        const { turn } = params as v2.TurnCompletedNotification
        if (this.bufferedTurns.get(threadId) === turn.id) this.bufferedTurns.delete(threadId)
        return this.bufferedTurns.has(threadId)
      }
      default:
        return false
    }
  }

  private childItemCompleted(child: Child, item: v2.ThreadItem): void {
    if (item.type === 'agentMessage') {
      // The answer, not the narration on the way to it.
      if (item.phase !== 'commentary' && item.text) child.resultText = item.text
      return
    }
    if (TOOL_ITEMS.has(item.type)) child.toolCallCount++
  }

  private settle(child: Child, turn: v2.Turn): void {
    switch (turn.status) {
      case 'completed':
        this.setStatus(child, 'completed', {}, true)
        return
      case 'interrupted':
        this.setStatus(child, 'interrupted', {}, true)
        return
      case 'failed':
        this.setStatus(
          child,
          'failed',
          { statusReason: turn.error?.message ?? child.error ?? 'Codex turn failed' },
          true,
        )
        return
      case 'inProgress':
        return
    }
  }

  /** Report a status, once per change. A settled report carries what the
   * child produced, and a turn's own end always reports: the parent's
   * `completed` activity comes before the child's last message is counted. */
  private setStatus(
    child: Child,
    status: SubtaskStatus,
    extra: Partial<SubtaskUpdate> = {},
    force = false,
  ): void {
    if (child.status === status && !force) return
    const settled = !RUNNING.has(status)
    child.status = status
    this.emit({
      event: 'subtask_update',
      data: {
        taskId: child.threadId,
        status,
        statusSource: force ? 'turn_result' : 'task_event',
        ...(settled && child.resultText ? { resultText: child.resultText } : {}),
        ...(settled && child.tokens !== undefined ? { tokens: child.tokens } : {}),
        ...(settled ? { toolCallCount: child.toolCallCount } : {}),
        ...extra,
      },
    })
  }

  /** What `wait`, `list` and the rest last saw of their children. The child's
   * own turn is the better witness, so a child running a turn here keeps its
   * status; only a quiet child is settled from what the parent was told. */
  private applyStates(states: { [threadId: string]: v2.CollabAgentState | undefined }): void {
    for (const [threadId, state] of Object.entries(states)) {
      const child = this.children.get(threadId)
      if (!child || !state || child.turnId) continue
      if (state.message && state.status === 'completed') child.resultText = state.message
      const status = subtaskStatusOf(state.status)
      if (status === 'shutdown') {
        child.closed = true
        if (this.isRunning(child)) this.setStatus(child, 'cancelled')
      } else if (status && !RUNNING.has(status)) {
        this.setStatus(
          child,
          status,
          status === 'failed' && state.message ? { statusReason: state.message } : {},
        )
      }
    }
  }

  /** The parent's own collab call, shown as a tool row so the parent's
   * waiting and messaging show between its cards. */
  private row(
    item: Extract<CollabItem, { type: 'collabAgentToolCall' }>,
    phase: 'started' | 'completed',
  ): void {
    const names = item.receiverThreadIds.map((id) => this.children.get(id)?.name ?? 'a subagent')
    const status: ToolCallStatus =
      item.status === 'inProgress'
        ? 'in_progress'
        : item.status === 'completed'
          ? 'completed'
          : 'failed'
    const call: ToolCall = {
      toolCallId: item.id,
      title: rowTitle(item.tool, names),
      kind: 'other',
      status,
      toolName: item.tool,
      rawInput: {
        receiverThreadIds: item.receiverThreadIds,
        ...(item.prompt ? { prompt: item.prompt } : {}),
      },
      ...(item.status === 'interrupted' ? { outcome: 'cancelled' as const } : {}),
    }
    if (phase === 'started') this.emit({ event: 'tool_call', data: call })
    else
      this.emit({
        event: 'tool_call_update',
        data: { ...call, rawOutput: { agentsStates: item.agentsStates } },
      })
  }

  private isRunning(child: Child): boolean {
    return !child.closed && (child.turnId !== undefined || RUNNING.has(child.status))
  }

  private isWithin(child: Child, ancestor: string): boolean {
    for (let at: Child | undefined = child; at; at = this.children.get(at.parentThreadId))
      if (at.threadId === ancestor) return true
    return false
  }

  private notify(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
}

/** `/root/exact_reply` → `exact_reply`: the name Codex gave the agent. */
function titleOf(agentPath: string): string {
  return agentPath.split('/').filter(Boolean).at(-1) ?? 'Subagent'
}

function rowTitle(tool: v2.CollabAgentTool, names: string[]): string {
  const who = names.length > 0 ? names.join(', ') : undefined
  switch (tool) {
    case 'wait':
      return who ? `Waiting for ${who}` : 'Waiting for subagents'
    case 'sendInput':
    case 'sendMessage':
    case 'followupTask':
      return `Messaging ${who ?? 'a subagent'}`
    case 'resumeAgent':
      return `Resuming ${who ?? 'a subagent'}`
    case 'closeAgent':
      return `Closing ${who ?? 'a subagent'}`
    case 'interruptAgent':
      return `Interrupting ${who ?? 'a subagent'}`
    case 'listAgents':
      return 'Listing subagents'
    case 'spawnAgent':
      return `Starting ${who ?? 'a subagent'}`
  }
}

/** A collab agent state in subtask terms; `shutdown` is kept apart (closed),
 * and `notFound` says nothing. */
function subtaskStatusOf(status: v2.CollabAgentStatus): SubtaskStatus | 'shutdown' | undefined {
  switch (status) {
    case 'pendingInit':
      return 'pending'
    case 'running':
      return 'running'
    case 'interrupted':
      return 'interrupted'
    case 'completed':
      return 'completed'
    case 'errored':
      return 'failed'
    case 'shutdown':
      return 'shutdown'
    case 'notFound':
      return undefined
  }
}
