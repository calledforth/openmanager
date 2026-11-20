import type { BackgroundTask } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import type { HostLogEntry } from '../../host.js'
import type { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexRpcError } from './CodexRpcPeer.js'

/** Pages of `thread/backgroundTerminals/list` read at most. The host shows
 * 64 tasks a session at most; this is well past that. */
const LIST_PAGES_MAX = 8

export type CodexBackgroundTerminalsDeps = {
  /** The provider's `supportsBackgroundTasks`: false lists and stops nothing. */
  enabled: boolean
  /** The live connection, or undefined once the process is gone. */
  client: () => CodexAppServerClient | undefined
  /** The session's thread, once Codex has named it. */
  threadId: () => string | undefined
  timeoutMs: number
  /** Every live terminal, whenever the set changes (`background_tasks_update`). */
  announce: (tasks: BackgroundTask[]) => void
  log: (entry: HostLogEntry) => void
}

/**
 * Codex's background terminals: commands a turn left running, as the
 * session's background tasks (kind `shell`, keyed by Codex's `processId`).
 *
 * A unified-exec command (one with a `processId`) still open when its turn
 * ends runs on, and `CodexTools.finish` settles its row as still running in
 * the background. Codex sends nothing when such a process starts or ends
 * except the command's own late `item/completed`, so the roster is read from
 * `thread/backgroundTerminals/list` (experimental) whenever it can have
 * changed: a turn ended with a process open, a listed command completed, a
 * terminal was stopped. Probed on 0.170: the list names each by `itemId`
 * (the command's item), `processId` and the unwrapped `command`;
 * `terminate` answers `terminated: false` for a process already gone, and
 * both answer `-32600 thread not found` for a thread the process does not
 * hold. Both count as stopped.
 *
 * A Codex that refuses the list (an older one, or one without the
 * experimental API) has no background tasks for the rest of the process.
 */
export class CodexBackgroundTerminals {
  private tasks: BackgroundTask[] = []
  /** The command item of each listed process, by process id. */
  private items = new Map<string, string>()
  /** A turn has left a process running: until then the thread holds none,
   * and a stop need not ask. */
  private held = false
  private unsupported = false
  private closed = false
  private refreshing: Promise<void> | undefined
  private dirty = false

  constructor(private readonly deps: CodexBackgroundTerminalsDeps) {}

  /** Processes are running that no turn is awaiting. */
  get busy(): boolean {
    return this.tasks.length > 0
  }

  private get active(): boolean {
    return this.deps.enabled && !this.unsupported && !this.closed
  }

  /**
   * A turn ended, leaving `running` (the processes of its commands still
   * open). A turn the user stopped takes them with it, as its rows say
   * (they close as cancelled) and as T3 Code does; any other end leaves them
   * running in the background.
   */
  turnEnded(running: readonly string[], stopped: boolean): void {
    if (!this.active) return
    if (running.length > 0) this.held = true
    if (stopped && running.length > 0) {
      void this.terminate(running)
        .catch((error: unknown) => this.warn('Could not stop the commands of a stopped Codex turn', error))
        .then(() => this.refresh())
      return
    }
    if (running.length > 0 || this.tasks.length > 0) void this.refresh()
  }

  /** `item/completed`, from any turn: a listed command that ended (by
   * itself, or stopped) changes the roster. */
  itemCompleted(item: v2.ThreadItem): void {
    if (!this.active || item.type !== 'commandExecution') return
    const listed =
      (item.processId !== null && this.items.has(item.processId)) ||
      [...this.items.values()].includes(item.id)
    if (listed) void this.refresh()
  }

  /** Stop the named terminals, or every listed one. Ids no longer listed are
   * skipped: a process that ended between the click and the request is
   * already stopped. Rejects only when Codex could not be asked. */
  async stop(processIds?: readonly string[]): Promise<void> {
    if (!this.active) return
    const live = this.tasks.map((task) => task.taskId)
    const targets = processIds ? live.filter((id) => processIds.includes(id)) : live
    if (targets.length === 0) return
    try {
      await this.terminate(targets)
    } finally {
      await this.refresh()
    }
  }

