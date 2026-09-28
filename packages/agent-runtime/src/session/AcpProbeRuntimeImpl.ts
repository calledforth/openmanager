import type * as acp from '@agentclientprotocol/sdk'
import type { AuthMethod, ModelListing, ProviderId, ProviderSessionInfo } from '@agentpack/contract'
import type { BackendEvent, BackendRoute } from '../backends/Backend.js'
import { AuthRequiredError } from '../core/errors.js'
import type { HostDeps } from '../host.js'
import {
  acpCommandBin,
  requireAcpConfig,
  type AcpProviderConfig,
  type ModelCatalogSource,
  type ProviderConfig,
} from '../providers/index.js'
import type { ExecFile } from '../providers/opencode-models.js'
import type { AcpConnection, AcpConnectionFactory } from './AcpConnection.js'
import type {
  ProbeResult,
  ModelCatalogListing,
  ProbeRuntime,
  ProbeRuntimeFactory,
  ProbeRuntimeOptions,
} from './ProbeRuntime.js'
import { DEFAULT_RUNTIME_TIMEOUTS, type RuntimeTimeouts } from './constants.js'
import type { ThreadId } from './lifecycle.js'
import { RpcTimeoutError, withTimeout } from './timeout.js'
import {
  agentInfo,
  authMethods,
  errorMessage,
  initialState,
  initializeRequest,
  isAuthRequired,
  listSessionsPaged,
  normalizePromptCapabilities,
  object,
  routeEvent,
  sessionListAdvertised,
  string,
} from './wire.js'

export type AcpProbeSpec = {
  providerId: ProviderId
  cwd: string
  /** Pseudo-thread the probe's lifecycle events are stamped with. Only used
   * when `onEvent` is supplied. */
  threadId?: ThreadId
  workspaceId?: string
}

export type AcpProbeDeps = {
  config: AcpProviderConfig
  host: Pick<HostDeps, 'log'>
  connections: AcpConnectionFactory
  timeouts?: Partial<RuntimeTimeouts>
  /** How a provider asked through its own CLI is run; tests inject a fake. */
  execFile?: ExecFile
  /** When present the probe emits the same `process_spawned` / `initialized` /
   * `authenticated` / `auth_required` events the shared per-provider process
   * used to emit on `AgentRuntime.start`. The renderer learns agent info and
   * prompt capabilities from `initialized`, so the bootstrap path supplies
   * this; repeat metadata probes stay silent to avoid event spam. */
  onEvent?: (event: BackendEvent) => void
}

type ExtensionCatalogSource = Extract<ModelCatalogSource, { via: 'extension' }>

/** A throwaway process for provider-level questions that must not touch a live
 * session: the handshake, `session/list`, model catalogs, and (Phase 3) health
 * probes. On Cursor every model/config write is process-global, so asking
 * these inside a session process would change the model a user's turn runs on. */
export class AcpProbeRuntimeImpl implements ProbeRuntime {
  readonly providerId: ProviderId
  private transport: AcpConnection | null = null
  private result: ProbeResult | undefined
  /** Stops a catalog being read from the provider's CLI. That process is not
   * the connection's, so terminating the connection would not reach it. */
  private readonly cli = new AbortController()
  /** CLI reads still running. `dispose()` waits for them to be gone. */
  private readonly cliReads = new Set<Promise<unknown>>()
  private readonly timeouts: RuntimeTimeouts

  constructor(
    private readonly spec: AcpProbeSpec,
    private readonly deps: AcpProbeDeps,
  ) {
    this.providerId = spec.providerId
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
  }

  async probe(): Promise<ProbeResult> {
    if (this.result) return this.result
    await this.connect()
    const transport = this.transport
    if (!transport) throw new Error(`ACP runtime unavailable for ${this.providerId}`)
    // A CLI that dies mid-handshake leaves the RPC unanswered forever. On
    // Windows the connection is spawned through a shell, so a missing binary
    // *does* produce a process — one that exits immediately. Racing the child's
    // own exit turns that into an answer in milliseconds instead of a hang
    // until the health monitor's probe timeout.
    const died = transport.exited.then((exit) => {
      throw new Error(
        `${this.providerId} exited during startup (code ${exit.exitCode ?? 'null'}, signal ${exit.signal ?? 'none'})`,
      )
    })
    this.result = await Promise.race([this.handshake(), died])
    return this.result
  }

