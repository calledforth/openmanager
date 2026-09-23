import type { ProviderCapabilities, ProviderId } from '@agentpack/contract'
import type { ExtensionHandlers, SubtaskAdapter } from '../backends/acp/extensions.js'
import type { HostDeps } from '../host.js'
import { claude } from './claude.js'
import { cursor } from './cursor.js'
import { opencode } from './opencode.js'

/** Answers "can this model read an image?" for a batch of model ids, outside
 * any session. `true`/`false` is the provider's word; `null` is "it could not
 * say" for that id, which the composer treats as let-it-through. An id the
 * map does not mention at all is the same as `null`. Implementations own
 * their caching: a runtime builds one lookup per provider and keeps it. */
export type ModelImageInputLookup = (
  modelIds: readonly string[],
) => Promise<ReadonlyMap<string, boolean | null>>

/** The binary an ACP provider is spawned as: the env override, its fallback,
 * then the configured name. One rule for sessions, probes and any out-of-band
 * CLI call, so a developer pointing `ACP_OPENCODE_BIN` at a build gets that
 * build everywhere and never a mix. */
export function acpCommandBin(
  command: Pick<AcpProviderConfig['command'], 'bin' | 'envOverride' | 'fallbackEnvOverride'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env[command.envOverride] ??
    (command.fallbackEnvOverride ? env[command.fallbackEnvOverride] : undefined) ??
    command.bin
  )
}

/** What every provider carries, whatever it is reached over.
 *
 * These three are deliberately the *only* members outside the union arms:
 * `AgentRuntime.require`/`supported`/`getProvider` and the desktop's
 * `agent:providers` handler read them for any provider, and none of them knows
 * or should know how the provider is spoken to. Anything transport-shaped
 * belongs on an arm, where reading it forces a narrow on `kind`. */
export type ProviderConfigBase = {
  id: ProviderId
  displayName: string
  capabilities: ProviderCapabilities
}

/** A provider reached by spawning a CLI that speaks ACP over stdio. */
export type AcpProviderConfig = ProviderConfigBase & {
  kind: 'acp'
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
  }
  extensions: ExtensionHandlers
  subtasks?: SubtaskAdapter
  /** Per-model facts the ACP catalog cannot carry, answered by the provider's
   * own CLI rather than over the wire. Optional: a provider without one
   * reports every model as unknown, and the composer lets images through. */
  models?: {
    /** Built once per runtime, with the binary the runtime resolved, so the
     * lookup's cache lives as long as the runtime and tests get a fresh one. */
    imageInput: (deps: { command: string; log: HostDeps['log'] }) => ModelImageInputLookup
  }
}

/** A provider driven in-process through the Anthropic Agent SDK rather than
 * over ACP.
 *
 * There is no `command`/`auth`/`extensions` here because none of it applies:
 * the SDK owns the transport and the credentials, and there is no JSON-RPC
 * surface for an agent to reach back through. `binary` remains because the SDK
 * still shells out to the Claude Code CLI, and the same env-override escape
 * hatch the ACP providers have is what makes a non-PATH install usable. */
export type ClaudeProviderConfig = ProviderConfigBase & {
  kind: 'claude'
  binary: { bin: string; envOverride: string }
  subtasks?: SubtaskAdapter
}

export type ProviderConfig = AcpProviderConfig | ClaudeProviderConfig

/** Look a provider up and prove it speaks ACP.
 *
 * The ACP factories keep taking the whole `configs` record — they are usable
 * standalone, and the registry hands them nothing but a spec — so the narrow
 * has to happen at the one place that resolves an id to a config. Throwing
 * rather than falling through matters: a non-ACP config reaching the ACP
 * transport would spawn whatever `command` it happened to have. */
export function requireAcpConfig(
  configs: Readonly<Record<ProviderId, ProviderConfig>>,
  providerId: ProviderId,
): AcpProviderConfig {
  const config = configs[providerId]
  if (!config) throw new Error(`Unknown provider: ${providerId}`)
  if (config.kind !== 'acp')
    throw new Error(`Provider ${providerId} is not reached over ACP (kind: ${config.kind})`)
  return config
}

export const providers: Readonly<Record<ProviderId, ProviderConfig>> = { cursor, opencode, claude }
export { claude, cursor, opencode }
