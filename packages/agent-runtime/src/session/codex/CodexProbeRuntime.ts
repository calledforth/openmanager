import type { ModelListing, ProviderId, ProviderSessionInfo } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import type { BackendEvent, BackendRoute } from '../../backends/Backend.js'
import { AuthRequiredError, CapabilityMissingError } from '../../core/errors.js'
import type { HostDeps } from '../../host.js'
import type { CodexProviderConfig } from '../../providers/index.js'
import { DEFAULT_RUNTIME_TIMEOUTS, type RuntimeTimeouts } from '../constants.js'
import type { ThreadId } from '../lifecycle.js'
import type { ProbeResult, ProbeRuntime } from '../ProbeRuntime.js'
import { routeEvent } from '../wire.js'
import { codexModelListing, readCodexModels } from './codex-catalog.js'
import type { CodexAppServerClient } from './CodexAppServerClient.js'
import { startRealCodex, type CodexStarter } from './start.js'

export type CodexProbeSpec = {
  providerId: ProviderId
  cwd: string
  threadId?: ThreadId
  workspaceId?: string
}

export type CodexProbeDeps = {
  config: CodexProviderConfig
  host: Pick<HostDeps, 'log'>
  timeouts?: Partial<RuntimeTimeouts>
  /** Starts the app-server. The real binary when absent. */
  start?: CodexStarter
  env?: NodeJS.ProcessEnv
  onEvent?: (event: BackendEvent) => void
}

/** What `account/read` says about signing in, told apart properly: a
 * signed-in account *also* reports `requiresOpenaiAuth: true`, so that flag
 * alone means nothing. */
export type CodexAccountState =
  | { state: 'signed_in'; account: v2.Account }
  | { state: 'signed_out' }
  | { state: 'not_required' }

export function codexAccountState(response: v2.GetAccountResponse): CodexAccountState {
  if (response.account) return { state: 'signed_in', account: response.account }
  return response.requiresOpenaiAuth ? { state: 'signed_out' } : { state: 'not_required' }
}

export const CODEX_LOGIN_HINT = 'codex login'

/** Provider-level questions for Codex, answered by a short-lived app-server
 * that never starts a thread: the handshake, the account, and the model
 * catalog. Nothing here costs tokens or leaves a thread in the user's Codex
 * history.
 *
 * This is the first cut: the long-lived service process the decision calls
 * for (one per environment, shared with login, limits and MCP status) replaces
 * the throwaway process in CAL-249, and the fuller catalog (service tiers,
 * policy limits, feature flags) arrives in CAL-250. */
export class CodexProbeRuntime implements ProbeRuntime {
  readonly providerId: ProviderId
  private result: ProbeResult | undefined
  private inFlight: Promise<ProbeResult> | undefined
  private client: CodexAppServerClient | undefined
  /** The app-server still being started, so `dispose` can wait for it. */
  private starting: Promise<CodexAppServerClient> | undefined
  private disposed = false
  private readonly timeouts: RuntimeTimeouts

  constructor(
    private readonly spec: CodexProbeSpec,
    private readonly deps: CodexProbeDeps,
  ) {
    this.providerId = spec.providerId
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
  }

  /** Spawn, handshake, read the account and the catalog. Throws
   * `CodexNotInstalledError` (read as "missing"), `AuthRequiredError` when
   * signed out, and the handshake's own error for a CLI that runs but is
   * unusable (too old, crashed). Memoised. */
  probe(): Promise<ProbeResult> {
    if (this.result) return Promise.resolve(this.result)
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async run(): Promise<ProbeResult> {
    // A retry after a failed probe starts afresh; the earlier process goes.
    const previous = this.client
    this.client = undefined
    if (previous) await previous.terminate({ reason: 'disposed' }).catch(() => undefined)
    this.starting = (this.deps.start ?? startRealCodex)({
      cwd: this.spec.cwd,
      env: this.deps.env ?? process.env,
      timeouts: this.timeouts,
      log: this.deps.host.log,
    })
    let client: CodexAppServerClient
    try {
      client = await this.starting
    } finally {
      this.starting = undefined
    }
    if (this.disposed) {
      // Disposed while the process was still starting: nobody wants it.
      await client.terminate({ reason: 'disposed' }).catch(() => undefined)
      throw new Error('Codex probe was disposed before it finished starting')
    }
    this.client = client
    const info = client.info
    const agentInfo = {
      name: 'Codex',
      ...(info?.version.version ? { version: info.version.version } : {}),
    }
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'process_spawned', {
        cwd: this.spec.cwd,
        command: 'codex',
        args: ['app-server'],
      }),
    )

    const account = codexAccountState(await client.request('account/read', { refreshToken: false }))
    if (account.state === 'signed_out')
      throw new AuthRequiredError(
        this.providerId,
        'Codex is signed out. Run `codex login` on this machine.',
        CODEX_LOGIN_HINT,
      )

    const models = codexModelListing(await readCodexModels(client))
    const result: ProbeResult = {
      agentInfo,
      authMethods: [],
      authenticated: true,
      sessionListAdvertised: false,
      loadSessionAdvertised: this.deps.config.capabilities.canLoadSession,
      models,
    }
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'initialized', {
        agentInfo,
        capabilities: this.deps.config.capabilities,
        authMethods: [],
      }),
    )
    this.deps.host.log({
      scope: 'codex',
      level: 'info',
      message: 'Codex probe initialized',
      data: {
        version: info?.version.version,
        versionStatus: info?.version.status,
        account: account.state === 'signed_in' ? account.account.type : account.state,
        models: models.availableModels?.length ?? 0,
      },
    })
    this.result = result
    return result
  }

  listSessions(_cwd: string): Promise<ProviderSessionInfo[]> {
    return Promise.reject(
      new CapabilityMissingError(this.providerId, 'canListSessions', 'listing sessions'),
    )
  }

  /** The catalog `probe()` read; asking twice costs one process. */
  async listModels(_cwd: string): Promise<ModelListing> {
    return (await this.probe()).models ?? {}
  }

  /** Stops the process at once, even mid-probe: a probe is disposed when its
   * caller gave up on it (a health timeout), and waiting for a wedged one to
   * finish would hold the process for no one. */
  async dispose(): Promise<void> {
    this.disposed = true
    const client = this.client
    this.client = undefined
    if (client) await client.terminate({ reason: 'disposed' }).catch(() => undefined)
    // A process still starting is waited for and stopped here, so `dispose`
    // resolves only once nothing is left running: the health monitor lets the
    // next probe go when this one's process is gone.
    const starting = this.starting
    if (starting) {
      const late = await starting.catch(() => undefined)
      if (late) await late.terminate({ reason: 'disposed' }).catch(() => undefined)
    }
  }

  private route(): BackendRoute {
    return {
      threadId: this.spec.threadId ?? `provider-probe:${this.providerId}`,
      ...(this.spec.workspaceId ? { workspaceId: this.spec.workspaceId } : {}),
    }
  }

  private emit(event: BackendEvent): void {
    this.deps.onEvent?.(event)
  }
}
