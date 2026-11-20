import type { BackgroundTask } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import type { HostLogEntry } from '../../host.js'
import type { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexRpcError, RPC_METHOD_NOT_FOUND } from './CodexRpcPeer.js'

/** Pages of `thread/backgroundTerminals/list` read at most. The host shows
 * 64 tasks a session at most; this is well past that. */
const LIST_PAGES_MAX = 8

/** How long a command Codex reported finished is kept out of list replies:
 * a list answered just before the completion is applied after it. */
const COMPLETED_TTL_MS = 60_000

/** Waits before reading a list that failed again (a timeout, a transient
 * error), one per retry. After the last, the roster waits for the next
 * change. */
export const CODEX_LIST_RETRY_MS: readonly number[] = [500, 2_000]

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
  /** `CODEX_LIST_RETRY_MS` when absent. */
  listRetryMs?: readonly number[]
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
 * A Codex that does not have the list (an older one: `-32600 unknown
 * variant`, or `-32601`) or refuses it without the experimental API has no
 * background tasks for the rest of the process. Any other failure is
 * retried, and leaves the roster as it was.
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
  /** The wait before a failed list is read again, while it runs. */
  private retry: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | undefined
  /** Commands Codex reported finished, by item id (the list names the same
   * id; a process id could be reused), with when each is forgotten. A list
   * reply never brings one back. */
  private readonly completed = new Map<string, number>()

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
   * itself, or stopped) changes the roster. One that ends while a list is
   * out may be in its reply, so it is remembered as finished and read again. */
  itemCompleted(item: v2.ThreadItem): void {
    if (!this.active || item.type !== 'commandExecution') return
    const now = Date.now()
    this.pruneCompleted(now)
    this.completed.set(item.id, now + COMPLETED_TTL_MS)
    const listed =
      (item.processId !== null && this.items.has(item.processId)) ||
      [...this.items.values()].includes(item.id)
    if (listed || this.refreshing) void this.refresh()
  }

  /** The thread was let go, closed, archived, deleted or reopened between
   * turns: what it retains may have changed (a thread Codex no longer holds
   * lists as none). Asks only when something was listed. */
  threadChanged(): void {
    if (this.active && this.tasks.length > 0) void this.refresh()
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
    // A read waiting to be retried ends now, and finds nothing left to do.
    if (this.retry) {
      clearTimeout(this.retry.timer)
      this.retry.resolve()
      this.retry = undefined
    }
    this.completed.clear()
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
    const retries = this.deps.listRetryMs ?? CODEX_LIST_RETRY_MS
    let failures = 0
    while (this.dirty && this.active) {
      this.dirty = false
      let listed: v2.ThreadBackgroundTerminal[] | undefined
      try {
        listed = await this.list()
      } catch (error) {
        // Not read (a timeout, a transient error): what was listed stays
        // listed, and the list is read again after a wait, a few times.
        this.warn('Could not list Codex background terminals', error)
        const wait = retries[failures++]
        // Closed while the list was out: nothing is left to read.
        if (wait === undefined || !this.active) continue
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.retry = undefined
            resolve()
          }, wait)
          timer.unref?.()
          this.retry = { timer, resolve }
        })
        this.dirty = true
        continue
      }
      failures = 0
      if (!listed || !this.active) continue
      const live = listed.filter((terminal) => !this.finished(terminal))
      this.apply(live.map(toTask), live)
    }
  }

  /** Codex reported this terminal's command finished, lately enough that a
   * list may still name it. */
  private finished(terminal: v2.ThreadBackgroundTerminal): boolean {
    this.pruneCompleted(Date.now())
    return this.completed.has(terminal.itemId)
  }

  private pruneCompleted(now: number): void {
    for (const [itemId, forget] of this.completed) if (forget <= now) this.completed.delete(itemId)
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
      if (!unsupported(error)) throw error
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

/** Codex has no such method (`-32601`; `-32600 Invalid request: unknown
 * variant …` is how 0.170 answers a method it does not know, probed), or
 * refuses it without the experimental API (`-32600 … requires
 * experimentalApi capability`, probed). */
function unsupported(error: unknown): error is CodexRpcError {
  return (
    error instanceof CodexRpcError &&
    (error.code === RPC_METHOD_NOT_FOUND ||
      /unknown variant `thread\/backgroundTerminals\/(list|terminate)`/.test(error.message) ||
      /thread\/backgroundTerminals\/(list|terminate) requires experimentalApi/.test(error.message))
  )
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
