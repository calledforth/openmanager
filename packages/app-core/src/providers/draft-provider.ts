import { isProviderId, type ProviderId } from '@agentpack/contract'
import {
  selectProviderCatalog,
  type EnvironmentState,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'
import { providerBlocksComposer, type ProviderUiStatus } from './platform-provider'

/** Each provider's health as the composer reads it; absent is unknown. */
export type ProviderStatuses = Partial<Record<ProviderId, ProviderUiStatus>>

/**
 * The provider a draft in this workspace starts with: the pick when it can
 * still be made, otherwise the first provider the workspace offers that is not
 * known to be broken. An environment that lists no providers keeps the pick.
 */
export function draftProviderFor(
  picked: ProviderId,
  catalog: readonly ProviderCatalogEntry[],
  offered: readonly string[] | undefined,
  statuses: ProviderStatuses,
): ProviderId {
  const candidates = catalog
    .map((entry) => entry.id)
    .filter(isProviderId)
    .filter((id) => !offered?.length || offered.includes(id))
  if (candidates.length === 0 || candidates.includes(picked)) return picked
  return candidates.find((id) => !providerBlocksComposer(statuses[id])) ?? candidates[0]!
}

/**
 * The provider this workspace last ran: that of its most recently active
 * top-level session. The environment keeps preferences per provider and none
 * for the provider itself, so the sessions are the record, for every client.
 * Kept per sessions object, so reading it on every keystroke costs one lookup.
 */
const lastProviders = new WeakMap<EnvironmentState['sessions'], Map<string, ProviderId>>()
export function lastProviderIn(
  state: EnvironmentState,
  workspaceId: string | null,
): ProviderId | undefined {
  if (!workspaceId) return undefined
  let byWorkspace = lastProviders.get(state.sessions)
  if (!byWorkspace) {
    const newest = new Map<string, { at: string; providerId: ProviderId }>()
    for (const session of Object.values(state.sessions)) {
      if (!session || session.parentSessionId || !isProviderId(session.providerId)) continue
      const at = session.updatedAt ?? ''
      const best = newest.get(session.workspaceId)
      if (!best || at > best.at) {
        newest.set(session.workspaceId, { at, providerId: session.providerId })
      }
    }
    byWorkspace = new Map([...newest].map(([id, { providerId }]) => [id, providerId]))
    lastProviders.set(state.sessions, byWorkspace)
  }
  return byWorkspace.get(workspaceId)
}

/**
 * The provider a new-session draft runs with, and so the one its sidebar card
 * names: its own pick, else the workspace's last-run provider, else the
 * default; and of those, only one the workspace still offers (see
 * `draftProviderFor`). The draft's composer and its card both read this, so
 * the two never name different providers.
 */
export function resolveDraftProvider(
  state: EnvironmentState,
  {
    picked,
    workspaceId,
    defaultProviderId,
    statuses,
    catalog = selectProviderCatalog(state),
  }: {
    picked: ProviderId | undefined
    workspaceId: string | null
    defaultProviderId: ProviderId
    statuses: ProviderStatuses
    catalog?: readonly ProviderCatalogEntry[]
  },
): ProviderId {
  return draftProviderFor(
    picked ?? lastProviderIn(state, workspaceId) ?? defaultProviderId,
    catalog,
    workspaceId ? state.workspaces[workspaceId]?.capabilities.providers : undefined,
    statuses,
  )
}
