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
  /** The item that started or reached it: the card's anchor. */
  toolCallId: string | undefined
  prompt: string | undefined
  modelId: string | undefined
  /** Its card is out: Codex said it exists (it was spawned, ran a turn, or a
   * collab call saw it running). Until then it is only known, so its stream
   * is kept apart, and it neither shows nor counts as running. */
  shown: boolean
  /** Reported as running on after the parent's turn ended. */
  background: boolean
  status: SubtaskStatus
  /** Its turn in flight, once `turn/started` named it. */
  turnId: string | undefined
  closed: boolean
  /** Its last answer, for the card. */
  resultText: string | undefined
  /** The last non-retrying error on its turn. */
  error: string | undefined
  tokens: number | undefined
  toolCallCount: number
}

type ChildInfo = Partial<Pick<Child, 'name' | 'toolCallId' | 'prompt' | 'modelId'>>

/** A turn that started and ended on a thread before it was known as a child. */
type EndedTurn = { status: SubtaskStatus; reason: string | undefined }

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

/** Turns on threads not (yet) known as children, kept until one is. Codex
 * has been seen to start a child's turn right after the parent's
 * `subAgentActivity` item, and with an older Codex's `spawnAgent` a child's
 * whole turn can run before the call that names it completes: nothing
 * promises the order. Bounded, oldest out first: a thread that never turns
 * out to be a child goes. */
const BUFFERED_TURNS_MAX = 32

const RUNNING: ReadonlySet<SubtaskStatus> = new Set(['pending', 'running'])

/** Settled children kept known, oldest forgotten first. A settled child is
 * kept so a late notification of its own still goes to it rather than being
 * dropped, and so a revival finds its name; past this many, the oldest that
 * no known child descends from is forgotten (a revival makes it known
 * again). Bounds what a long session accumulates. */
