import { homedir } from 'node:os'
import type { ProviderId } from '@agentpack/contract'
import type { v2, WebSearchMode } from '@openmanager/codex-app-server-protocol'
import type { HostDeps } from '../../host.js'
import { DEFAULT_RUNTIME_TIMEOUTS, type RuntimeTimeouts } from '../constants.js'
import type { ProcessExit, SessionRuntimeStopReason } from '../lifecycle.js'
import {
  applyAccountUpdated,
  applyRateLimitsRead,
  applyRateLimitsUpdated,
  codexAccountState,
  type CodexAccountState,
  type CodexProviderState,
} from './codex-account.js'
import {
  codexConfiguredWebSearch,
  readCodexFeatures,
  readCodexModels,
  readCodexPermissionProfiles,
  type CodexFeatures,
} from './codex-catalog.js'
import type {
  ClientMethod,
  ClientParams,
  ClientResult,
  CodexAppServerClient,
  CodexHandshake,
} from './CodexAppServerClient.js'
import { CodexConnectionClosedError, CodexRpcTimeoutError } from './CodexRpcPeer.js'
import { isMissingThread } from './CodexSessionRuntime.js'
import { startRealCodex, type CodexStarter } from './start.js'

/** How long the service process is kept with nothing asking it.
 *
 * Shorter than the health monitor's five-minute interval on purpose: a
 * process that only the health loop uses is gone between refreshes, so an
 * environment nobody is using holds no ~100 MB standing cost, and each
 * refresh pays a ~0.3s spawn and handshake instead. A burst (the boot probe,
 * then a catalog read, then limits) is served by one process. */
export const CODEX_SERVICE_IDLE_MS = 2 * 60 * 1000

/** Budget for one question to the service process. Everything it is asked
 * answers in well under a second when healthy (`account/rateLimits/read`,
 * the slowest, ~0.7s _probed_), and the budget must end before the health
 * probe's own (30s) does: a probe that gives up first aborts the request,
 * which would hide a hung process behind an abort. */
export const CODEX_SERVICE_REQUEST_MS = 10_000

/** Budget for a question the answer can do without (the boot probe's
 * profiles, policy and flags). Shorter, and never a reason to replace the
 * process: other questions may be mid-answer on it. */
export const CODEX_SERVICE_OPTIONAL_REQUEST_MS = 5_000

/** A request its caller abandoned after it had been waiting this long was
 * waiting on a hung process, not a slow one, and the process is replaced
 * just as for a timeout. */
export const CODEX_SERVICE_HUNG_AFTER_MS = 5_000

export type CodexServiceDeps = {
  providerId: ProviderId
  host: Pick<HostDeps, 'log'>
  /** Starts the app-server. The real binary when absent. */
  start?: CodexStarter
  env?: NodeJS.ProcessEnv
  timeouts?: Partial<RuntimeTimeouts>
  /** Where the process runs. It serves the whole environment, not one
   * workspace, so it defaults to the user's home: what it is asked about is
   * the user's Codex, and a question about a project names its directory. */
  cwd?: string
  idleMs?: number
  /** Overrides for the request budgets above, for tests. */
  requestTimeoutMs?: number
  optionalRequestTimeoutMs?: number
  hungAfterMs?: number
  /** Injected in tests: the idle timer. */
  setTimer?: (run: () => void, ms: number) => { cancel: () => void }
  now?: () => number
}

export type CodexServiceState = 'stopped' | 'starting' | 'running'

/** The service process as the runtime census sees it. */
export type CodexServiceStatus = {
  state: CodexServiceState
  pid?: number
  /** ISO time the running process finished its handshake. */
  startedAt?: string
  /** Processes started over the service's life, the running one included. */
  starts: number
  /** How the last process ended. `expected: false` is a crash. */
  lastExit?: ProcessExit & { expected: boolean; reason?: SessionRuntimeStopReason }
}

/** What Codex says about itself before any session: who is signed in, what
 * may be chosen and what is offered. Read in one go, never starting a
 * thread, so it costs no tokens and leaves nothing in the user's history. */
