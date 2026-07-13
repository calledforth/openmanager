import type { ProviderCapabilities, ProviderId } from '@agentpack/contract'
import type { ExtensionHandlers } from '../backends/acp/extensions.js'
import { opencode } from './opencode.js'

export type ProviderConfig = {
  id: ProviderId
  displayName: string
  command: { bin: string; args: string[]; envOverride: string; fallbackEnvOverride?: string }
  auth: { methodHints: string[]; tolerateAuthenticateFailure: boolean; loginInstruction: string }
  quirks: { suppressPlanUpdates?: boolean }
  capabilities: ProviderCapabilities
  extensions: ExtensionHandlers
}
export const providers: Readonly<Record<ProviderId, ProviderConfig>> = { opencode }
export { opencode }