export const SETTLED_CHILDREN_MAX = 32

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
  /** Child thread id → its turn in flight, for a turn that started before
   * its thread was known as a child. */
  private readonly bufferedTurns = new Map<string, string>()
  /** Child thread id → how its turn ended, for one that started and ended
   * before its thread was known as a child. */
  private readonly endedTurns = new Map<string, EndedTurn>()
  private waiters: (() => void)[] = []

  constructor(
    /** The session's own thread, once it has one. */
    private readonly rootThreadId: () => string | undefined,
    /** Whether the session's own turn is in flight. */
    private readonly parentTurnActive: () => boolean,
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
      if (!child.turnId || child.closed) continue
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

  /** Resolves on the next change a stop cares about: a child registered or
   * settled, a turn started or ended. Not on deltas. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** A collab item on the session's own thread or a child's. `rows` says
   * whether the parent may show it as a tool row: only an item of the
   * parent's own turn in flight may; a child's calls are its own work.
   * Handles every activity kind and every collab tool. */
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
        // too; but the call may name a thread Codex does not have, so it gets
        // no card until it runs.
        for (const threadId of receivers) {
          const child = this.children.get(threadId)
          if (child) {
            if (item.tool === 'resumeAgent') child.closed = false
          } else this.register(threadId, senderThreadId, { toolCallId: item.id }, true)
        }
        break
      case 'closeAgent':
        if (phase === 'completed' && item.status === 'completed')
          for (const threadId of receivers) {
            const child = this.children.get(threadId)
            if (child) this.close(child)
          }
        break
      case 'wait':
      case 'interruptAgent':
      case 'listAgents':
        break
    }
    if (phase === 'completed') this.applyStates(item.agentsStates)
    if (rows && item.tool !== 'spawnAgent') this.row(item, phase)
  }

  /** `thread/started` for another thread: Codex 0.170 sends none for a
   * child, but one that names a known parent is a child all the same. */
  threadStarted(thread: v2.Thread): void {
    const parent = thread.parentThreadId
    if (!parent || (parent !== this.rootThreadId() && !this.children.has(parent))) return
    this.register(thread.id, parent, thread.agentNickname ? { name: thread.agentNickname } : {})
  }

  /** A notification on a thread that is not the session's own. True when it
   * was a child's (or kept for a child to come), which is then applied to
   * that child's record and nothing else; false when it is nobody's. */
  notification(method: string, threadId: string, params: unknown): boolean {
    const child = this.children.get(threadId)
    if (!child) return this.beforeRegistration(method, threadId, params)
    switch (method) {
      case 'turn/started': {
        const { turn } = params as v2.TurnStartedNotification
        child.turnId = turn.id
        child.error = undefined
        this.setStatus(child, 'running')
        // Interruptible now, whether or not its status moved.
        this.notify()
        break
      }
      case 'turn/completed': {
        const { turn } = params as v2.TurnCompletedNotification
        if (child.turnId !== undefined && child.turnId !== turn.id) break
        child.turnId = undefined
        const ended = endedTurn(turn, child.error)
        if (ended) this.setStatus(child, ended.status, reasonOf(ended), true)
        this.notify()
        this.prune()
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
        this.close(child)
        break
      default:
        // Deltas, MCP startup, settings and the rest: the child's own work,
        // for its page once it has one (CAL-279).
        break
    }
    return true
  }

  /** The parent's turn ended and these children run on: they are in the
   * background now, and the host must not end them with the turn. */
  parentTurnEnded(): void {
    for (const child of this.children.values())
      if (this.isRunning(child) && !child.background) {
        child.background = true
        this.emit({ event: 'subtask_update', data: { taskId: child.threadId, background: true } })
      }
  }

  /** The process is gone, and every child with it. The host ends their cards
   * on the exit; nothing here is running any more. */
  clear(): void {
    this.children.clear()
    this.bufferedTurns.clear()
    this.endedTurns.clear()
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
          name: titleOf(item.agentPath),
          ...(item.model ? { modelId: item.model } : {}),
        })
        break
      case 'interacted':
        // The parent reached it: a revival when it had settled. Its turn says
        // when it runs; until then it is known, so its stream is kept apart.
        if (!known) this.register(threadId, senderThreadId, { name: titleOf(item.agentPath) }, true)
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
  }

  /** Know a child. `quiet` when Codex has not said it exists: it is then
   * kept apart without a card until it runs. */
  private register(threadId: string, parentThreadId: string, info: ChildInfo, quiet = false): void {
    if (threadId === this.rootThreadId()) return
    const existing = this.children.get(threadId)
    if (existing) {
      // A second report of the same child (the item's start, then its end;
      // the 0.170 activity and an older spawn call) only adds what was missing.
      const prompt = info.prompt && !existing.prompt ? info.prompt : undefined
      const modelId = info.modelId && !existing.modelId ? info.modelId : undefined
      existing.prompt ??= prompt
      existing.modelId ??= modelId
      existing.name ??= info.name
      existing.toolCallId ??= info.toolCallId
      if (!existing.shown) {
        if (!quiet) this.reveal(existing, 'running')
      } else if (prompt || modelId)
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
      name: info.name,
      toolCallId: info.toolCallId,
      prompt: info.prompt,
      modelId: info.modelId,
      shown: false,
      background: false,
      status: 'pending',
      turnId: undefined,
      closed: false,
      resultText: undefined,
      error: undefined,
      tokens: undefined,
      toolCallCount: 0,
    }
    this.children.set(threadId, child)
    const buffered = this.bufferedTurns.get(threadId)
    const ended = this.endedTurns.get(threadId)
    this.bufferedTurns.delete(threadId)
    this.endedTurns.delete(threadId)
    if (buffered) {
      child.turnId = buffered
      this.reveal(child, 'running')
    } else if (ended) {
      // It ran, so it shows, and it is already done.
      this.reveal(child, ended.status, reasonOf(ended))
    } else if (!quiet) this.reveal(child, 'running')
    this.notify()
  }

  /** Put out a child's card, whole. A child that starts running while the
   * parent has no turn in flight is in the background from the start. */
  private reveal(child: Child, status: SubtaskStatus, extra: Partial<SubtaskUpdate> = {}): void {
    child.shown = true
    child.status = status
    if (RUNNING.has(status) && !this.parentTurnActive()) child.background = true
    const parent = this.children.get(child.parentThreadId)
    this.emit({
      event: 'subtask_update',
      data: {
        taskId: child.threadId,
        ...(child.toolCallId ? { toolCallId: child.toolCallId } : {}),
        title: child.name ?? 'Subagent',
        ...(child.prompt ? { prompt: child.prompt } : {}),
        ...(child.modelId ? { modelId: child.modelId } : {}),
        status,
        statusSource: 'task_event',
        depth: child.depth,
        ...(parent ? { parentTaskId: parent.threadId } : {}),
        ...(child.background ? { background: true } : {}),
        stoppable: true,
        promptable: false,
        ...extra,
      },
    })
    this.notify()
  }

  /** Closed with `closeAgent`, `thread/closed` or a `shutdown` state: it will
   * not run again. A running card is cancelled, and the child is forgotten
   * (a later `resumeAgent` makes it known again). */
  private close(child: Child): void {
    const wasRunning = this.isRunning(child)
    child.closed = true
    child.turnId = undefined
    if (wasRunning) this.setStatus(child, 'cancelled')
    this.children.delete(child.threadId)
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
        this.endedTurns.delete(threadId)
        remember(this.bufferedTurns, threadId, turn.id)
        return true
      }
      case 'turn/completed': {
        const { turn } = params as v2.TurnCompletedNotification
        const buffered = this.bufferedTurns.get(threadId)
        if (buffered !== undefined && buffered !== turn.id) return true
        this.bufferedTurns.delete(threadId)
        const ended = endedTurn(turn, undefined)
        if (ended) remember(this.endedTurns, threadId, ended)
        return true
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

  /** Report a status, once per change. A settled report carries what the
   * child produced, and a turn's own end always reports: the parent's
   * `completed` activity comes before the child's last message is counted.
   * A child without a card gets one when it runs, and none for settling. */
  private setStatus(
    child: Child,
    status: SubtaskStatus,
    extra: Partial<SubtaskUpdate> = {},
    force = false,
  ): void {
    if (!child.shown) {
      if (RUNNING.has(status)) this.reveal(child, status, extra)
      else child.status = status
      return
    }
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
    this.notify()
  }

  /** What `wait`, `list` and the rest last saw of their children. The child's
   * own turn is the better witness, so a child running a turn here keeps its
   * status. Codex saying a child runs gives a known child its card; saying it
   * has no such agent forgets a child that never showed. */
  private applyStates(states: { [threadId: string]: v2.CollabAgentState | undefined }): void {
    for (const [threadId, state] of Object.entries(states)) {
      const child = this.children.get(threadId)
      if (!child || !state || child.turnId) continue
      if (state.status === 'notFound') {
        if (!child.shown) this.children.delete(threadId)
        continue
      }
      if (state.message && state.status === 'completed') child.resultText = state.message
      const status = subtaskStatusOf(state.status)
      if (status === 'shutdown') this.close(child)
      else if (status && RUNNING.has(status)) {
        if (!child.shown) this.reveal(child, status)
      } else if (status) {
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

  /** Forget the oldest settled children past `SETTLED_CHILDREN_MAX`, never
   * one still running or one a known child descends from. */
  private prune(): void {
    const settled = [...this.children.values()].filter((child) => !this.isRunning(child))
    let excess = settled.length - SETTLED_CHILDREN_MAX
    for (const child of settled) {
      if (excess <= 0) return
      const referenced = [...this.children.values()].some(
        (other) => other.parentThreadId === child.threadId,
      )
      if (referenced) continue
      this.children.delete(child.threadId)
      excess--
    }
  }

  /** How many children are known, settled ones included. */
  get size(): number {
    return this.children.size
  }

  private isRunning(child: Child): boolean {
    if (child.closed) return false
    return child.turnId !== undefined || (child.shown && RUNNING.has(child.status))
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

/** Set `key` last in a bounded map, dropping the oldest past the bound. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > BUFFERED_TURNS_MAX) map.delete(map.keys().next().value!)
}

/** How a finished turn ended, in subtask terms; undefined while it runs. */
function endedTurn(turn: v2.Turn, error: string | undefined): EndedTurn | undefined {
  switch (turn.status) {
    case 'completed':
      return { status: 'completed', reason: undefined }
    case 'interrupted':
      return { status: 'interrupted', reason: undefined }
    case 'failed':
      return { status: 'failed', reason: turn.error?.message ?? error ?? 'Codex turn failed' }
    case 'inProgress':
      return undefined
  }
}

function reasonOf(ended: EndedTurn): Partial<SubtaskUpdate> {
  return ended.reason ? { statusReason: ended.reason } : {}
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
 * and `notFound` (handled before this) says nothing. */
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