  /** The session is stopping: end every process the thread retains, read
   * fresh rather than from the roster, since the turn the stop interrupted
   * leaves its commands (`running`) running too. Asks nothing of a thread
   * no turn ever left a process on. Never rejects; the caller bounds the
   * wait. */
  async stopAll(running: readonly string[] = []): Promise<void> {
    if (!this.active || (!this.held && running.length === 0)) return
    try {
      const listed = await this.list()
      const ids = listed?.map((terminal) => terminal.processId) ?? []
      if (ids.length > 0) await this.terminate(ids)
    } catch (error) {
      this.warn('Could not stop Codex background terminals before stopping the session', error)
    }
  }

  /** The process is gone, and its terminals with it. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.apply([])
  }

  /** Read the roster again. Reads are serialised and coalesced: a change
   * noticed during a read is read once more after it. Never rejects. */
  refresh(): Promise<void> {
    this.dirty = true
    this.refreshing ??= this.drain().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async drain(): Promise<void> {
    while (this.dirty && this.active) {
      this.dirty = false
      let listed: v2.ThreadBackgroundTerminal[] | undefined
      try {
        listed = await this.list()
      } catch (error) {
        // Not read (a timeout, the pipe): what was listed stays listed.
        this.warn('Could not list Codex background terminals', error)
        continue
      }
      if (listed && this.active) this.apply(listed.map(toTask), listed)
    }
  }

  /** Every terminal the thread holds; undefined when there is nothing to
   * ask (no process, no thread yet). An empty list for a thread Codex does
   * not hold; and empty, for good, when Codex refuses the method. */
  private async list(): Promise<v2.ThreadBackgroundTerminal[] | undefined> {
    const client = this.deps.client()
    const threadId = this.deps.threadId()
    if (!client || !threadId) return undefined
    const terminals: v2.ThreadBackgroundTerminal[] = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < LIST_PAGES_MAX; page++) {
        const response: v2.ThreadBackgroundTerminalsListResponse = await client.request(
          'thread/backgroundTerminals/list',
          { threadId, ...(cursor ? { cursor } : {}) },
          { timeoutMs: this.deps.timeoutMs },
        )
        terminals.push(...response.data)
        cursor = response.nextCursor
        if (!cursor) break
      }
    } catch (error) {
      if (threadGone(error)) return []
      if (!(error instanceof CodexRpcError)) throw error
      this.unsupported = true
      this.deps.log({
        scope: 'codex',
        level: 'info',
        message: 'Codex refused to list background terminals; none are shown for this session',
        data: { error: error.message },
      })
      this.apply([])
      return []
    }
    return terminals
  }

  /** Every one is asked, and every answer awaited, before the first real
   * failure is thrown. */
  private async terminate(processIds: readonly string[]): Promise<void> {
    const client = this.deps.client()
    const threadId = this.deps.threadId()
    if (!client || !threadId) return
    const results = await Promise.allSettled(
      processIds.map((processId) =>
        client.request(
          'thread/backgroundTerminals/terminate',
          { threadId, processId },
          { timeoutMs: this.deps.timeoutMs },
        ),
      ),
    )
    // `terminated: false` is a process already gone: stopped either way.
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected' && !threadGone(result.reason),
    )
    if (failed) throw failed.reason
  }

  private apply(tasks: BackgroundTask[], terminals: readonly v2.ThreadBackgroundTerminal[] = []): void {
    this.items = new Map(terminals.map((terminal) => [terminal.processId, terminal.itemId]))
    if (sameTasks(this.tasks, tasks)) return
    this.tasks = tasks
    this.deps.announce(tasks)
  }

  private warn(message: string, error: unknown): void {
    this.deps.log({
      scope: 'codex',
      level: 'warn',
      message,
      data: { error: error instanceof Error ? error.message : String(error) },
    })
  }
}

function toTask(terminal: v2.ThreadBackgroundTerminal): BackgroundTask {
  return { taskId: terminal.processId, kind: 'shell', description: terminal.command }
}

/** `-32600 thread not found: …` (probed on 0.170): the process holds no
 * such thread, so it holds none of its terminals either. */
function threadGone(error: unknown): boolean {
  return error instanceof CodexRpcError && /thread not found/i.test(error.message)
}

function sameTasks(a: readonly BackgroundTask[], b: readonly BackgroundTask[]): boolean {
  return (
    a.length === b.length &&
    a.every((task, index) => {
      const other = b[index]!
      return task.taskId === other.taskId && task.kind === other.kind && task.description === other.description
    })
  )
}