export type CodexDiscovery = {
  handshake: CodexHandshake | undefined
  /** This discovery had to start the process (none was running). */
  spawned: boolean
  account: CodexAccountState
  /** `model/list`, every page. Hidden models are not asked for. */
  models: v2.Model[]
  /** `permissionProfile/list`. Absent when the CLI could not say. */
  permissionProfiles?: v2.PermissionProfileSummary[]
  /** `configRequirements/read`. `requirements: null` is "no managed
   * policy"; the whole field is absent when the CLI could not say. */
  requirements?: v2.ConfigRequirementsReadResponse
  /** The feature flags openmanager relies on, as Codex has them now. */
  features?: CodexFeatures
  /** The web search mode the user's config sets for the directory asked
   * about (`config/read`); `null` when it sets none. Absent when the CLI
   * could not say. */
  webSearch?: WebSearchMode | null
}

/** One `codex app-server` per environment for everything that is not a
 * session (docs/decisions/codex-app-server.md, "One service process for work
 * outside sessions"): the boot probe and account reads today, and the place
 * limits, MCP status, thread listing, skills and file search ask later.
 *
 * - **Lazy.** Nothing runs until the first request; concurrent first
 *   requests share one start.
 * - **Reaped when idle.** `idleMs` after the last request settles, with none
 *   in flight, the process is stopped. The next request starts another.
 * - **Recovers.** A crash fails what was waiting on it and is logged; the
 *   next request starts a fresh process. A request that times out, or that
 *   its caller abandons after waiting `hungAfterMs`, is taken as a hung
 *   process, which is replaced for the same reason. Optional reads never
 *   replace it.
 * - **Never a thread.** It holds no session, so it is not one of the
 *   provider's session runtimes and does not count toward the Codex session
 *   cap. The runtime census reports it separately.
 *
 * Its `account/updated` and `account/rateLimits/updated` notifications carry
 * no thread and are merged into one provider-level `state`. */
export class CodexService {
  readonly providerId: ProviderId
  private client: CodexAppServerClient | undefined
  private starting: Promise<CodexAppServerClient> | undefined
  private inFlight = 0
  private idleTimer: { cancel: () => void } | undefined
  /** Processes asked to stop and not yet gone, with why. */
  private readonly retiring = new Map<CodexAppServerClient, SessionRuntimeStopReason>()
  private disposed = false
  private statusValue: CodexServiceStatus = { state: 'stopped', starts: 0 }
  private stateValue: CodexProviderState = {}
  private readonly stateListeners = new Set<(state: CodexProviderState) => void>()
  private readonly statusListeners = new Set<(status: CodexServiceStatus) => void>()
  private readonly timeouts: RuntimeTimeouts
  private readonly idleMs: number
  private readonly requestMs: number
  private readonly optionalRequestMs: number
  private readonly hungAfterMs: number
  /** Terminations under way, so shutdown can wait for every process. */
  private readonly exiting = new Set<Promise<unknown>>()
  /** Archives, one after another (`archiveThread`). */
  private archiveQueue: Promise<void> = Promise.resolve()
  /** An account re-read under way after `account/updated`. */
  private refreshingAccount: Promise<unknown> | undefined
  private readonly setTimer: NonNullable<CodexServiceDeps['setTimer']>
  private readonly now: () => number

  constructor(private readonly deps: CodexServiceDeps) {
    this.providerId = deps.providerId
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
    this.idleMs = deps.idleMs ?? CODEX_SERVICE_IDLE_MS
    this.requestMs = deps.requestTimeoutMs ?? CODEX_SERVICE_REQUEST_MS
    this.optionalRequestMs = deps.optionalRequestTimeoutMs ?? CODEX_SERVICE_OPTIONAL_REQUEST_MS
    this.hungAfterMs = deps.hungAfterMs ?? CODEX_SERVICE_HUNG_AFTER_MS
    this.now = deps.now ?? (() => Date.now())
    this.setTimer =
      deps.setTimer ??
      ((run, ms) => {
        const timer = setTimeout(run, ms)
        timer.unref?.()
        return { cancel: () => clearTimeout(timer) }
      })
  }

  get status(): CodexServiceStatus {
    return this.statusValue
  }

  /** The provider-level account and limits, merged from every answer and
   * notification so far. */
  get state(): CodexProviderState {
    return this.stateValue
  }

  /** The running process's handshake, if one is running. */
  get handshake(): CodexHandshake | undefined {
    return this.client?.info
  }

