import type { ProviderId } from '@agentpack/contract'
import type { InteractionBroker } from '../core/InteractionBroker.js'
import type { PermissionBroker } from '../core/PermissionBroker.js'
import type { HostDeps } from '../host.js'
import type { ProviderConfig } from '../providers/index.js'
import type { ExecFile } from '../providers/opencode-models.js'
import type { AcpConnectionFactory } from './AcpConnection.js'
import { AcpProbeRuntimeFactoryImpl } from './AcpProbeRuntimeImpl.js'
import {
  AcpSessionRuntimeFactory,
  type ManagedSessionRuntime,
  type ManagedSessionRuntimeFactory,
} from './AcpSessionRuntimeImpl.js'
import { ClaudeProbeRuntime } from './claude/ClaudeProbeRuntime.js'
import { CodexProbeRuntime } from './codex/CodexProbeRuntime.js'
import { CodexService } from './codex/CodexService.js'
import { CodexSessionRuntime } from './codex/CodexSessionRuntime.js'
import type { CodexStarter } from './codex/start.js'
import { ClaudeSessionRuntime } from './claude/ClaudeSessionRuntime.js'
import type { ClaudeSdk } from './claude/sdk.js'
import type { RuntimeTimeouts } from './constants.js'
import type { ProbeRuntime, ProbeRuntimeFactory, ProbeRuntimeOptions } from './ProbeRuntime.js'
import type { SessionRuntimeSpec } from './SessionRuntime.js'

/** How a provider's runtimes are built, chosen by `ProviderConfig.kind`.
 *
 * `AgentRuntime` used to name `AcpSessionRuntimeFactory` and
 * `AcpProbeRuntimeFactoryImpl` directly, which made "every provider is a CLI
 * that speaks ACP" a property of the runtime rather than of the provider
 * config. These two dispatch on the config instead, so a provider reached some
 * other way is a new arm here and nothing else. */

/** The ACP transport, resolved on first use rather than held.
 *
 * `AgentRuntime` used to build a `ChildProcessConnectionFactory` in its
 * constructor whether or not anything would ever spawn a child. Passing a
 * thunk keeps that construction inside the `'acp'` arm, so a provider that
 * never spawns a process never causes one to be prepared for it, while the
 * `options.connections` test seam still short-circuits it entirely. */
type AcpTransport = () => AcpConnectionFactory

export type ProviderSessionRuntimeFactoryDeps = {
  configs: Readonly<Record<ProviderId, ProviderConfig>>
  host: Pick<HostDeps, 'log' | 'onSessionTitle' | 'agentTools' | 'sessionHistory'>
  permissions: PermissionBroker
  interactions: InteractionBroker
  connections: AcpTransport
  /** The Claude arm's transport seam, the exact counterpart of `connections`.
   * Defaults to loading the published SDK, which spawns the real CLI; tests
   * inject `FakeClaudeSdk` so a Claude runtime can be driven end to end
   * without one. */
  claudeSdk?: ClaudeSdk
  /** The Codex arm's transport seam: starts one app-server. Defaults to
   * spawning the real binary; tests inject a starter wired to a fake. */
  codexStart?: CodexStarter
  timeouts?: Partial<RuntimeTimeouts>
}

export type ProviderProbeRuntimeFactoryDeps = {
  configs: Readonly<Record<ProviderId, ProviderConfig>>
  host: Pick<HostDeps, 'log'>
  connections: AcpTransport
  timeouts?: Partial<RuntimeTimeouts>
  execFile?: ExecFile
  /** The SDK a Claude probe drives; the real module when absent. */
  claudeSdk?: ClaudeSdk
  /** How the Codex service process starts its app-server; the real binary
   * when absent. Unused when `codexService` is given. */
  codexStart?: CodexStarter
  /** The environment's Codex service process, which serves every Codex
   * probe. `AgentRuntime` owns it; without one the factory keeps its own,
   * stopped by `shutdown()`. */
  codexService?: (providerId: ProviderId) => CodexService
}

export class ProviderSessionRuntimeFactory implements ManagedSessionRuntimeFactory {
  /** Built once, on the first ACP session. Holding it keeps a single transport
   * shared by every ACP runtime, exactly as the eager field it replaced did. */
  private acp: AcpSessionRuntimeFactory | undefined

