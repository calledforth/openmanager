import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import {
  createEnvironmentStore,
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
  type EnvironmentState,
  type EnvironmentStore,
  type WebSocketConstructor,
} from '@openmanager/environment-client'
// The web app's own cache transform: what a reload hands the next client.
import { cacheState } from '../../../web/src/lib/environment-cache.ts'
import { LinkProxy } from './link-proxy.ts'
import {
  describeDiff,
  diff,
  normalize,
  serverSessionsView,
  serverThreadView,
  sessionsWithoutThreads,
  type DiffEntry,
  type NormalizedView,
  type ThreadView,
} from './normalize.ts'
import { ServerProcess } from './server-process.ts'
import type { ProviderOp } from './child-protocol.ts'

/** The batcher holds deltas for at most 100 ms; quiet is that window plus margin (§10.1). */
export const QUIET_MS = 300
/** "Equal" is eventual: poll every 50 ms, up to 10 s (§8.1). */
export const CONVERGE_TIMEOUT_MS = 10_000
const POLL_MS = 50

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Wait on a condition, never on a fixed sleep. */
export async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 10_000,
  intervalMs = 20,
): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined && value !== false) return value
    if (performance.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms: ${what}`)
    await sleep(intervalMs)
  }
}

function parseJson(data: unknown): Record<string, unknown> | undefined {
  try {
    const text =
      typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : undefined
    const value: unknown = text === undefined ? undefined : JSON.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** mulberry32: small, seedable, and the same on every platform. */
export function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ClientClose {
  at: number
  code: number
  reason: string
}

/** A real `environment-client` with what the harness needs to see of its socket. */
export interface TestClient {
  name: string
  client: EnvironmentClient
  store: EnvironmentStore
  /** Every close of every socket this client opened, as the client saw it. */
  closes: ClientClose[]
  /** Sockets this client has opened. */
  dials: number
  /** Times the client reached `connected`. */
  connects: number
  /**
   * Still working: a command it sent is unanswered (a recovery's replay, a
   * catalog page, a session open), or it is dialling. A disposed client is
   * never busy.
   */
  busy(): boolean
  dispose(): void
}

export type Link = 'proxy' | 'direct'

export interface RigOptions {
  newSessionDelayMs?: number
}

const reconnect = { initialDelayMs: 100, maxDelayMs: 2_000 }

/**
 * One scenario's world: a server child on its own temp data directory, the
 * link proxy in front of it, and the clients the scenario opens.
 */
export class Rig {
  readonly clients: TestClient[] = []
  workspaceId = ''
  private readonly started = performance.now()
  private seed = 1

  private constructor(
    readonly server: ServerProcess,
    readonly proxy: LinkProxy,
    readonly credential: string,
    private readonly dataDir: string,
  ) {}

  static async create(options: RigOptions = {}): Promise<Rig> {
    // The registry and the provider see the long spelling of the directory,
    // whatever 8.3 short name the temp directory is reached by (CAL-53).
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'om-convergence-')))
    const workspaceRoot = join(dataDir, 'workspace')
    await mkdir(workspaceRoot)
    let proxy: LinkProxy | undefined
    let server: ServerProcess | undefined
    try {
      proxy = await LinkProxy.start()
      server = await ServerProcess.start({
        dataDir,
        workspaceRoot,
        allowedHosts: [`127.0.0.1:${proxy.port}`, `localhost:${proxy.port}`],
        newSessionDelayMs: options.newSessionDelayMs ?? 0,
      })
      proxy.setTarget(server.port)
      const credential = (await readFile(join(dataDir, 'owner-credential'), 'utf8')).trim()
      const rig = new Rig(server, proxy, credential, dataDir)
      const driver = await rig.connect('setup', { link: 'direct' })
      const workspaces = await driver.client.commands.listWorkspaces()
      rig.workspaceId = workspaces[0]!.workspaceId
      driver.dispose()
      return rig
    } catch (error) {
      await server?.stop().catch(() => undefined)
      await proxy?.close().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  get environmentId(): string {
    return this.server.environmentId
  }

  now(): number {
    return Math.round(performance.now() - this.started)
  }

  /** A `performance.now()` reading as milliseconds since this rig started. */
  since(perf: number): number {
    return Math.round(perf - this.started)
  }

  /** Open a client through the proxy (the link under test) or straight to the server. */
  async connect(
    name: string,
    options: { link?: Link; store?: EnvironmentStore; wait?: boolean } = {},
  ): Promise<TestClient> {
    const link = options.link ?? 'proxy'
    const closes: ClientClose[] = []
    const record = { dials: 0 }
    /** Request ids sent on the live socket and not yet answered. */
    const outstanding = new Set<string>()
    // A direct client always dials the live server, whatever port it is on now.
    const url = () => (link === 'proxy' ? this.proxy.url : `ws://127.0.0.1:${this.server.port}/ws`)
    const now = () => this.now()
    class RecordingWebSocket extends WebSocket {
      constructor(_url: string, protocols?: string[]) {
        super(url(), protocols)
        record.dials += 1
        // A browser drops a message that arrives once close() was called
        // (WHATWG WebSockets: "if ready state is not OPEN, then return");
        // `ws` still delivers it. The client under test gets browser rules,
        // or an answer that lands on a socket it gave up on would count.
        const add = this.addEventListener.bind(this) as (
          type: string,
          listener: (event: unknown) => void,
        ) => void
        ;(this as unknown as { addEventListener: typeof add }).addEventListener = (
          type,
          listener,
        ) =>
          add(
            type,
            type === 'message'
              ? (event) => {
                  if (this.readyState === WebSocket.OPEN) listener(event)
                }
              : listener,
          )
        this.addEventListener('close', (event) => {
          closes.push({ at: now(), code: event.code, reason: event.reason })
          // The client fails everything pending on a closed socket.
          outstanding.clear()
        })
        this.addEventListener('message', (event) => {
          const message = parseJson((event as { data: unknown }).data)
          if (
            (message?.type === 'response' || message?.type === 'error') &&
            typeof message.requestId === 'string'
          ) {
            outstanding.delete(message.requestId)
          }
        })
      }

      override send(data: unknown, ...rest: unknown[]): void {
        const message = parseJson(data)
        if (message?.type === 'command' && typeof message.requestId === 'string') {
          outstanding.add(message.requestId)
        }
        ;(super.send as (...args: unknown[]) => void)(data, ...rest)
      }
    }
    const store = options.store ?? createEnvironmentStore()
    const client = createWebSocketEnvironmentClient({
      url: link === 'proxy' ? this.proxy.url : `ws://127.0.0.1:${this.server.port}/ws`,
      credential: this.credential,
      environmentId: this.environmentId,
      store,
      WebSocket: RecordingWebSocket as unknown as WebSocketConstructor,
      reconnect,
      random: prng(this.seed++),
    })
    let connects = 0
    let phase = client.getState().connection.phase
    store.subscribe(() => {
      const next = store.getState().connection.phase
      if (next === 'connected' && phase !== 'connected') connects += 1
      phase = next
    })
    let disposed = false
    const testClient: TestClient = {
      name,
      client,
      store,
      closes,
      get dials() {
        return record.dials
      },
      get connects() {
        return connects
      },
      busy: () => {
        if (disposed) return false
        const current = client.getState().connection.phase
        return outstanding.size > 0 || current === 'connecting' || current === 'reconnecting'
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        client.dispose()
      },
    }
    this.clients.push(testClient)
    client.connect()
    if (options.wait !== false) {
      await until(
        () => client.getState().connection.phase === 'connected',
        `${name} to connect`,
        15_000,
      )
    }
    return testClient
  }

  /**
   * A reload: the old client goes, and a new one starts from what the web
   * app's cache would hand it (`cacheState`, the pure part of the IndexedDB
   * round trip).
   */
  async reload(old: TestClient, link: Link = 'proxy'): Promise<TestClient> {
    const cached = cacheState(old.client.getState())
    old.dispose()
    return this.connect(`${old.name}*`, {
      link,
      store: createEnvironmentStore(structuredClone(cached)),
    })
  }

  provider(op: ProviderOp): Promise<unknown> {
    return this.server.call(op)
  }

  /**
   * Server quiet only: nothing published, provided or dispatched for the
   * batcher window plus margin. A prerequisite, not quiescence: the link and
   * the clients may still be moving. Usable while the link is down.
   */
  waitQuiet(): Promise<void> {
    return this.server.waitQuiet(QUIET_MS)
  }

  /**
   * Everything at rest: the server quiet, the proxy drained (nothing queued,
   * held or half-inspected), and every live client idle (no unanswered
   * command, not dialling). Two passes in a row must agree, so a client that
   * sends its next catalog page right after an answer is not caught between.
   */
  async settle(timeoutMs = 30_000): Promise<void> {
    const deadline = performance.now() + timeoutMs
    let calm = 0
    while (calm < 2) {
      if (performance.now() > deadline) {
        const busy = this.clients.filter((client) => client.busy()).map((client) => client.name)
        throw new Error(
          `The rig never settled: proxy drained ${this.proxy.drained()}, busy clients [${busy.join(', ')}].`,
        )
      }
      await this.waitQuiet()
      const atRest = this.proxy.drained() && this.clients.every((client) => !client.busy())
      calm = atRest ? calm + 1 : 0
      if (calm < 2) await sleep(POLL_MS)
    }
  }

  /** A graceful stop through the server's own shutdown path, then a respawn. */
  async restart(): Promise<void> {
    await this.server.restart()
    this.proxy.setTarget(this.server.port)
  }

  /** A hard kill, then a respawn. */
  async crash(): Promise<void> {
    await this.server.crash()
    this.proxy.setTarget(this.server.port)
  }

  /**
   * What a fresh load shows: a new client with an empty store on a clean
   * link, the whole session catalog, the same active session opened, and
   * every older history page walked so whole chats are compared (§8.1).
   */
  async freshView(activeSessionId: string | null): Promise<NormalizedView> {
    const fresh = await this.connect('fresh', { link: 'direct' })
    try {
      const { commands } = fresh.client
      await commands.listWorkspaces()
      let cursor: Parameters<typeof commands.listSessions>[0] = { limit: 100 }
      for (;;) {
        const page = await commands.listSessions(cursor)
        if (!page.nextCursor) break
        cursor = { limit: 100, cursor: page.nextCursor }
      }
      if (activeSessionId) {
        await commands.openSession(activeSessionId).catch((error: unknown) => {
          // A deleted session is a fact a fresh load shows by not having it.
          if ((error as { code?: string }).code !== 'not_found') throw error
        })
        const session = fresh.client.getState().sessions[activeSessionId]
        for (const threadId of session?.threadIds ?? []) {
          // openSession swallows a failed hydration and resolves; an empty
          // failed thread must not pass for an empty one.
          const hydration = fresh.client.getState().threads[threadId]?.hydration
          if (hydration !== 'ready') {
            throw new Error(`The fresh load could not load thread ${threadId} (${hydration}).`)
          }
          for (;;) {
            const thread = fresh.client.getState().threads[threadId]
            if (!thread?.historyCursor) break
            await commands.loadSessionHistory({
              sessionId: activeSessionId,
              threadId,
              cursor: thread.historyCursor,
            })
          }
        }
      }
      return normalize(fresh.client.getState(), activeSessionId)
    } finally {
      fresh.dispose()
    }
  }

  /** The server's own read of the active session's threads (§8.1, third check). */
  async serverView(
    sessionId: string,
    threadIds: readonly string[],
  ): Promise<Record<string, ThreadView>> {
    const threads: Record<string, ThreadView> = {}
    for (const threadId of threadIds) {
      threads[threadId] = serverThreadView(await this.server.readThread(sessionId, threadId))
    }
    return threads
  }

  /**
   * The property: once the link is healthy and the server has been quiet,
   * the client under test equals a fresh load and the server's own read.
   */
  async checkConvergence(
    subject: TestClient,
    options: { timeoutMs?: number; heal?: boolean } = {},
  ): Promise<ConvergenceResult> {
    if (options.heal !== false) this.proxy.heal()
    const deadline = performance.now() + (options.timeoutMs ?? CONVERGE_TIMEOUT_MS)
    let last: ConvergenceResult | undefined
    for (;;) {
      await this.settle()
      const activeSessionId = subject.client.getState().activeSessionId
      const fresh = await this.freshView(activeSessionId)
      // The server's own list, not what either client happened to learn: a
      // thread both clients miss must still show.
      const threadIds = activeSessionId ? await this.server.readSessionThreads(activeSessionId) : []
      const server: ServerView = {
        threads:
          activeSessionId && fresh.active?.present
            ? await this.serverView(activeSessionId, threadIds)
            : {},
        sessions: serverSessionsView(await this.server.readSessions()),
      }
      // Hold the fresh load and the server's read; give the client the rest of
      // a second to catch up with them before reading the server again.
      const roundEnd = Math.min(deadline, performance.now() + 1_000)
      for (;;) {
        const view = normalize(subject.client.getState(), activeSessionId)
        const entries = compare(view, fresh, server)
        last = { converged: entries.length === 0, entries, view, fresh, server }
        if (last.converged) return last
        if (performance.now() >= roundEnd) break
        await sleep(POLL_MS)
      }
      if (performance.now() >= deadline) return last
    }
  }

  async dispose(): Promise<void> {
    for (const client of this.clients) client.dispose()
    await this.server.stop().catch(() => undefined)
    await this.server.kill().catch(() => undefined)
    await this.proxy.close().catch(() => undefined)
    await rm(this.dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
}

/**
 * Commands for building a scenario, on a direct link. The server keeps every
 * command a socket sent for retries and closes the socket at 1024
 * (`SOCKET_LIMITS.maxCommands`), so a long setup moves to a new socket well
 * before that.
 */
export class Driver {
  private current: TestClient | undefined
  private sent = 0
  static readonly COMMANDS_PER_SOCKET = 800

  constructor(private readonly rig: Rig) {}

  /** The client to send the next `count` commands on. */
  async client(count = 1): Promise<TestClient> {
    if (!this.current || this.sent + count > Driver.COMMANDS_PER_SOCKET) {
      this.current?.dispose()
      this.current = await this.rig.connect('driver', { link: 'direct' })
      this.sent = 0
    }
    this.sent += count
    return this.current
  }

  dispose(): void {
    this.current?.dispose()
  }
}

/** The server's own reads: the open session's threads and every session summary. */
export interface ServerView {
  threads: Record<string, ThreadView>
  sessions: unknown[]
}

export interface ConvergenceResult {
  converged: boolean
  entries: DiffEntry[]
  view: NormalizedView
  fresh: NormalizedView
  server: ServerView
}

/**
 * Three comparisons: the client against a fresh load (the property), the
 * client against the server's own reads (its session summaries, and the open
 * session's threads), and the fresh load against those reads (a client bug
 * shared by both clients shows only there).
 */
export function compare(
  view: NormalizedView,
  fresh: NormalizedView,
  server: ServerView,
): DiffEntry[] {
  const entries = diff('fresh', view, fresh)
  entries.push(...diff('server', sessionsWithoutThreads(view), server.sessions, 'sessions'))
  entries.push(
    ...diff('fresh-vs-server', sessionsWithoutThreads(fresh), server.sessions, 'sessions'),
  )
  if (fresh.active?.present) {
    entries.push(...diff('server', view.active?.threads ?? {}, server.threads, 'active.threads'))
    entries.push(...diff('fresh-vs-server', fresh.active.threads, server.threads, 'active.threads'))
  }
  return entries
}

export function report(result: ConvergenceResult): string {
  return result.converged ? 'converged' : `diverged:\n${describeDiff(result.entries)}`
}

export type { EnvironmentState }
