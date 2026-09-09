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
const MAX_PENDING_PROBES_PER_PROVIDER = 8

const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})

/** Server-owned provider catalog, health snapshot and probe command boundary. */
export function createProviderService(
  runtime: AgentRuntime,
  providerConfigs: Readonly<Record<ProviderId, ProviderConfig>> = providers,
  observeCatalog: (providerId: ProviderId, result: Awaited<ReturnType<AgentRuntime['probeProvider']>>) => void =
    () => undefined,
) {
  const listeners = new Set<(event: ReturnType<typeof healthEvent>) => void>()
  const previous = new Map<ProviderId, ProviderHealth>()
  const pendingProbes = new Map<ProviderId, Map<string, Promise<unknown>>>()
  // One global tail so two providers never hold CLI processes at the same time.
  let probeTail: Promise<void> = Promise.resolve()

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

    rejection(providerId: string): { code: ErrorCode; message: string } | undefined {
      if (!hasProvider(providerConfigs, providerId)) {
        return { code: 'not_found', message: 'Provider not found.' }
      }
      const health = runtime.health.report(providerId).health
      // A probe is launched in one workspace. ENOENT from spawn cannot tell a
      // missing executable from a missing cwd, so a probe-only failure is not
      // evidence that this provider is unavailable in every workspace. An
      // actual session runtime failure is provider-wide and remains a gate.
      const probeOnlyFailure =
        health.runtime.state === 'never_started' &&
        (health.lastProbe?.outcome === 'failed' || health.lastProbe?.outcome === 'timeout')
      if (health.auth.state === 'unauthenticated' || health.auth.state === 'error') {
        return { code: 'auth', message: 'Provider authentication is required.' }
      }
      if (
        !probeOnlyFailure &&
        (health.install.state === 'missing' || health.install.state === 'unusable')
      ) {
        return { code: 'unavailable', message: 'Provider executable is unavailable.' }
      }
      if (health.runtime.state === 'failed' || health.runtime.state === 'degraded') {
        return { code: 'unavailable', message: 'Provider is unhealthy.' }
      }
      return undefined
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
      const existingProviderProbes = pendingProbes.get(providerId)
      const providerProbes = existingProviderProbes ?? new Map<string, Promise<unknown>>()
      if (!existingProviderProbes) pendingProbes.set(providerId, providerProbes)
      let probe = providerProbes.get(cwd)
      if (!probe) {
        if (providerProbes.size >= MAX_PENDING_PROBES_PER_PROVIDER) {
          return Promise.resolve(
            errorResult(command.requestId, 'unavailable', 'Provider probe queue is full.'),
          )
        }
        const previousProbe = probeTail
        probe = previousProbe.then(() =>
          runtime.probeProvider({
            providerId,
            threadId: `desktop-bootstrap:${providerId}`,
            workspaceId: cwd,
            cwd,
          }),
        )
        providerProbes.set(cwd, probe)
        const tail = probe.then(
          () => undefined,
          () => undefined,
        )
        probeTail = tail
        void tail.then(() => {
          if (providerProbes.get(cwd) === probe) providerProbes.delete(cwd)
          if (providerProbes.size === 0) pendingProbes.delete(providerId)
          if (probeTail === tail) probeTail = Promise.resolve()
        })
      }
      return probe
        .then((result) => {
          // Test doubles and older embedders may only signal probe completion.
          // A real AgentRuntime returns the catalog-bearing bootstrap object.
          if (result && typeof result === 'object') {
            observeCatalog(providerId, result as Awaited<ReturnType<AgentRuntime['probeProvider']>>)
          }
          return ProviderProbeResponseSchema.parse({
            type: 'response',
            requestId: command.requestId,
            payload: { provider: provider(providerId) },
          })
        })
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
