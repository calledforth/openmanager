import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import {
  cacheState,
  createEnvironmentStore,
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
  type EnvironmentState,
  type EnvironmentStore,
  type WebSocketConstructor,
} from '@openmanager/environment-client'
// The web app's own cache transform: what a reload hands the next client.
import { LinkProxy, type FrameRecord } from './link-proxy.ts'
import {
  describeDiff,
  diff,
  heldPreferencePairs,
  normalize,
  preferenceKey,
  type PreferencePair,
  serverSessionsView,
  serverThreadView,
  sessionsWithoutThreads,
  type DiffEntry,
  type NormalizedView,
  type ThreadView,
} from './normalize.ts'
import { ServerProcess } from './server-process.ts'
import {
  DELIVERIES_FILENAME,
  type Delivery,
  type KillAt,
  type ProviderOp,
} from './child-protocol.ts'
import type { ClientWire, Provenance } from './provenance.ts'
import { scopeKey } from '../../src/db/event-repository.ts'
import type { SubscriptionScope } from '@openmanager/protocol/node'

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
  /** The local port of every socket it opened: how the proxy's recording tells it apart. */
  ports: ReadonlySet<number>
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
    // whatever 8.3 short name the temp directory is reached by (Windows CI).
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
      // Always on: expectations derive what a client should hold from what the
      // server sent it (mirror.ts), never from the client itself.
      proxy.record(true)
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

  /**
   * Open a client through the proxy (the link under test) or straight to the
   * server. By default this waits until the client is connected and its own
   * resync is answered (catalog reads, and the open of a cached active
   * session): a fixture that acts during that resync races the client's own
   * `session.open`, which overtakes the fixture's and resolves it before the
   * chat is subscribed (S19). `wait: 'connected'` keeps that race, for S19;
   * `wait: false` does not wait at all.
   */
  async connect(
    name: string,
    options: { link?: Link; store?: EnvironmentStore; wait?: boolean | 'connected' } = {},
  ): Promise<TestClient> {
    const link = options.link ?? 'proxy'
    const closes: ClientClose[] = []
    const record = { dials: 0 }
    const ports = new Set<number>()
    /** Request ids sent on the live socket and not yet answered. */
    const outstanding = new Set<string>()
    // A direct client always dials the live server, whatever port it is on now.
    const url = () => (link === 'proxy' ? this.proxy.url : `ws://127.0.0.1:${this.server.port}/ws`)
    const now = () => this.now()
    class RecordingWebSocket extends WebSocket {
      constructor(_url: string, protocols?: string[]) {
        super(url(), protocols)
        record.dials += 1
        this.addEventListener('open', () => {
          const port = (this as unknown as { _socket?: { localPort?: number } })._socket?.localPort
          if (port !== undefined) ports.add(port)
        })
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
      ports,
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
    if (options.wait === undefined || options.wait === true) {
      await until(() => !testClient.busy(), `${name} to finish its resync`, 15_000)
    }
    return testClient
  }

  /**
   * A reload: the old client goes, and a new one starts from what the web
   * app's cache would hand it (`cacheState`, the pure part of the IndexedDB
   * round trip).
   */
  async reload(
    old: TestClient,
    link: Link = 'proxy',
    wait: boolean | 'connected' = true,
  ): Promise<TestClient> {
    const cached = cacheState(old.client.getState())
    old.dispose()
    return this.connect(`${old.name}*`, {
      link,
      store: createEnvironmentStore(structuredClone(cached)),
      wait,
    })
  }

  /** The frames on the proxied sockets of one client, in wire order. */
  framesOf(client: TestClient): FrameRecord[] {
    return this.proxy.frames.filter((frame) => {
      const port = this.proxy.clientPorts.get(frame.connection)
      return port !== undefined && client.ports.has(port)
    })
  }

  /**
   * The server's write and event provenance (provenance.ts): the child's
   * audit and every generation's delivery log, read now. A line a hard kill
   * cut short is dropped.
   */
  async provenance(): Promise<Provenance> {
    const audit = await this.server.readAudit()
    const text = await readFile(join(this.dataDir, DELIVERIES_FILENAME), 'utf8').catch(() => '')
    const deliveries: Delivery[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        deliveries.push(JSON.parse(line) as Delivery)
      } catch {
        // The last line of a killed process.
      }
    }
    return { audit, deliveries }
  }

  /**
   * One client's sockets as the server saw them (its own ports on a direct
   * link, the proxy's server-side ports otherwise), and what reached it: a
   * record the server handed a proxied socket reached the client if the
   * proxy recorded it on that connection.
   */
  wireOf(client: TestClient): ClientWire {
    const ports = new Set<number>()
    /** Server-side port → proxy connection, for this client's proxied sockets. */
    const proxied = new Map<number, number>()
    const viaProxy = new Set<number>()
    for (const [connection, clientPort] of this.proxy.clientPorts) {
      if (!client.ports.has(clientPort)) continue
      viaProxy.add(clientPort)
      const serverPort = this.proxy.serverPorts.get(connection)
      if (serverPort !== undefined) {
        ports.add(serverPort)
        proxied.set(serverPort, connection)
      }
    }
    // A direct socket: the server sees the client's own port.
    for (const port of client.ports) if (!viaProxy.has(port)) ports.add(port)
    const recorded = new Set<string>()
    for (const frame of this.proxy.frames) {
      const record = (
        frame.json as
          | {
              name?: string
              payload?: { record?: { cursor?: { scope?: unknown; sequence?: number } } }
            }
          | undefined
      )?.payload?.record
      if (frame.direction !== 'down' || !record?.cursor?.scope) continue
      recorded.add(
        `${frame.connection}|${scopeKey(record.cursor.scope as SubscriptionScope)}|${record.cursor.sequence}`,
      )
    }
    return {
      ports,
      reached: (key, sequence, port) => {
        const connection = proxied.get(port)
        if (connection === undefined) return undefined
        return recorded.has(`${connection}|${key}|${sequence}`)
      },
    }
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

  /** A kill inside a chosen event-log commit (child-protocol.ts `KillAt`), then a respawn. */
  async killAtCommit(at: KillAt, trigger: () => Promise<unknown>): Promise<void> {
    await this.server.killAtCommit(at, trigger)
    this.proxy.setTarget(this.server.port)
  }

  /** A stop (graceful, or a crash), then a boot that dies at a chosen commit, then a normal boot. */
  async restartKilledAtBoot(at: KillAt, options: { crash?: boolean } = {}): Promise<void> {
    await this.server.restartKilledAtBoot(at, options)
    this.proxy.setTarget(this.server.port)
  }

  /**
   * What a fresh load shows: a new client with an empty store on a clean
   * link, the whole session catalog, the same active session opened, and
   * every older history page walked so whole chats are compared (§8.1).
   */
  async freshView(
    activeSessionId: string | null,
    preferencePairs: readonly PreferencePair[] = [],
  ): Promise<NormalizedView> {
    const fresh = await this.connect('fresh', { link: 'direct' })
    try {
      const { commands } = fresh.client
      await commands.listWorkspaces()
      // The draft sync lists drafts by itself once connected.
      await until(() => fresh.client.getState().draftsListed, 'the fresh load to list drafts')
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
      // A preference is read on demand: the same read the app's composer makes.
      for (const pair of preferencePairs) {
        await commands.getComposerPreference(pair).catch(() => undefined)
      }
      return normalize(fresh.client.getState(), activeSessionId, preferencePairs)
    } finally {
      fresh.dispose()
    }
  }

  /**
   * The read the web app's composer makes for the session on screen
   * (environment-composer.tsx:294-320): when its workspace and provider
   * preference is not loaded, the provider is listed and the client is
   * connected, it asks for it. Comparisons are not passive: this, and the
   * fresh load's own session.open, can change what the server holds in
   * memory (the restarted server restores a thread on open; see S17).
   */
  private async composerRead(subject: TestClient): Promise<PreferencePair | undefined> {
    const state = subject.client.getState()
    const session = state.activeSessionId ? state.sessions[state.activeSessionId] : undefined
    if (!session?.providerId) return undefined
    const pair = { workspaceId: session.workspaceId, providerId: session.providerId }
    const listed = state.providerOrder.includes(pair.providerId)
    if (
      !state.composerPreferences[pair.workspaceId]?.[pair.providerId] &&
      listed &&
      state.connection.phase === 'connected' &&
      subject.client.supports('getComposerPreference')
    ) {
      await subject.client.commands.getComposerPreference(pair).catch(() => undefined)
    }
    return pair
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
      const composerPair = await this.composerRead(subject)
      const activeSessionId = subject.client.getState().activeSessionId
      // Every pair the client holds, and the one its composer shows.
      const pairs = new Map(
        [
          ...heldPreferencePairs(subject.client.getState()),
          ...(composerPair ? [composerPair] : []),
        ].map((pair) => [preferenceKey(pair), pair]),
      )
      const fresh = await this.freshView(activeSessionId, [...pairs.values()])
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
        const view = normalize(subject.client.getState(), activeSessionId, [...pairs.values()])
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
