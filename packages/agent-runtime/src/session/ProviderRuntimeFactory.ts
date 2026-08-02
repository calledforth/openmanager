import type { ProviderId } from '@agentpack/contract'
import type { ExtensionBroker } from '../core/ExtensionBroker.js'
import type { PermissionBroker } from '../core/PermissionBroker.js'
import type { HostDeps } from '../host.js'
import type { ProviderConfig } from '../providers/index.js'
import type { AcpConnectionFactory } from './AcpConnection.js'
import { AcpProbeRuntimeFactoryImpl } from './AcpProbeRuntimeImpl.js'
import {
  AcpSessionRuntimeFactory,
  type ManagedSessionRuntime,
  type ManagedSessionRuntimeFactory,
} from './AcpSessionRuntimeImpl.js'
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
  host: Pick<HostDeps, 'log' | 'onSessionTitle'>
  permissions: PermissionBroker
  extensions: ExtensionBroker
  connections: AcpTransport
  timeouts?: Partial<RuntimeTimeouts>
}

export type ProviderProbeRuntimeFactoryDeps = {
  configs: Readonly<Record<ProviderId, ProviderConfig>>
  host: Pick<HostDeps, 'log'>
  connections: AcpTransport
  timeouts?: Partial<RuntimeTimeouts>
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
        throw notImplemented(config.id, 'session runtime')
    }
  }

  private acpFactory(): AcpSessionRuntimeFactory {
    this.acp ??= new AcpSessionRuntimeFactory({
      configs: this.deps.configs,
      host: this.deps.host,
      permissions: this.deps.permissions,
      extensions: this.deps.extensions,
      connections: this.deps.connections(),
      ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
    })
    return this.acp
  }
}

export class ProviderProbeRuntimeFactory implements ProbeRuntimeFactory {
  private acp: AcpProbeRuntimeFactoryImpl | undefined

  constructor(private readonly deps: ProviderProbeRuntimeFactoryDeps) {}

  create(providerId: ProviderId, cwd: string, options?: ProbeRuntimeOptions): ProbeRuntime {
    const config = this.deps.configs[providerId]
    if (!config) throw new Error(`Unknown provider: ${providerId}`)
    switch (config.kind) {
      case 'acp':
        return this.acpFactory().create(providerId, cwd, options)
      case 'claude':
        throw notImplemented(config.id, 'probe runtime')
    }
  }

  private acpFactory(): AcpProbeRuntimeFactoryImpl {
    this.acp ??= new AcpProbeRuntimeFactoryImpl({
      configs: this.deps.configs,
      host: this.deps.host,
      connections: this.deps.connections(),
      ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
    })
    return this.acp
  }
}

/** Unreachable today — `PROVIDER_IDS` has no `'claude'`, so no config can
 * carry that kind. It throws rather than falling through to the ACP arm
 * because the failure mode of guessing is spawning some other provider's CLI;
 * a named error is what the commit that adds the implementation deletes. */
function notImplemented(providerId: ProviderId, what: string): Error {
  return new Error(`The ${providerId} ${what} is not implemented yet`)
}