  private async handshake(): Promise<ProbeResult> {
    let response
    try {
      response = object(
        await this.rpc(
          'initialize',
          this.timeouts.initializeMs,
          this.connection().initialize(initializeRequest()),
        ),
      )
    } catch (error) {
      if (isAuthRequired(error)) throw this.authRequired(undefined, errorMessage(error))
      throw error
    }
    const advertised = sessionListAdvertised(response, this.deps.config.capabilities.canListSessions)
    const methods = authMethods(response)
    const promptCapabilities = normalizePromptCapabilities(response.agentCapabilities)
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'initialized', {
        protocolVersion: string(response.protocolVersion),
        agentInfo: agentInfo(response),
        capabilities: { ...this.deps.config.capabilities, canListSessions: advertised },
        promptCapabilities,
        authMethods: methods,
      }),
    )
    const result: ProbeResult = {
      agentInfo: agentInfo(response),
      protocolVersion: string(response.protocolVersion),
      authMethods: methods,
      authenticated: true,
      promptCapabilities,
      sessionListAdvertised: advertised,
      loadSessionAdvertised: this.deps.config.capabilities.canLoadSession,
    }
    const methodId = this.pickAuthMethod(methods)
    if (methodId) {
      try {
        await this.rpc(
          'authenticate',
          this.timeouts.authenticateMs,
          this.connection().authenticate({ methodId }),
        )
        this.emit(routeEvent(this.route(), undefined, 'lifecycle', 'authenticated', { methodId }))
      } catch (error) {
        const authError = this.authRequired(methods, errorMessage(error))
        if (!this.deps.config.auth.tolerateAuthenticateFailure) throw authError
        result.authenticated = false
        result.authError = errorMessage(error)
      }
    }
    return result
  }

  async listSessions(cwd: string): Promise<ProviderSessionInfo[]> {
    const result = await this.probe()
    if (!result.sessionListAdvertised)
      throw new Error(`${this.providerId} does not advertise ACP session/list support`)
    try {
      return await this.rpc(
        'session/list',
        this.timeouts.controlRequestMs,
        listSessionsPaged(this.connection(), cwd),
      )
    } catch (error) {
      if (isAuthRequired(error)) throw this.authRequired(undefined, errorMessage(error))
      throw error
    }
  }

  /** The catalog, by whichever route the provider's config names.
   *
   * There is no default route. ACP's own answer is `session/new`, and whether
   * that is harmless depends on the agent, so a provider that has not said
   * how it may be asked is not asked: it answers empty, which every caller
   * reads as "could not say". */
  async listModels(cwd: string): Promise<ModelCatalogListing> {
    const source = this.deps.config.models?.catalog
    if (!source) return {}
    if (source.via === 'cli') {
      // No connection needed, and none is opened for it.
      this.cli.signal.throwIfAborted()
      const read = source.list({
        command: acpCommandBin(this.deps.config.command),
        log: this.deps.host.log,
        cwd,
        signal: this.cli.signal,
        ...(this.deps.execFile ? { execFile: this.deps.execFile } : {}),
      })
      this.cliReads.add(read)
      const forget = (): void => void this.cliReads.delete(read)
      read.then(forget, forget)
      return read
    }
    await this.probe()
    return this.listModelsByExtension(source, cwd)
  }

  private async listModelsByExtension(
    source: ExtensionCatalogSource,
    cwd: string,
  ): Promise<ModelCatalogListing> {
    const ask = async (): Promise<ModelListing> =>
      source.read(
        await this.rpc(
          source.method,
          this.timeouts.controlRequestMs,
          this.connection().request(source.method, {}),
        ),
      )
    // Some agents only set up what the listing reads from once a session
    // exists, and only a session lists the modes. The session is never
    // prompted and dies with this process.
    const openSession = async () =>
      initialState(
        object(
          await this.rpc(
            'session/new',
            this.timeouts.newSessionMs,
            this.connection().newSession({ cwd, mcpServers: [] }),
          ),
        ),
      )
    let listing: ModelListing = {}
    try {
      listing = await ask()
      if (!listing.availableModels?.length && !source.sessionFallback) return listing
    } catch (error) {
      if (isAuthRequired(error)) throw this.authRequired(undefined, errorMessage(error))
      if (!source.sessionFallback) throw error
    }
    if (listing.availableModels?.length) {
      if (!source.modesFromSession) return listing
      // The models are already read; a session that cannot open only costs
      // the modes, never the catalog.
      try {
        const { modes } = await openSession()
        return { ...listing, ...(modes?.availableModes?.length ? { modes } : {}) }
      } catch (error) {
        if (isAuthRequired(error)) throw this.authRequired(undefined, errorMessage(error))
        return listing
      }
    }
    const state = await openSession()
    const modes = source.modesFromSession && state.modes?.availableModes?.length
      ? { modes: state.modes }
      : {}
    try {
      const retried = await ask()
      if (retried.availableModels?.length) return { ...retried, ...modes }
    } catch {
      // The session's own listing below is the same catalog by another door.
    }
    return { ...(state.models ?? {}), ...modes }
  }

  /** Every child this probe started is gone when this resolves: the ACP
   * process, and a CLI it was reading the catalog from. */
  async dispose(): Promise<void> {
    this.cli.abort()
    const transport = this.transport
    this.transport = null
    await Promise.all([
      transport?.terminate({ reason: 'disposed' }),
      // A read settles once its process has exited, however it ended.
      ...[...this.cliReads].map((read) => read.catch(() => undefined)),
    ])
  }

  private async connect(): Promise<void> {
    if (this.transport) return
    const command = this.deps.config.command
    const bin = acpCommandBin(command)
    // A probe answers nothing: it never owns a session, so any agent-initiated
    // traffic is declined rather than routed.
    const client: acp.Client = {
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => undefined,
      extMethod: async () => ({}),
      extNotification: async () => undefined,
    }
    this.transport = await this.deps.connections.connect({
      providerId: this.providerId,
      command: bin,
      args: command.args,
      cwd: this.spec.cwd,
      env: probeEnvironment(command.env),
      client,
      spawnTimeoutMs: this.timeouts.spawnMs,
      terminateGraceMs: this.timeouts.terminateGraceMs,
    })
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'process_spawned', {
        cwd: this.spec.cwd,
        command: bin,
        args: command.args,
        processId: this.transport.pid,
      }),
    )
  }

  private connection(): acp.ClientSideConnection {
    if (!this.transport) throw new Error(`ACP runtime unavailable for ${this.providerId}`)
    return this.transport.connection
  }
  /** Bound one RPC. The health monitor already caps a whole probe, but
   * `listSessions` is also called straight from `AgentRuntime.listSessions`'s
   * fallback path, where nothing else would stop a silent agent from pinning
   * a throwaway process forever. */
  private rpc<T>(method: string, timeoutMs: number, work: Promise<T>): Promise<T> {
    return withTimeout(
      work,
      timeoutMs,
      () => new RpcTimeoutError(this.providerId, method, timeoutMs),
    )
  }
  private route(): BackendRoute {
    return {
      threadId: this.spec.threadId ?? `provider-probe:${this.providerId}`,
      workspaceId: this.spec.workspaceId,
    }
  }
  private emit(event: BackendEvent): void {
    this.deps.onEvent?.(event)
  }
  private pickAuthMethod(methods: AuthMethod[]): string | undefined {
    for (const hint of this.deps.config.auth.methodHints) {
      const match =
        methods.find((m) => m.id === hint) ??
        methods.find((m) => m.id.toLowerCase().includes(hint.toLowerCase()))
      if (match) return match.id
    }
    return methods[0]?.id
  }
  private authRequired(methods: AuthMethod[] | undefined, message: string): AuthRequiredError {
    this.emit(
      routeEvent(this.route(), undefined, 'error', 'auth_required', {
        message,
        authMethods: methods,
        loginHint: this.deps.config.auth.loginInstruction,
      }),
    )
    return new AuthRequiredError(this.providerId, message, this.deps.config.auth.loginInstruction)
  }
}

function probeEnvironment(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return { ...env, ...overrides }
}

export type AcpProbeRuntimeFactoryDeps = {
  configs: Readonly<Record<ProviderId, ProviderConfig>>
  host: Pick<HostDeps, 'log'>
  connections: AcpConnectionFactory
  timeouts?: Partial<RuntimeTimeouts>
  execFile?: ExecFile
}

/** Every ACP probe, silent by default. The health monitor asks for nothing but
 * the answer and so passes no options; the desktop bootstrap passes its
 * pseudo-thread and an `onEvent`, which is the only difference between the two
 * and the reason `AgentRuntime` no longer constructs probes by hand. */
export class AcpProbeRuntimeFactoryImpl implements ProbeRuntimeFactory {
  constructor(private readonly deps: AcpProbeRuntimeFactoryDeps) {}

  create(providerId: ProviderId, cwd: string, options: ProbeRuntimeOptions = {}): ProbeRuntime {
    return new AcpProbeRuntimeImpl(
      {
        providerId,
        cwd,
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      },
      {
        config: requireAcpConfig(this.deps.configs, providerId),
        host: this.deps.host,
        connections: this.deps.connections,
        ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
        ...(this.deps.execFile ? { execFile: this.deps.execFile } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      },
    )
  }
}
