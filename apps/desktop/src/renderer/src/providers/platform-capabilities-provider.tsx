import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import {
  deriveProviderUiStatus,
  type ProviderHealthReport,
  type ProviderUiStatus,
} from '@openmanager/shared/contracts/provider-health'
import {
  isProviderId,
  type ProviderId,
  type ProviderMetadata,
  type PromptCapabilities,
} from '@agentpack/contract'
import {
  composerProfilesFromDocs,
  type ProviderComposerProfileDoc,
} from '@openmanager/shared/contracts/composer-profile'
import {
  PlatformCapabilitiesContext,
  coordinateProviderConnection,
  type AgentInfo,
  type PlatformCapabilitiesValue,
} from '@openmanager/app-core/providers/platform-provider'
import { useTrackedQuery } from '../lib/convex-telemetry'
export * from '@openmanager/app-core/providers/platform-provider'

/** Host-backed platform capabilities: provider registry and health from the
 * main process, handshake info from ACP events, and this client's identity. */
export function PlatformCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<ProviderMetadata[]>([])
  const [providerHealthByProvider, setProviderHealthByProvider] = useState<
    Partial<Record<ProviderId, ProviderHealthReport>>
  >({})
  const [connectingProviders, setConnectingProviders] = useState<
    Partial<Record<ProviderId, boolean>>
  >({})
  const providerConnectionPromisesRef = useRef<Map<ProviderId, Promise<boolean>>>(new Map())
  const [acpAgentInfoByProvider, setAcpAgentInfoByProvider] = useState<
    Partial<Record<ProviderId, AgentInfo>>
  >({})
  const [acpPromptCapabilitiesByProvider, setAcpPromptCapabilitiesByProvider] = useState<
    Partial<Record<ProviderId, PromptCapabilities>>
  >({})
  const [currentClientId, setCurrentClientId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The pushed health snapshot is the source of truth; the local connecting
  // flag only bridges the gap between clicking Retry and the main process's
  // first push. Health is re-derived on every push, so a snapshot ageing out
  // is picked up by the next one — no ticking clock, which would re-render
  // every consumer of this context on a timer.
  const agentUiStatusByProvider = useMemo(() => {
    const now = Date.now()
    const result: Partial<Record<ProviderId, ProviderUiStatus>> = {}
    const providerIds = new Set([
      ...Object.keys(providerHealthByProvider),
      ...Object.keys(connectingProviders),
    ])
    for (const providerId of providerIds) {
      if (!isProviderId(providerId)) continue
      const status = deriveProviderUiStatus(providerHealthByProvider[providerId], now)
      result[providerId] =
        status === 'unknown' && connectingProviders[providerId] ? 'probing' : status
    }
    return result
  }, [providerHealthByProvider, connectingProviders])

  const providerDisplayName = useCallback(
    (providerId: ProviderId) =>
      providers.find((provider) => provider.id === providerId)?.displayName ?? providerId,
    [providers],
  )

  const ensureProvider = useCallback(async (providerId: ProviderId, cwd: string) => {
    return coordinateProviderConnection(
      providerConnectionPromisesRef.current,
      providerId,
      async () => {
        setConnectingProviders((prev) => ({ ...prev, [providerId]: true }))
        try {
          const handshake = await window.electronAPI.ensureAgentProvider(providerId, cwd)
          return handshake.ready
        } catch {
          return false
        } finally {
          setConnectingProviders((prev) => ({ ...prev, [providerId]: false }))
        }
      },
    )
  }, [])

  const retryProvider = useCallback(
    async (providerId: ProviderId, cwd = '') => {
      setError(null)
      const ready = await ensureProvider(providerId, cwd)
      if (!ready) setError(`Failed to connect to ${providerDisplayName(providerId)}.`)
    },
    [ensureProvider, providerDisplayName],
  )

  // Provider metadata is not frozen at launch. `models` is filled in by the
  // first successful probe of each provider, and the health monitor probes
  // every provider at boot — so re-reading on each health change is what turns
  // "Claude Code has no models yet" into a populated composer picker without
  // the user having to select it first. The identity guard matters: this
  // fires several times per handshake, and a fresh array every time would
  // re-render every consumer of `providers` for an unchanged answer.
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      window.electronAPI
        .getAgentProviders()
        .then((next) => {
          if (cancelled) return
          setProviders((current) =>
            JSON.stringify(current) === JSON.stringify(next) ? current : next,
          )
        })
        .catch(() => undefined)
    }
    load()
    const cleanup = window.electronAPI.onAgentStatusChanged(() => load())
    return () => {
      cancelled = true
      cleanup()
    }
  }, [])

  useEffect(() => {
    window.electronAPI
      .getAgentStatuses()
      .then((reports) => {
        for (const [providerId, report] of Object.entries(reports)) {
          if (isProviderId(providerId) && report) {
            setProviderHealthByProvider((prev) => ({ ...prev, [providerId]: report }))
          }
        }
      })
      .catch(() => undefined)
    return window.electronAPI.onAgentStatusChanged(({ providerId, report }) => {
      setProviderHealthByProvider((prev) => ({ ...prev, [providerId]: report }))
    })
  }, [])

  useEffect(() => {
    window.electronAPI
      .getClientId()
      .then(setCurrentClientId)
      .catch(() => setCurrentClientId(null))
  }, [])

  useEffect(() => {
    window.electronAPI
      .getAgentPromptCapabilities()
      .then(setAcpPromptCapabilitiesByProvider)
      .catch(() => undefined)
  }, [])

  // Agent info is remembered in the composer profile so the settings dialog
  // can label a provider before it has been started this launch: the local
  // store is the fast path, the Convex mirror fills in what it does not have.
  useEffect(() => {
    window.electronAPI
      .getProviderComposerProfiles()
      .then((stored) => {
        setAcpAgentInfoByProvider((current) => {
          const restored = { ...current }
          for (const [providerId, profile] of Object.entries(stored)) {
            if (isProviderId(providerId) && profile?.agentInfo) {
              restored[providerId] = profile.agentInfo
            }
          }
          return restored
        })
      })
      .catch(() => undefined)
  }, [])

  const composerProfileDocs = useTrackedQuery(
    'composer.listProfiles.agent-info',
    (api as any).composer.listProfiles,
    {},
  ) as ProviderComposerProfileDoc[] | undefined

  useEffect(() => {
    if (!composerProfileDocs) return
    const stored = composerProfilesFromDocs(composerProfileDocs)
    setAcpAgentInfoByProvider((current) => {
      let changed = false
      const restored = { ...current }
      for (const [providerId, profile] of Object.entries(stored)) {
        if (isProviderId(providerId) && profile?.agentInfo && !current[providerId]) {
          restored[providerId] = profile.agentInfo
          changed = true
        }
      }
      return changed ? restored : current
    })
  }, [composerProfileDocs])

  useEffect(() => {
    return window.electronAPI.onAcpEvent((event) => {
      if (event.event !== 'initialized') return
      if (event.data.agentInfo) {
        const agentInfo = event.data.agentInfo
        setAcpAgentInfoByProvider((prev) => ({ ...prev, [event.providerId]: agentInfo }))
      }
      if (event.data.promptCapabilities) {
        setAcpPromptCapabilitiesByProvider((prev) => ({
          ...prev,
          [event.providerId]: event.data.promptCapabilities,
        }))
      }
    })
  }, [])

  const value = useMemo<PlatformCapabilitiesValue>(
    () => ({
      providers,
      providerHealthByProvider,
      agentUiStatusByProvider,
      acpAgentInfoByProvider,
      acpPromptCapabilitiesByProvider,
      currentClientId,
      error,
      ensureProvider,
      retryProvider,
      providerDisplayName,
    }),
    [
      providers,
      providerHealthByProvider,
      agentUiStatusByProvider,
      acpAgentInfoByProvider,
      acpPromptCapabilitiesByProvider,
      currentClientId,
      error,
      ensureProvider,
      retryProvider,
      providerDisplayName,
    ],
  )

  return (
    <PlatformCapabilitiesContext.Provider value={value}>
      {children}
    </PlatformCapabilitiesContext.Provider>
  )
}