  constructor(private readonly deps: ProviderSessionRuntimeFactoryDeps) {}

  create(spec: SessionRuntimeSpec): ManagedSessionRuntime {
    const config = this.deps.configs[spec.providerId]
    if (!config) throw new Error(`Unknown provider: ${spec.providerId}`)
    switch (config.kind) {
      case 'acp':
        return this.acpFactory().create(spec)
      case 'claude':
        // No shared transport to build and nothing to memoise: the SDK owns
        // its own subprocess per query, so each runtime is standalone.
        return new ClaudeSessionRuntime(spec, {
          config,
          host: this.deps.host,
          permissions: this.deps.permissions,
          interactions: this.deps.interactions,
          ...(this.deps.claudeSdk ? { sdk: this.deps.claudeSdk } : {}),
          ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
        })
      case 'codex':
        // One app-server per session, like Claude's one query per session:
        // nothing shared to build or memoise.
        return new CodexSessionRuntime(spec, {
          config,
          host: this.deps.host,
          permissions: this.deps.permissions,
          interactions: this.deps.interactions,
          ...(this.deps.codexStart ? { start: this.deps.codexStart } : {}),
          ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
        })
    }
  }

  private acpFactory(): AcpSessionRuntimeFactory {
    this.acp ??= new AcpSessionRuntimeFactory({
      configs: this.deps.configs,
      host: this.deps.host,
      permissions: this.deps.permissions,
      interactions: this.deps.interactions,
      connections: this.deps.connections(),
      ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
    })
    return this.acp
  }
}

export class ProviderProbeRuntimeFactory implements ProbeRuntimeFactory {
  private acp: AcpProbeRuntimeFactoryImpl | undefined
  /** Service processes this factory had to build itself, per provider. */
  private readonly ownCodexServices = new Map<ProviderId, CodexService>()

  constructor(private readonly deps: ProviderProbeRuntimeFactoryDeps) {}

  /** Codex alone keeps an archive a deleted session's thread goes to. */
  archives(providerId: ProviderId): boolean {
    return this.deps.configs[providerId]?.kind === 'codex'
  }

  create(providerId: ProviderId, cwd: string, options?: ProbeRuntimeOptions): ProbeRuntime {
    const config = this.deps.configs[providerId]
    if (!config) throw new Error(`Unknown provider: ${providerId}`)
    switch (config.kind) {
      case 'acp':
        return this.acpFactory().create(providerId, cwd, options)
      case 'claude':
        return new ClaudeProbeRuntime(
          {
            providerId,
            cwd,
            ...(options?.threadId ? { threadId: options.threadId } : {}),
            ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
          },
          {
            config,
            host: this.deps.host,
            ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
            ...(this.deps.claudeSdk ? { sdk: this.deps.claudeSdk } : {}),
            ...(options?.onEvent ? { onEvent: options.onEvent } : {}),
          },
        )
      case 'codex':
        return new CodexProbeRuntime(
          {
            providerId,
            cwd,
            ...(options?.threadId ? { threadId: options.threadId } : {}),
            ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
          },
          {
            config,
            host: this.deps.host,
            service: this.codexService(providerId),
            ...(options?.onEvent ? { onEvent: options.onEvent } : {}),
          },
        )
    }
  }

  /** The service process that answers this provider's probes. */
  codexService(providerId: ProviderId): CodexService {
    if (this.deps.codexService) return this.deps.codexService(providerId)
    let service = this.ownCodexServices.get(providerId)
    if (!service) {
      service = new CodexService({
        providerId,
        host: this.deps.host,
        ...(this.deps.codexStart ? { start: this.deps.codexStart } : {}),
        ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
      })
      this.ownCodexServices.set(providerId, service)
    }
    return service
  }

  /** Stop the service processes this factory built for itself. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.ownCodexServices.values()].map((service) => service.shutdown()))
    this.ownCodexServices.clear()
  }

  private acpFactory(): AcpProbeRuntimeFactoryImpl {
    this.acp ??= new AcpProbeRuntimeFactoryImpl({
      configs: this.deps.configs,
      host: this.deps.host,
      connections: this.deps.connections(),
      ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
      ...(this.deps.execFile ? { execFile: this.deps.execFile } : {}),
    })
    return this.acp
  }
}
