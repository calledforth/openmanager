import type { ModelListing, ProviderId, ProviderSessionInfo } from '@agentpack/contract'
import type { BackendEvent, BackendRoute } from '../../backends/Backend.js'
import { AuthRequiredError, CapabilityMissingError } from '../../core/errors.js'
import type { HostDeps } from '../../host.js'
import type { CodexProviderConfig } from '../../providers/index.js'
import type { ThreadId } from '../lifecycle.js'
import type { ProbeResult, ProbeRuntime, ProbeUpdateAdvisory } from '../ProbeRuntime.js'
import { routeEvent } from '../wire.js'
import {
  CODEX_LOGIN_HINT,
  CODEX_SIGNED_OUT_MESSAGE,
  codexAccountLabel,
} from './codex-account.js'
import { codexModeListing, defaultCodexAccessPreset } from './codex-access.js'
import { codexModelListing, codexPolicy } from './codex-catalog.js'
import type { CodexHandshake } from './CodexAppServerClient.js'
import type { CodexService } from './CodexService.js'
import { CODEX_MIN_VERSION, CODEX_RECOMMENDED_VERSION } from './version.js'

// Kept importable from here, where they were first defined.
export {
  CODEX_LOGIN_HINT,
  codexAccountState,
  type CodexAccountState,
} from './codex-account.js'

export type CodexProbeSpec = {
  providerId: ProviderId
  cwd: string
  threadId?: ThreadId
  workspaceId?: string
}

export type CodexProbeDeps = {
  config: CodexProviderConfig
  host: Pick<HostDeps, 'log'>
  /** The environment's service process, which answers every question. */
  service: CodexService
  onEvent?: (event: BackendEvent) => void
  /** The machine's platform, for the default access preset. */
  platform?: NodeJS.Platform
}

/** Provider-level questions for Codex, answered by the environment's service
 * process (`CodexService`) rather than a process of its own: the handshake,
 * the account, the model catalog, the permission profiles, the managed
 * policy and the feature flags. Nothing here starts a thread, so nothing
 * costs tokens or lands in the user's Codex history.
 *
 * The process belongs to the service, so disposing a probe only abandons
 * its own questions; the process stays for the next caller until it idles. */
export class CodexProbeRuntime implements ProbeRuntime {
  readonly providerId: ProviderId
  private result: ProbeResult | undefined
  private inFlight: Promise<ProbeResult> | undefined
  private readonly abort = new AbortController()

  constructor(
    private readonly spec: CodexProbeSpec,
    private readonly deps: CodexProbeDeps,
  ) {
    this.providerId = spec.providerId
  }

  /** Read the account, and when it may be used, the catalog and policy.
   * Throws `CodexNotInstalledError` (read as "missing"),
   * `CodexVersionUnsupportedError` for a CLI too old to run,
   * `AuthRequiredError` when signed out, and the process's own error for a
   * CLI that runs but is unusable. Memoised. */
  probe(): Promise<ProbeResult> {
    if (this.result) return Promise.resolve(this.result)
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async run(): Promise<ProbeResult> {
    const discovery = await this.deps.service.discover({
      cwd: this.spec.cwd,
      signal: this.abort.signal,
    })
    const handshake = discovery.handshake
    const agentInfo = {
      name: 'Codex',
      ...(handshake?.version.version ? { version: handshake.version.version } : {}),
    }
    // Only when this probe really started the process: one it found running
    // was announced by whoever started it.
    if (discovery.spawned) {
      const pid = this.deps.service.status.pid
      this.emit(
        routeEvent(this.route(), undefined, 'lifecycle', 'process_spawned', {
          cwd: this.spec.cwd,
          command: 'codex',
          args: ['app-server'],
          ...(pid !== undefined ? { processId: pid } : {}),
        }),
      )
    }
    if (discovery.account.state === 'signed_out')
      throw new AuthRequiredError(this.providerId, CODEX_SIGNED_OUT_MESSAGE, CODEX_LOGIN_HINT)

    const context = {
      ...(discovery.requirements ? { requirements: discovery.requirements.requirements } : {}),
      ...(discovery.features ? { features: discovery.features } : {}),
      ...(discovery.webSearch !== undefined ? { webSearch: discovery.webSearch } : {}),
    }
    const models = codexModelListing(discovery.models, context)
    // Asked and answered (even "no policy") is a policy; a CLI that could
    // not say leaves it absent, so an older answer is not wiped.
    const policy =
      discovery.requirements || discovery.permissionProfiles || discovery.features
        ? codexPolicy({
            ...(discovery.requirements ? { requirements: discovery.requirements.requirements } : {}),
            ...(discovery.permissionProfiles
              ? { permissionProfiles: discovery.permissionProfiles }
              : {}),
            ...(discovery.features ? { features: discovery.features } : {}),
          })
        : undefined
    const accountLabel = codexAccountLabel(discovery.account)
    const update = codexUpdateAdvisory(handshake)
    const result: ProbeResult = {
      agentInfo,
      authMethods: [],
      authenticated: true,
      ...(accountLabel ? { accountLabel } : {}),
      ...(update ? { update } : {}),
      sessionListAdvertised: false,
      loadSessionAdvertised: this.deps.config.capabilities.canLoadSession,
      models,
      // Access is Codex's mode control: the presets, with the one a new
      // session starts in.
      modes: codexModeListing(defaultCodexAccessPreset(this.deps.platform)),
      ...(policy ? { policy } : {}),
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
      message: 'Codex probe answered',
      data: {
        version: handshake?.version.version,
        versionStatus: handshake?.version.status,
        account:
          discovery.account.state === 'signed_in'
            ? discovery.account.account.type
            : discovery.account.state,
        models: models.availableModels?.length ?? 0,
        managedPolicy: discovery.requirements ? discovery.requirements.requirements !== null : 'unknown',
        features: discovery.features,
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

  /** Archive a deleted session's thread on the service process
   * (`CodexService.archiveThread`). */
  archiveSession(sessionId: string): Promise<void> {
    return this.deps.service.archiveThread(sessionId)
  }

  /** The catalog `probe()` read; asking twice asks once. */
  async listModels(_cwd: string): Promise<ModelListing> {
    return (await this.probe()).models ?? {}
  }

  /** Abandons this probe's questions at once, even mid-probe: a probe is
   * disposed when its caller gave up on it (a health timeout). The service
   * process stays; a wedged one is replaced by the service itself when a
   * request times out. */
  async dispose(): Promise<void> {
    this.abort.abort(new Error('Codex probe was disposed before it finished'))
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

/** The handshake's version against what openmanager supports. A version
 * below the minimum never gets here: the handshake refuses it. */
export function codexUpdateAdvisory(handshake: CodexHandshake | undefined): ProbeUpdateAdvisory | undefined {
  const check = handshake?.version
  if (!check) return undefined
  const bounds = { latestVersion: CODEX_RECOMMENDED_VERSION, minimumVersion: CODEX_MIN_VERSION }
  switch (check.status) {
    case 'supported':
      return { state: 'current', ...bounds }
    case 'outdated':
      return {
        state: 'behind',
        ...bounds,
        message: `Codex ${check.version ?? ''} works; ${CODEX_RECOMMENDED_VERSION} is recommended.`,
      }
    case 'unsupported':
      return {
        state: 'unsupported',
        ...bounds,
        message: `Update Codex to ${CODEX_MIN_VERSION} or later.`,
      }
    case 'unknown':
      return { state: 'unknown', ...bounds }
  }
}
