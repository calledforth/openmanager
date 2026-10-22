import {
  describeProviderHealth,
  type PlatformCapabilitiesValue,
  type ProviderHealthPresentation,
} from '@openmanager/app-core/logic'

/**
 * Each provider of the connected environment as Settings lists it: its
 * health in the shared words (`describeProviderHealth`, the same copy web's
 * Providers panel and the desktop menu use) and whether a re-check makes
 * sense. The phone shows a provider by its mark, never its name; the name is
 * kept for the screen reader.
 */
export type ProviderHealthRow = {
  providerId: string
  /** For the screen reader only. */
  name: string
  health: ProviderHealthPresentation
}

export function providerHealthRows(
  platform: Pick<
    PlatformCapabilitiesValue,
    'providers' | 'providerHealthByProvider' | 'agentUiStatusByProvider' | 'acpAgentInfoByProvider'
  >,
  now: number,
): ProviderHealthRow[] {
  return platform.providers.map((provider) => {
    const health = describeProviderHealth(platform.providerHealthByProvider[provider.id], now)
    // A probe this phone just asked for reads as checking straight away.
    const checking = platform.agentUiStatusByProvider[provider.id] === 'probing'
    const agentInfo = platform.acpAgentInfoByProvider[provider.id]
    return {
      providerId: provider.id,
      name: agentInfo?.name
        ? `${agentInfo.name}${agentInfo.version ? ` ${agentInfo.version}` : ''}`
        : provider.displayName,
      health: checking
        ? { ...health, label: 'Checking…', tone: 'muted' as const, canRetry: false }
        : health,
    }
  })
}
