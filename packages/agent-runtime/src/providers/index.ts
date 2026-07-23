import type { ProviderCapabilities, ProviderId } from '@agentpack/contract'
import type { ExtensionHandlers, SubtaskAdapter } from '../backends/acp/extensions.js'
import { cursor } from './cursor.js'
import { opencode } from './opencode.js'

export type ProviderConfig = {
  id: ProviderId
  displayName: string
  command: {
    bin: string
    args: string[]
    envOverride: string
    fallbackEnvOverride?: string
    env?: Record<string, string>
  }
  auth: { methodHints: string[]; tolerateAuthenticateFailure: boolean; loginInstruction: string }
  quirks: {
    suppressPlanUpdates?: boolean
    nativeQuestions?: 'opencode'
    correlateSessionlessExtensionsToActivePrompt?: boolean
  }
  capabilities: ProviderCapabilities
  extensions: ExtensionHandlers
  subtasks?: SubtaskAdapter
}
export const providers: Readonly<Record<ProviderId, ProviderConfig>> = { cursor, opencode }
export { cursor, opencode }
