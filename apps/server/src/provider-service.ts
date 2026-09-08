import { isDeepStrictEqual } from 'node:util'
import {
  ProviderHealthChangedEventSchema,
  ProviderProbeCommandSchema,
  ProviderProbeResponseSchema,
  type CommandEnvelope,
  type ErrorCode,
  type ProviderBootstrap,
  type ProviderHealth,
} from '@openmanager/protocol/node'
import { providers, type AgentRuntime, type ProviderConfig } from '@agentpack/runtime/node'

type ProviderId = keyof typeof providers
type RuntimeHealthReport = ReturnType<AgentRuntime['health']['report']>

const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})

/** Server-owned provider catalog, health snapshot and probe command boundary. */
export function createProviderService(
  runtime: AgentRuntime,
  providerConfigs: Readonly<Record<ProviderId, ProviderConfig>> = providers,
) {
  const listeners = new Set<(event: ReturnType<typeof healthEvent>) => void>()
  const previous = new Map<ProviderId, ProviderHealth>()
  const inFlightProbes = new Map<ProviderId, Promise<unknown>>()

  for (const providerId of Object.keys(providerConfigs) as ProviderId[]) {
    previous.set(providerId, publicHealth(runtime.health.report(providerId)))
  }

  const unsubscribe = runtime.health.onChange((providerId, report) => {
    if (!hasProvider(providerConfigs, providerId)) return
    const health = publicHealth(report)
    if (isDeepStrictEqual(previous.get(providerId), health)) return
    previous.set(providerId, health)
    const event = healthEvent(providerId, health)
    for (const listener of listeners) listener(event)
  })

  const provider = (providerId: ProviderId): ProviderBootstrap => {
    const config = providerConfigs[providerId]
    return {
      id: config.id,
      displayName: config.displayName,
      capabilities: config.capabilities,
      health: publicHealth(runtime.health.report(providerId)),
    }
  }

  return {
    snapshot(): ProviderBootstrap[] {
      return (Object.keys(providerConfigs) as ProviderId[]).map(provider)
    },

    start() {
      runtime.health.start()
    },

    stop() {
      unsubscribe()
      listeners.clear()
    },

    onHealthChanged(listener: (event: ReturnType<typeof healthEvent>) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    dispatch(command: CommandEnvelope): Promise<unknown> | undefined {
      if (command.name !== 'provider.probe') return undefined
      const parsed = ProviderProbeCommandSchema.safeParse(command)
      if (!parsed.success) {
        return Promise.resolve(
          errorResult(command.requestId, 'validation', 'Invalid provider probe request.'),
        )
      }
      const { providerId, cwd } = parsed.data.payload
      if (!hasProvider(providerConfigs, providerId)) {
        return Promise.resolve(errorResult(command.requestId, 'not_found', 'Provider not found.'))
      }
      let probe = inFlightProbes.get(providerId)
      if (!probe) {
        probe = runtime
          .probeProvider({
            providerId,
            threadId: `desktop-bootstrap:${providerId}`,
            workspaceId: cwd,
            cwd,
          })
          .finally(() => inFlightProbes.delete(providerId))
        inFlightProbes.set(providerId, probe)
      }
      return probe
        .then(() =>
          ProviderProbeResponseSchema.parse({
            type: 'response',
            requestId: command.requestId,
            payload: { provider: provider(providerId) },
          }),
        )
        .catch(() =>
          errorResult(command.requestId, 'unavailable', 'Provider probe did not complete.'),
        )
    },
  }
}

function hasProvider(
  configs: Readonly<Record<ProviderId, ProviderConfig>>,
  providerId: string,
): providerId is ProviderId {
  return Object.hasOwn(configs, providerId)
}

function healthEvent(providerId: ProviderId, health: ProviderHealth) {
  return ProviderHealthChangedEventSchema.parse({
    type: 'event',
    name: 'provider_health_changed',
    payload: { providerId, health },
  })
}

/** Strip executable paths, account labels, thread IDs and diagnostic messages from public health. */
function publicHealth(report: RuntimeHealthReport): ProviderHealth {
  const health = report.health
  return {
    summary: summarizeHealth(health),
    refreshing: report.refreshing,
    install: health.install.state,
    auth: health.auth.state,
    runtime: {
      state: health.runtime.state,
      liveProcesses: health.runtime.liveProcesses,
      activeTurns: health.runtime.activeTurns,
    },
    lastProbe: health.lastProbe
      ? {
          outcome: health.lastProbe.outcome,
          at: health.lastProbe.at,
          durationMs: health.lastProbe.durationMs,
        }
      : null,
    update: health.update.state,
  }
}

function summarizeHealth(health: RuntimeHealthReport['health']): ProviderHealth['summary'] {
  if (health.install.state === 'missing' || health.install.state === 'unusable') return 'error'
  if (health.auth.state === 'unauthenticated' || health.auth.state === 'error') return 'error'
  if (health.runtime.state === 'failed' || health.update.state === 'unsupported') return 'error'
  if (health.lastProbe === null && health.runtime.state === 'never_started') return 'unknown'
  if (
    health.runtime.state === 'degraded' ||
    health.lastProbe?.outcome === 'degraded' ||
    health.lastProbe?.outcome === 'timeout' ||
    health.update.state === 'behind'
  ) {
    return 'warning'
  }
  if (health.install.state === 'installed' && health.auth.state === 'authenticated') return 'ready'
  if (health.runtime.state === 'stopped') return 'stopped'
  return 'unknown'
}
