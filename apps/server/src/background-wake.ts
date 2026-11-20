import { providers, type ProviderConfig } from '@agentpack/runtime/node'

/**
 * Whether a session's background tasks wake its agent when they end
 * (`backgroundTasksWakeAgent`). While such tasks run, a completed turn is not
 * done news: the turn that reports their result is. Background work that
 * just runs on (Codex's background terminals) holds nothing back. Read from
 * the provider's static config, so the SQLite projection and the in-memory
 * record agree, and a replay gives the same answer.
 */
export function backgroundTasksWakeAgent(providerId: string): boolean {
  const config = (providers as Record<string, ProviderConfig | undefined>)[providerId]
  return config?.capabilities.backgroundTasksWakeAgent === true
}
