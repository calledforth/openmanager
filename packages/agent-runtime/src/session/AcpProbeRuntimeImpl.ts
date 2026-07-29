import type * as acp from '@agentclientprotocol/sdk'
import type { AuthMethod, ModelListing, ProviderId, ProviderSessionInfo } from '@agentpack/contract'
import type { BackendEvent, BackendRoute } from '../backends/Backend.js'
import { AuthRequiredError } from '../core/errors.js'
import type { HostDeps } from '../host.js'
import type { ProviderConfig } from '../providers/index.js'
import type { AcpProbeResult, AcpProbeRuntime, AcpProbeRuntimeFactory } from './AcpProbeRuntime.js'
import type { AcpConnection, AcpConnectionFactory } from './AcpSessionRuntime.js'
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
  config: ProviderConfig
  host: Pick<HostDeps, 'log'>
  connections: AcpConnectionFactory
  timeouts?: Partial<RuntimeTimeouts>
  /** When present the probe emits the same `process_spawned` / `initialized` /
   * `authenticated` / `auth_required` events the shared per-provider process
   * used to emit on `AgentRuntime.start`. The renderer learns agent info and
   * prompt capabilities from `initialized`, so the bootstrap path supplies
   * this; repeat metadata probes stay silent to avoid event spam. */
  onEvent?: (event: BackendEvent) => void
}

/** A throwaway process for provider-level questions that must not touch a live
 * session: the handshake, `session/list`, model catalogs, and (Phase 3) health
 * probes. On Cursor every model/config write is process-global, so asking
 * these inside a session process would change the model a user's turn runs on. */
export class AcpProbeRuntimeImpl implements AcpProbeRuntime {
  readonly providerId: ProviderId
  private transport: AcpConnection | null = null
  private result: AcpProbeResult | undefined
  private readonly timeouts: RuntimeTimeouts

  constructor(
    private readonly spec: AcpProbeSpec,
    private readonly deps: AcpProbeDeps,
  ) {
    this.providerId = spec.providerId
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
  }

  async probe(): Promise<AcpProbeResult> {
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

  private async handshake(): Promise<AcpProbeResult> {
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
    const capabilities = object(response.agentCapabilities)
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'initialized', {
        protocolVersion: string(response.protocolVersion),
        agentInfo: agentInfo(response),
        capabilities: { ...this.deps.config.capabilities, canListSessions: advertised },
        promptCapabilities: capabilities.promptCapabilities,
        authMethods: methods,
      }),
    )
    const result: AcpProbeResult = {
      agentInfo: agentInfo(response),
      protocolVersion: string(response.protocolVersion),
      authMethods: methods,
      authenticated: true,
      promptCapabilities: capabilities.promptCapabilities as AcpProbeResult['promptCapabilities'],
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

  async listModels(cwd: string): Promise<ModelListing> {
    await this.probe()
    const response = object(
      await this.rpc(
        'session/new',
        this.timeouts.newSessionMs,
        this.connection().newSession({ cwd, mcpServers: [] }),
      ),
    )
    return initialState(response).models ?? {}
  }

  async dispose(): Promise<void> {
    const transport = this.transport
    this.transport = null
    if (!transport) return
    await transport.terminate({ reason: 'disposed' })
  }

  private async connect(): Promise<void> {
    if (this.transport) return
    const command = this.deps.config.command
    const bin =
      process.env[command.envOverride] ??
      (command.fallbackEnvOverride ? process.env[command.fallbackEnvOverride] : undefined) ??
      command.bin
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
   * `listSessions`/`listModels` are also called straight from
   * `AgentRuntime.listSessions`'s fallback path, where nothing else would stop
   * a silent agent from pinning a throwaway process forever. */
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
}

/** Phase 0's factory shape: silent probes, for callers that only want the
 * answer (Phase 3's health monitor). `AgentRuntime` builds probes directly
 * when it also needs the lifecycle events. */
export class AcpProbeRuntimeFactoryImpl implements AcpProbeRuntimeFactory {
  constructor(private readonly deps: AcpProbeRuntimeFactoryDeps) {}

  create(providerId: ProviderId, cwd: string): AcpProbeRuntime {
    const config = this.deps.configs[providerId]
    if (!config) throw new Error(`Unknown provider: ${providerId}`)
    return new AcpProbeRuntimeImpl(
      { providerId, cwd },
      {
        config,
        host: this.deps.host,
        connections: this.deps.connections,
        ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
      },
    )
  }
}
