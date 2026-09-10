import { createContext, useContext } from 'react'
import type { ProviderId, ProviderMetadata, PromptCapabilities } from '@agentpack/contract'
import type {
  ProviderHealthReport,
  ProviderUiStatus,
} from '@openmanager/shared/contracts/provider-health'

export type { ProviderUiStatus }

/** What an agent provider reported about itself during the ACP handshake. */
export type AgentInfo = { name?: string; version?: string }

/** Whether a provider's health should stop the composer offering to send.
 *
 * Only a positively-known failure does. "We have not checked yet" must not:
 * at launch only one provider is started, so treating unknown as broken is
 * what made a perfectly good provider read as unavailable. `ensureProvider`
 * still runs before a send and surfaces a real failure then. */
export function providerBlocksComposer(status: ProviderUiStatus | undefined): boolean {
  return (
    status === 'probing' ||
    status === 'auth_required' ||
    status === 'binary_missing' ||
    status === 'failed'
  )
}

/** Share one in-flight startup per provider so concurrent callers (a draft
 * being opened while a retry is clicked) do not spawn two processes. Once the
 * attempt settles the slot is cleared so a later retry can start afresh. */
export function coordinateProviderConnection(
  connections: Map<ProviderId, Promise<boolean>>,
  providerId: ProviderId,
  start: () => Promise<boolean>,
): Promise<boolean> {
  const existing = connections.get(providerId)
  if (existing) return existing
  const connection = start()
  connections.set(providerId, connection)
  const cleanup = () => {
    if (connections.get(providerId) === connection) connections.delete(providerId)
  }
  void connection.then(cleanup, cleanup)
  return connection
}

/**
 * Platform capabilities: which agent providers exist on this host, whether
 * they are healthy, what they reported in their handshake, and who this client
 * is. Nothing here depends on a workspace or a session.
 */
export interface PlatformCapabilitiesValue {
  /** Registered providers with their metadata (display name, model catalog). */
  providers: ProviderMetadata[]
  /** Latest health snapshot pushed by the host for each provider. */
  providerHealthByProvider: Partial<Record<ProviderId, ProviderHealthReport>>
  /** Health folded into a single status the UI can act on, with a local
   * `probing` bridge while a connection attempt is in flight. */
  agentUiStatusByProvider: Partial<Record<ProviderId, ProviderUiStatus>>
  /** Name/version each provider announced in its `initialized` handshake. */
  acpAgentInfoByProvider: Partial<Record<ProviderId, AgentInfo>>
  /** Prompt capabilities (image support, etc.) per provider. */
  acpPromptCapabilitiesByProvider: Partial<Record<ProviderId, PromptCapabilities>>
  /** Stable identity of this client, used to mark sessions it drives. */
  currentClientId: string | null
  /** Last failure from a platform operation (a retry that did not connect). */
  error: string | null
  /** Start (or reuse the in-flight start of) a provider in `cwd`. Resolves
   * to whether the provider is ready to take prompts. */
  ensureProvider: (providerId: ProviderId, cwd: string) => Promise<boolean>
  /** User-initiated reconnect. `cwd` defaults to the host's notion of the
   * current workspace; callers with one should pass it. */
  retryProvider: (providerId: ProviderId, cwd?: string) => Promise<void>
  /** Human-readable name for a provider, falling back to its id. */
  providerDisplayName: (providerId: ProviderId) => string
}

export const PlatformCapabilitiesContext = createContext<PlatformCapabilitiesValue | null>(null)

export function usePlatformCapabilities(): PlatformCapabilitiesValue {
  const ctx = useContext(PlatformCapabilitiesContext)
  if (!ctx) {
    throw new Error('usePlatformCapabilities must be used within PlatformCapabilitiesProvider')
  }
  return ctx
}
