import type { ProviderId } from '@agentpack/contract'

/**
 * Every tool with a mark: the session providers, and Codex, which the
 * environment runs only to write session titles for now.
 */
export type ProviderIconId = ProviderId | 'codex'
