import { execFile } from 'node:child_process'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AvailableCommand,
  ModelListing,
  ModelOption,
  ProviderId,
  ProviderSessionInfo,
} from '@agentpack/contract'
import type { BackendEvent, BackendRoute } from '../../backends/Backend.js'
import { CapabilityMissingError } from '../../core/errors.js'
import type { HostDeps } from '../../host.js'
import type { ClaudeProviderConfig } from '../../providers/index.js'
import { DEFAULT_RUNTIME_TIMEOUTS, type RuntimeTimeouts } from '../constants.js'
import type { ThreadId } from '../lifecycle.js'
import type { ProbeResult, ProbeRuntime } from '../ProbeRuntime.js'
import { RpcTimeoutError, withTimeout } from '../timeout.js'
import { routeEvent } from '../wire.js'
import { resolveClaudeExecutable } from './executable.js'
import { loadClaudeSdk, type ClaudeQuerySession, type ClaudeSdk } from './sdk.js'

export type ClaudeProbeSpec = {
  providerId: ProviderId
  cwd: string
  threadId?: ThreadId
  workspaceId?: string
}

export type ClaudeProbeDeps = {
  config: ClaudeProviderConfig
  host: Pick<HostDeps, 'log'>
  timeouts?: Partial<RuntimeTimeouts>
  sdk?: ClaudeSdk
  env?: NodeJS.ProcessEnv
  onEvent?: (event: BackendEvent) => void
  /** `claude --version`, injectable so a test does not have to have the CLI
   * installed to exercise the rest of the probe. */
  version?: (executable: string, timeoutMs: number) => Promise<string | undefined>
}

/** How long `claude --version` gets. It is a local exec that prints one line;
 * anything slower is a broken install, not a slow machine. */
const VERSION_TIMEOUT_MS = 4_000

/** Provider-level questions for Claude Code, answered out of process.
 *
 * The probe deliberately never sends a prompt. `query()` takes an
 * `AsyncIterable` for input, so handing it a generator that yields nothing and
 * simply parks means the CLI starts, initializes, and waits — no turn, no
 * tokens, no cost. `initializationResult()` resolving is the entire answer. */
export class ClaudeProbeRuntime implements ProbeRuntime {
  readonly providerId: ProviderId
  private result: ProbeResult | undefined
  private query: ClaudeQuerySession | undefined
  private readonly timeouts: RuntimeTimeouts

  constructor(
    private readonly spec: ClaudeProbeSpec,
    private readonly deps: ClaudeProbeDeps,
  ) {
    this.providerId = spec.providerId
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
  }

