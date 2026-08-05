import { execFile } from 'node:child_process'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AvailableCommand,
  ModelListing,
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
import { claudeModeListing, claudeModelCatalog } from './claude-catalog.js'
import { CLAUDE_PROMPT_CAPABILITIES } from './claude-prompt.js'
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
      promptCapabilities: CLAUDE_PROMPT_CAPABILITIES,
      commands: init.commands.map((command): AvailableCommand => ({
        name: command.name,
        description: command.description,
        ...(command.argumentHint
          ? { input: { type: 'unstructured', placeholder: command.argumentHint } }
          : {}),
      })),
      // The catalog comes out of the handshake we were already paying for, so
      // the composer can offer Claude models before anybody has run a Claude
      // session. `resolvedModel` is deliberately dropped: it exists so a host
      // can match a persisted wire id (`claude-sonnet-5`) back to the alias
      // row that covers it (`sonnet`), and nothing in openmanager ever learns
      // a wire id — the only Claude model ids it stores are ones this list
      // handed the picker. Carry it through the day something else does.
      models: { availableModels: claudeModelCatalog(init.models) },
      // Static, unlike `models` — the CLI has no handshake field for modes.
      // Reported from the probe anyway so the composer's mode picker renders
      // on the same terms as its model picker: before the first session, for a
      // provider nobody has selected yet. Without this the control never
      // appears, because it is gated on a non-empty list and the only other
      // source is a live session's own state.
      modes: claudeModeListing(),
    }
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'initialized', {
        agentInfo,
        capabilities: this.deps.config.capabilities,
        promptCapabilities: CLAUDE_PROMPT_CAPABILITIES,
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
        models: result.models?.availableModels?.length ?? 0,
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

  /** The handshake's own list, free: `probe()` is memoised, so asking twice
   * costs one CLI. Nothing hand-maintained survives here — a list this file
   * guessed at would go stale silently and could offer a model the installed
   * CLI rejects, whereas the CLI answering `initialize` cannot be wrong about
   * what it accepts. */
  async listModels(_cwd: string): Promise<ModelListing> {
    const result = await this.probe()
    return result.models ?? {}
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