  onStateChange(listener: (state: CodexProviderState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onStatusChange(listener: (status: CodexServiceStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  // ---------------------------------------------------------------- requests

  /** One request on the service process, starting it if none is running.
   * Rejects with the start's own error (`CodexNotInstalledError`,
   * `CodexVersionUnsupportedError`) when it cannot run, and with the exit
   * when the process dies mid-request.
   *
   * A request that times out, or that its caller abandons after it has
   * waited `hungAfterMs`, was waiting on a hung process: every later
   * question would wait out the same budget, so the process is replaced.
   * An `optional` request has a shorter budget and never replaces anything,
   * since what it asks can be done without and others may be mid-answer. */
  async request<M extends ClientMethod>(
    method: M,
    params: ClientParams<M>,
    options: { timeoutMs?: number; signal?: AbortSignal; optional?: boolean } = {},
  ): Promise<ClientResult<M>> {
    if (this.disposed) throw new Error('The Codex service has been stopped')
    this.inFlight += 1
    this.idleTimer?.cancel()
    this.idleTimer = undefined
    try {
      options.signal?.throwIfAborted()
      const client = await this.ensureClient()
      options.signal?.throwIfAborted()
      const sentAt = this.now()
      try {
        return await client.request(method, params, {
          timeoutMs: options.timeoutMs ?? (options.optional ? this.optionalRequestMs : this.requestMs),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      } catch (error) {
        // The process is gone (its exit is still being drained): the next
        // request must start another, not be refused by this one's corpse.
        if (error instanceof CodexConnectionClosedError && this.client === client) {
          this.client = undefined
          this.setStatus(this.currentStatus())
        }
        const hung =
          error instanceof CodexRpcTimeoutError ||
          (options.signal?.aborted === true && this.now() - sentAt >= this.hungAfterMs)
        if (hung && !options.optional && this.client === client) {
          this.deps.host.log({
            scope: 'codex',
            level: 'warn',
            message: 'Codex service process stopped answering; replacing it',
            data: { method, waitedMs: this.now() - sentAt },
          })
          void this.terminate(client, 'restart')
        }
        throw error
      }
    } finally {
      this.inFlight -= 1
      this.armIdle()
    }
  }

  /** `account/read`, recorded as the provider's account state. */
  async readAccount(options?: { signal?: AbortSignal }): Promise<CodexAccountState> {
    const response = await this.request(
      'account/read',
      { refreshToken: false },
      options?.signal ? { signal: options.signal } : {},
    )
    const account = codexAccountState(response)
    this.setState({ ...this.stateValue, account, updatedAt: this.iso() })
    return account
  }

  /** `account/rateLimits/read`, recorded as the provider's limits. Rolling
   * updates are merged into it as they arrive. */
  async readRateLimits(options?: { signal?: AbortSignal }): Promise<v2.GetAccountRateLimitsResponse> {
    const response = await this.request(
      'account/rateLimits/read',
      undefined,
      options?.signal ? { signal: options.signal } : {},
    )
    this.setState(applyRateLimitsRead(this.stateValue, response, this.iso()))
    return response
  }

  /** `thread/archive` for a session the user deleted while no session
   * runtime held its thread: work outside sessions, so it goes to this
   * process. A thread Codex no longer has is already out of the way; one
   * another Codex process holds is refused ("already has an active writer")
   * and the refusal is thrown. Needs neither the account nor the catalog.
   *
   * One at a time, in order: removing a project archives many threads, and
   * fired together one slow answer would hold them all past their budget,
   * and one replaced process would fail every archive on it. One the
   * process exits under (crashed, or replaced as hung) is tried once more
   * on the next. */
  archiveThread(threadId: string): Promise<void> {
    const run = this.archiveQueue.then(() => this.archiveOnce(threadId))
    this.archiveQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async archiveOnce(threadId: string, retried = false): Promise<void> {
    try {
      await this.request('thread/archive', { threadId })
    } catch (error) {
      if (isMissingThread(error)) return
      if (!retried && error instanceof CodexConnectionClosedError && !this.disposed) {
        this.deps.host.log({
          scope: 'codex',
          level: 'info',
          message: 'The Codex service process went away during an archive; trying it once more',
          data: { threadId },
        })
        return this.archiveOnce(threadId, true)
      }
      throw error
    }
  }

  /** Everything the boot probe needs, on this one process: the account, and
   * when signed in (or no sign-in is needed) the model catalog, the
   * permission profiles, the managed policy and the feature flags.
   *
   * Bounded: every list stops after a fixed number of pages, every request
   * has the control budget. `collaborationMode/list` is not asked: plan
   * mode is not ported (docs/decisions/codex-app-server.md, "No plan
   * mode"). Only `account/read` and `model/list` can fail it; a CLI that
   * cannot answer the others is still usable, and says nothing about them. */
  async discover(options: { cwd?: string; signal?: AbortSignal } = {}): Promise<CodexDiscovery> {
    const signal = options.signal
    // Whether this call started the process: two callers racing can both
    // see a start, which only costs a duplicate `process_spawned` event.
    const startsBefore = this.statusValue.starts
    const account = await this.readAccount(signal ? { signal } : undefined)
    const handshake = this.handshake
    const spawned = this.statusValue.starts > startsBefore
    if (account.state === 'signed_out') return { handshake, spawned, account, models: [] }
    const ask = <M extends ClientMethod>(method: M, params: ClientParams<M>) =>
      this.request(method, params, signal ? { signal } : {})
    const askOptional = <M extends ClientMethod>(method: M, params: ClientParams<M>) =>
      this.request(method, params, { optional: true, ...(signal ? { signal } : {}) })
    const optional = <T>(what: string, read: Promise<T>): Promise<T | undefined> =>
      read.catch((error: unknown) => {
        if (signal?.aborted) throw error
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: `Codex could not answer ${what}; going on without it`,
          data: { error: error instanceof Error ? error.message : String(error) },
        })
        return undefined
      })
    const [models, permissionProfiles, requirements, features, config] = await Promise.all([
      readCodexModels({ request: ask }),
      optional(
        'permissionProfile/list',
        readCodexPermissionProfiles({ request: askOptional }, options.cwd),
      ),
      optional('configRequirements/read', askOptional('configRequirements/read', undefined)),
      optional('experimentalFeature/list', readCodexFeatures({ request: askOptional })),
      optional(
        'config/read',
        askOptional('config/read', options.cwd ? { cwd: options.cwd } : {}),
      ),
    ])
    const webSearch = config ? codexConfiguredWebSearch(config) : undefined
    return {
      handshake: this.handshake ?? handshake,
      spawned,
      account,
      models,
      ...(permissionProfiles ? { permissionProfiles } : {}),
      ...(requirements ? { requirements } : {}),
      ...(features ? { features } : {}),
      ...(webSearch !== undefined ? { webSearch } : {}),
    }
  }

  // --------------------------------------------------------------- lifecycle

  /** Stop the process now and wait for it to be gone. The service stays
   * usable: the next request starts another. */
  async stop(reason: SessionRuntimeStopReason = 'disposed'): Promise<void> {
    this.idleTimer?.cancel()
    this.idleTimer = undefined
    const starting = this.starting
    const client = this.client ?? (await starting?.catch(() => undefined))
    if (client) await this.terminate(client, reason)
  }

  /** Stop for good (app shutdown). Waits for the process to exit. */
  async shutdown(): Promise<void> {
    this.disposed = true
    this.stateListeners.clear()
    await this.stop('disposed')
    // A process reaped or replaced moments ago may still be in its
    // SIGTERM grace; shutdown is not done until it is gone too.
    await Promise.all([...this.exiting])
    this.statusListeners.clear()
  }

  /** Stop for good without waiting: SIGTERM and return. */
  dispose(): void {
    void this.shutdown().catch(() => undefined)
  }

  private ensureClient(): Promise<CodexAppServerClient> {
    if (this.client) return Promise.resolve(this.client)
    this.starting ??= this.startProcess().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async startProcess(): Promise<CodexAppServerClient> {
    const { starts, lastExit: previousExit } = this.statusValue
    const counters = { starts, ...(previousExit ? { lastExit: previousExit } : {}) }
    this.setStatus({ ...counters, state: 'starting' })
    let client: CodexAppServerClient
    try {
      client = await (this.deps.start ?? startRealCodex)({
        cwd: this.deps.cwd ?? homedir(),
        env: this.deps.env ?? process.env,
        timeouts: this.timeouts,
        log: this.deps.host.log,
      })
    } catch (error) {
      this.setStatus({ ...counters, state: 'stopped' })
      throw error
    }
    this.client = client
    client.on('account/updated', (update) => {
      this.setState(applyAccountUpdated(this.stateValue, update, this.iso()))
      // The update says how Codex is signed in, not as whom: read the account
      // again so its details (and the label health shows) are current.
      if (update.authMode !== null) this.refreshAccount()
    })
    client.on('account/rateLimits/updated', (update) =>
      this.setState(applyRateLimitsUpdated(this.stateValue, update, this.iso())),
    )
    void client.exited.then((exit) => this.onExit(client, exit))
    const { lastExit } = this.statusValue
    this.setStatus({
      state: 'running',
      ...(client.pid !== undefined ? { pid: client.pid } : {}),
      startedAt: this.iso(),
      starts: this.statusValue.starts + 1,
      ...(lastExit ? { lastExit } : {}),
    })
    this.deps.host.log({
      scope: 'codex',
      level: 'info',
      message: 'Codex service process started',
      data: { pid: client.pid, version: client.info?.version.version },
    })
    if (this.disposed) {
      // Shut down while it was starting: nobody wants it.
      await this.terminate(client, 'disposed')
      throw new Error('The Codex service has been stopped')
    }
    return client
  }

  private onExit(client: CodexAppServerClient, exit: ProcessExit): void {
    const reason = this.retiring.get(client)
    this.retiring.delete(client)
    if (this.client === client) this.client = undefined
    const expected = reason !== undefined
    if (!expected)
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Codex service process exited unexpectedly; the next request starts another',
        data: { exitCode: exit.exitCode, signal: exit.signal, stderr: client.stderrTail.slice(-2000) },
      })
    this.setStatus({
      ...this.currentStatus(),
      lastExit: { ...exit, expected, ...(reason ? { reason } : {}) },
    })
  }

  /** Stop one process. It stops being the service's at once, so a request
   * arriving while it winds down starts a fresh one rather than waiting on
   * a process that is going away. */
  private async terminate(client: CodexAppServerClient, reason: SessionRuntimeStopReason): Promise<void> {
    if (!this.retiring.has(client)) this.retiring.set(client, reason)
    if (this.client === client) {
      this.client = undefined
      this.setStatus(this.currentStatus())
    }
    const exiting = client.terminate({ reason }).catch(() => undefined)
    this.exiting.add(exiting)
    try {
      await exiting
    } finally {
      this.exiting.delete(exiting)
    }
  }

  private refreshAccount(): void {
    if (this.refreshingAccount || this.disposed) return
    this.refreshingAccount = this.readAccount()
      .catch((error: unknown) =>
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Could not re-read the Codex account after it changed',
          data: { error: error instanceof Error ? error.message : String(error) },
        }),
      )
      .finally(() => {
        this.refreshingAccount = undefined
      })
  }

  /** The status for whatever process is current, keeping the counters. */
  private currentStatus(): CodexServiceStatus {
    const { starts, lastExit } = this.statusValue
    const kept = { starts, ...(lastExit ? { lastExit } : {}) }
    if (this.client)
      return {
        ...kept,
        state: 'running',
        ...(this.client.pid !== undefined ? { pid: this.client.pid } : {}),
        ...(this.statusValue.startedAt ? { startedAt: this.statusValue.startedAt } : {}),
      }
    return { ...kept, state: this.starting ? 'starting' : 'stopped' }
  }

  private armIdle(): void {
    if (this.inFlight > 0 || this.disposed || !this.client) return
    this.idleTimer?.cancel()
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = undefined
      const client = this.client
      if (this.inFlight > 0 || !client) return
      this.deps.host.log({
        scope: 'codex',
        level: 'info',
        message: 'Codex service process idle; stopping it',
        data: { idleMs: this.idleMs },
      })
      void this.terminate(client, 'reaped')
    }, this.idleMs)
  }

  private setState(next: CodexProviderState): void {
    this.stateValue = next
    for (const listener of this.stateListeners) {
      try {
        listener(next)
      } catch (error) {
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'A Codex account listener failed',
          data: { error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }

  private setStatus(next: CodexServiceStatus): void {
    this.statusValue = next
    for (const listener of this.statusListeners) listener(next)
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }
}