  async probe(): Promise<ProbeResult> {
    if (this.result) return this.result
    // Resolution first, and its failure is an *install* failure that
    // propagates as `ClaudeExecutableNotFoundError`. The health monitor
    // classifies it as "not installed"; reporting `auth_required` instead
    // would send somebody to a login screen for a CLI that is not on their
    // machine, which cannot possibly help.
    const executable = resolveClaudeExecutable(this.deps.config, this.deps.env ?? process.env)
    const version = await (this.deps.version ?? readVersion)(executable, VERSION_TIMEOUT_MS)
    const agentInfo = { name: 'Claude Code', ...(version ? { version } : {}) }
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'process_spawned', {
        cwd: this.spec.cwd,
        command: executable,
        args: ['--version'],
      }),
    )

    const sdk = this.deps.sdk ?? (await loadClaudeSdk())
    const options: Options = {
      cwd: this.spec.cwd,
      pathToClaudeCodeExecutable: executable,
      // A probe must leave nothing behind. Verified against the SDK: with
      // this false the CLI writes no `~/.claude/projects/<project>/<id>.jsonl`
      // for the probe session, so there is nothing to clean up afterwards.
      persistSession: false,
      // Belt and braces. Nothing prompts, so no tool can run — but an empty
      // allowlist means a hook or a settings file cannot make one run either.
      allowedTools: [],
      // Health checking is not the place to surface CLI diagnostics; the
      // session runtime logs its own stderr where it is actionable.
      stderr: () => undefined,
    }
    const query = sdk.query({ prompt: silentInput(), options })
    this.query = query
    // The same `initializeMs` budget the session runtime uses, deliberately:
    // it is the same CLI answering the same handshake, and a probe stricter
    // than the session path would report "unhealthy" for a provider that
    // starts sessions perfectly well. It needs the room — this handshake is a
    // cold subprocess spawn plus credential resolution, measured at 4.6s
    // standalone and over 8s under a loaded test runner, and the health
    // monitor already caps the whole probe at 30s.
    const init = await withTimeout(
      query.initializationResult(),
      this.timeouts.initializeMs,
      () => new RpcTimeoutError(this.providerId, 'initialize', this.timeouts.initializeMs),
    )

    // Initialization succeeding IS the proof of authentication: the CLI does
    // not answer it until credentials resolve. `account` merely says *which*
    // identity — and it is absent on Bedrock, Vertex and raw API-key setups,
    // so gating on it would report every enterprise install as signed out.
    const account = init.account as { email?: string; subscriptionType?: string } | undefined
    const result: ProbeResult = {
      agentInfo,
      authMethods: [],
      authenticated: true,
      sessionListAdvertised: false,
      loadSessionAdvertised: this.deps.config.capabilities.canLoadSession,
      commands: init.commands.map((command): AvailableCommand => ({
        name: command.name,
        description: command.description,
        ...(command.argumentHint
          ? { input: { type: 'unstructured', placeholder: command.argumentHint } }
          : {}),
      })),
    }
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'initialized', {
        agentInfo,
        capabilities: this.deps.config.capabilities,
        authMethods: [],
      }),
    )
    this.deps.host.log({
      scope: 'claude',
      level: 'info',
      message: 'Claude Code probe initialized',
      data: {
        version,
        commands: result.commands?.length ?? 0,
        ...(account?.email ? { account: account.email } : {}),
        ...(account?.subscriptionType ? { subscription: account.subscriptionType } : {}),
      },
    })
    this.result = result
    return result
  }

  listSessions(_cwd: string): Promise<ProviderSessionInfo[]> {
    return Promise.reject(
      new CapabilityMissingError(this.providerId, 'canListSessions', 'listing sessions'),
    )
  }

  /** A static catalog, gated on the CLI version.
   *
   * The SDK does expose a live list (`initialize` carries `models`, and
   * `Query.supportedModels()` re-reads it), but every path to it costs a
   * subprocess spawn, and the health monitor asks for models on a schedule.
   * A hand-maintained list is the honest trade for now: it is small, it is
   * obviously editable, and the version gate is what stops it from offering a
   * model an older CLI would reject. Deleting this in favour of `init.models`
   * is a one-line change once the probe result is cached across calls. */
  async listModels(_cwd: string): Promise<ModelListing> {
    const result = await this.probe()
    return { availableModels: modelCatalog(result.agentInfo?.version) }
  }

  async dispose(): Promise<void> {
    const query = this.query
    this.query = undefined
    if (!query) return
    query.close()
    // Same bounded best-effort as the session runtime: `return()` awaits the
    // SDK's memoised cleanup, which ends with its own capped wait on the
    // child. A probe that resolved before its subprocess died would let the
    // health monitor's one-slot queue start the next provider's probe while
    // this one still holds a CLI.
    await query.return(undefined).catch(() => undefined)
  }

  private route(): BackendRoute {
    return {
      threadId: this.spec.threadId ?? `provider-probe:${this.providerId}`,
      ...(this.spec.workspaceId ? { workspaceId: this.spec.workspaceId } : {}),
    }
  }
  private emit(event: BackendEvent): void {
    this.deps.onEvent?.(event)
  }
}

/** An input stream that never yields and never ends.
 *
 * This is what makes the probe free. `query()` starts the subprocess and runs
 * `initialize` regardless of whether input arrives, so parking forever gives a
 * complete handshake with no turn behind it. `dispose()` tears the process
 * down; the generator is never resumed. */
async function* silentInput(): AsyncGenerator<SDKUserMessage> {
  await new Promise<never>(() => undefined)
}

function readVersion(executable: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    // `shell: false` on purpose: the path is already fully resolved, including
    // its Windows extension, so there is nothing for a shell to look up and
    // nothing for it to mis-quote.
    execFile(
      executable,
      ['--version'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        // "2.1.220 (Claude Code)" -> "2.1.220"
        resolve(/\d+\.\d+\.\d+[^\s]*/.exec(stdout)?.[0] ?? (stdout.trim() || undefined))
      },
    )
  })
}

/** Deliberately short and deliberately hand-written. Add a row when a model
 * ships; the `minVersion` is the CLI release that first accepted the id. */
const MODELS: readonly (ModelOption & { minVersion?: string })[] = [
  { id: 'default', displayName: 'Default', description: 'Whatever the CLI is configured to use' },
  { id: 'opus', displayName: 'Opus', description: 'Most capable' },
  { id: 'sonnet', displayName: 'Sonnet', description: 'Balanced capability and speed' },
  { id: 'haiku', displayName: 'Haiku', description: 'Fastest' },
]

function modelCatalog(version: string | undefined): ModelOption[] {
  return MODELS.filter((model) => !model.minVersion || atLeast(version, model.minVersion)).map(
    ({ minVersion: _minVersion, ...model }) => model,
  )
}

/** Absent version -> assume new enough. A probe that could not read
 * `--version` has bigger problems than an over-generous model list, and
 * hiding every model would look like an empty account. */
function atLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return true
  const parse = (value: string): number[] =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [a, b] = [parse(version), parse(minimum)]
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}
