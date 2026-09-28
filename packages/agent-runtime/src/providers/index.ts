import type { ModelListing, ProviderCapabilities, ProviderId } from '@agentpack/contract'
import type { ExtensionHandlers, SubtaskAdapter } from '../backends/acp/extensions.js'
import type { HostDeps } from '../host.js'
import { claude } from './claude.js'
import { cursor } from './cursor.js'
import type { ExecFile } from './opencode-models.js'
import { opencode } from './opencode.js'

/** Answers "can this model read an image?" for a batch of model ids, outside
 * any session. `true`/`false` is the provider's word; `null` is "asked, and
 * it could not say" for that id, which the composer treats as let-it-through
 * and the caller keeps. An id the map does not mention at all is "could not
 * ask right now" (the CLI failed or is being held after a failure): the caller
 * should ask again later. Implementations own their caching: a runtime builds
 * one lookup per provider and keeps it. */
export type ModelImageInputLookup = (
  modelIds: readonly string[],
) => Promise<ReadonlyMap<string, boolean | null>>

/** How a provider names its models to a process that owns no session.
 *
 * ACP itself only lists models on `session/new`, and a session is not a free
 * thing to open for the sake of a question: some agents keep every session
 * they are asked for, prompted or not, and the user would find one more empty
 * chat in the agent's own history each time the catalog was read. So each
 * provider says how it can be asked without leaving anything behind, and one
 * that cannot is simply not asked. */
export type ModelCatalogSource =
  | {
      /** An extension request on the probe's own connection. */
      via: 'extension'
      method: string
      read: (response: unknown) => ModelListing
      /** Whether `session/new` may be spent when the request alone does not
       * answer. Only for an agent known to forget a session nobody prompted. */
      sessionFallback: boolean
      /** Whether `session/new` may be spent to read the modes, which no
       * extension lists. Same condition as `sessionFallback`. */
      modesFromSession?: boolean
    }
  | {
      /** The provider's own CLI, outside ACP altogether. */
      via: 'cli'
      list: (deps: ProviderCliDeps) => Promise<ModelListing>
    }

/** What a provider needs to be asked through its own CLI. */
export type ProviderCliDeps = {
  /** The binary, already resolved through the env override. */
  command: string
  log: HostDeps['log']
  /** How the CLI is run. Absent outside tests, where it is `node:child_process`. */
  execFile?: ExecFile
  /** Where to run it. A provider can be configured per folder, so a question
   * about what it offers is asked where a session would be opened. */
  cwd?: string
  /** Aborted when whoever asked is torn down. The CLI is a child like any
   * other and must not outlive the process that spawned it. */
  signal?: AbortSignal
}

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
  /** What the provider can say about its models outside a session. Both are
   * optional, and independent of each other. */
  models?: {
    /** Per-model facts the ACP catalog cannot carry, answered by the
     * provider's own CLI rather than over the wire. A provider without one
     * reports every model as unknown, and the composer lets images through.
     *
     * Built once per runtime, with the binary the runtime resolved, so the
     * lookup's cache lives as long as the runtime and tests get a fresh one. */
    imageInput?: (deps: ProviderCliDeps) => ModelImageInputLookup
    /** The catalog itself. Without one the provider's models are only known
     * once a session has run, and until then no composer can offer it. */
    catalog?: ModelCatalogSource
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
