import type {
  AgentEvent,
  AvailableCommand,
  CapabilityKey,
  ModeListing,
  ModelListing,
  PermissionOutcome,
  PlanReviewOutcome,
  PromptInput,
  ProviderId,
  ProviderSessionInfo,
  QuestionOutcome,
} from '@agentpack/contract'
import { isRecoverableError } from '@agentpack/contract'
import type { BackendEvent, SessionResult } from '../backends/Backend.js'
import type { HostDeps } from '../host.js'
import { providers, type ProviderConfig } from '../providers/index.js'
import type { AcpConnectionFactory } from '../session/AcpConnection.js'
import type { ClaudeSdk } from '../session/claude/sdk.js'
import type { ProbeResult, ProbeRuntime, ProbeRuntimeFactory } from '../session/ProbeRuntime.js'
import {
  ProviderProbeRuntimeFactory,
  ProviderSessionRuntimeFactory,
} from '../session/ProviderRuntimeFactory.js'
import { ChildProcessConnectionFactory } from '../session/ChildProcessConnection.js'
import { SHUTDOWN_BUDGET_MS, type RuntimeTimeouts } from '../session/constants.js'
import type { DesiredSessionConfig, SessionResumeRecord } from '../session/lifecycle.js'
import { withTimeout } from '../session/timeout.js'
import { SessionRuntimeRegistryImpl } from '../session/SessionRuntimeRegistryImpl.js'
import type { SessionRuntimeEntry } from '../session/SessionRuntimeRegistry.js'
import { isRuntimeAlive } from '../session/lifecycle.js'
import { InteractionBroker, type InteractionSettlement } from './InteractionBroker.js'
import { PermissionBroker } from './PermissionBroker.js'
import { CapabilityMissingError } from './errors.js'
import {
  ProviderHealthMonitor,
  type ProviderHealthMonitorDeps,
  type ProviderRuntimeCensus,
} from './ProviderHealthMonitor.js'
import { SessionReaper, type SessionReaperDeps } from './SessionReaper.js'

export type RuntimeRoute = {
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  cwd: string
}
/** A provider's model catalog plus the agent build that produced it.
 *
 * The version travels *with* the catalog rather than beside it because it is
 * the only thing that makes the catalog safe to persist — see
 * `AgentRuntime.catalogVersions`. A host that stored the models and dropped
 * the version would have a cache it could never safely invalidate. */
export type ProviderCatalogSnapshot = {
  models: ModelListing
  /** Carried alongside the models because the composer renders one row: a
   * restored model picker beside a mode picker that is still waiting on an IPC
   * is the same layout shift, just narrower. */
  modes?: ModeListing
  agentVersion?: string
}

/** What a provider bootstrap learned, from one throwaway process. */
export type ProviderBootstrap = {
  result: ProbeResult
  /** The provider's sessions for this directory, or `undefined` when the agent
   * does not advertise `session/list` at all — which is not the same as `[]`,
   * "it listed and there are none". */
  sessions: ProviderSessionInfo[] | undefined
  /** Slash commands the probe could answer without a session, hoisted out of
   * `result` alongside `sessions` because it is the same kind of fact: what
   * the bootstrap process learned about the provider before any thread exists.
   * `undefined` over ACP, where the catalog only arrives on a live session. */
  commands: AvailableCommand[] | undefined
  /** Model catalog the probe could answer without a session, hoisted for the
   * same reason as `commands`. `undefined` over ACP. */
  models: ModelListing | undefined
  /** Mode catalog the probe could answer without a session, hoisted for the
   * same reason as `commands` and `models`. `undefined` over ACP. */
  modes: ModeListing | undefined
}

export type RuntimeSessionArgs = RuntimeRoute & {
  sessionId?: string
  resumeCursor?: string
  /** Durable user intent (the workspace's remembered model/mode/config values
   * plus any per-job override). Reconciled against the runtime's applied-state
   * cache on every `ensureSession`, which costs zero RPCs when nothing has
   * changed — that is what replaces the per-message preamble. */
  desiredConfig?: DesiredSessionConfig
}

/** `SessionResumeRecord` minus the fields the map key and the caller's args
 * already carry, and minus `desiredConfig`.
 *
 * `desiredConfig` is absent on purpose. It is durable user intent, owned and
 * persisted by the host per workspace + provider; a per-thread copy here was a
 * second source of truth that went stale the moment `setModel` changed the
 * selection without telling this map, and a respawn then re-applied the model
 * the user had just moved away from. `HostDeps.desiredSessionConfig` is asked
 * instead, at the moment a runtime is opened. Everything that remains here is
 * an optimisation over the durable session id, not a requirement of resuming. */
type ThreadResume = Omit<SessionResumeRecord, 'threadId' | 'sessionId' | 'desiredConfig'> & {
  sessionId: string | undefined
}

/** Thread ids the desktop uses for provider-level work that has no session:
 * `desktop-bootstrap:*` for the launch handshake, `session-metadata:*` for
 * title refreshes. Invariant 13 — they must never create a session runtime,
 * because a runtime means a ~230 MB CLI bound to an ACP session that nobody
 * will ever prompt or reap on purpose. Those callers use probe runtimes. */
const PSEUDO_THREAD_PREFIXES = ['desktop-bootstrap:', 'session-metadata:'] as const

export function isPseudoThreadId(threadId: string): boolean {
  return PSEUDO_THREAD_PREFIXES.some((prefix) => threadId.startsWith(prefix))
}

export type AgentRuntimeOptions = {
  /** Transport seam. Defaults to spawning the provider's CLI; tests inject a
   * fake so runtimes can be exercised without one. */
  connections?: AcpConnectionFactory
  /** The same seam for the Claude arm, which spawns its CLI through the SDK
   * rather than through `connections`. Tests inject `FakeClaudeSdk`. */
  claudeSdk?: ClaudeSdk
  timeouts?: Partial<RuntimeTimeouts>
  /** Overrides for the health monitor's cadence, probe budget and clock. */
  health?: Pick<
    ProviderHealthMonitorDeps,
    'refreshIntervalMs' | 'probeTimeoutMs' | 'now' | 'schedule'
  >
  /** Overrides for the idle reaper's thresholds and timer. */
  reaper?: Pick<SessionReaperDeps, 'idleMs' | 'sweepMs' | 'schedule'>
  /** Soft LRU ceiling on live session runtimes. Defaults to
   * `MAX_SESSION_RUNTIMES`; `0` disables eviction. */
  maxRuntimes?: number
}

/** Owns the registry of per-thread session runtimes, the two app-wide brokers,
 * and event sequencing.
 *
 * There is no longer one backend per provider: a thread gets its own child
 * process, so two threads on the same provider cannot see each other's model,
 * config or extension traffic. */
export class AgentRuntime {
  /** Continuously-refreshed provider health. Public so the desktop host can
   * read snapshots, subscribe, hydrate the boot cache and force a refresh. */
  readonly health: ProviderHealthMonitor
  /** Idle reaper. Public so a caller can drive a sweep deterministically. */
  readonly reaper: SessionReaper
  private readonly registry: SessionRuntimeRegistryImpl
  /** What it takes to rebuild a thread's runtime after its process is gone.
   *
   * In memory only, by design (§9). The durable anchor is the ACP session id,
   * which is already persisted as the Convex `sessions.externalId` and arrives
   * back on the args of every job that names a session — so a respawn works
   * across an app restart with no new persistence at all. Everything held here
   * is an optimisation on top of that: the `resumeCursor` (best effort; losing
   * it costs a transcript replay, which is what the 90s `loadSessionMs` budget
   * is for) and the last desired config, so a respawned process is configured
   * the same way a cold start would be rather than inheriting Cursor's stale
   * on-disk state. */
  private readonly resumes = new Map<string, ThreadResume>()
  /** Last directory each provider was actually used in, so a health probe can
   * be spawned somewhere real. Never defaulted to the Electron cwd. */
  private readonly lastCwdByProvider = new Map<ProviderId, string>()
  private defaultProbeCwd: string | undefined
  private readonly sequences = new Map<string, number>()
  private readonly threadProviders = new Map<string, ProviderId>()
  private readonly promptQueues = new Map<string, Promise<void>>()
  private readonly activeMessageIds = new Map<string, string>()
  private readonly configs: Readonly<Record<ProviderId, ProviderConfig>>
  /** The ACP transport. Seeded by `options.connections` in tests and otherwise
   * built on first use — see `acpConnections`. */
  private connectionsValue: AcpConnectionFactory | undefined
  /** Every probe this runtime builds, live or throwaway, comes from here.
   * Shared with the health monitor so both go through the same dispatch. */
  private readonly probes: ProbeRuntimeFactory
  /** Last model catalog each provider reported at handshake time.
   *
   * Fed by every probe, which is the point: the desktop only bootstraps the
   * provider the user is about to talk to, while the health monitor probes
   * *all* of them at boot. A catalog learned there is what lets the composer
   * list a provider nobody has selected yet. Providers whose models only
   * exist on a live session (every ACP one) never appear in this map. */
  private readonly modelsByProvider = new Map<ProviderId, ModelListing>()
  /** Last mode catalog each provider reported at handshake time. Same
   * lifecycle and same justification as `modelsByProvider` — a composer that
   * can offer a never-selected provider's models but not its modes renders a
   * model picker beside a missing mode picker. */
  private readonly modesByProvider = new Map<ProviderId, ModeListing>()
  /** Agent version that produced each entry in `modelsByProvider`.
   *
   * The freshness key for the persisted catalog, and the reason that cache can
   * be trusted at all. A catalog is a statement about one build of one CLI: it
   * lists the models that build accepts, and after an upgrade it may name a
   * model the new binary rejects or omit one it gained. Timestamps cannot see
   * that — an upgrade makes a cache wrong instantly, and a week-old cache on an
   * unchanged CLI is still perfectly right. So the version is what gates
   * rediscovery, and a probe reporting a different one discards the entry.
   *
   * Undefined for an agent that reports no version, which is treated as "never
   * matches": rediscovering costs one ext call, while trusting an unversioned
   * catalog across an upgrade costs the user a model that errors on use. */
  private readonly catalogVersions = new Map<ProviderId, string | undefined>()
  /** Providers whose catalog was read from a live probe *in this process*.
   *
   * Separate from `catalogVersions` because they answer different questions.
   * The version says whether a catalog restored from disk still describes the
   * installed binary; this says whether we have already spent the round trip
   * this run. Without it, an agent that reports no version at all would be
   * re-asked on every health tick forever, since there is no version to match. */
  private readonly catalogsDiscovered = new Set<ProviderId>()
  private readonly timeouts: Partial<RuntimeTimeouts> | undefined
  /** App-wide and keyed by requestId. Every pending record carries its own
   * provider/thread/workspace/session, so responding needs no lookup table and
   * a dying runtime settles only its own thread's requests. */
  private readonly permissions: PermissionBroker
  private readonly interactions: InteractionBroker

  constructor(
    private readonly host: HostDeps,
    configs: Readonly<Record<ProviderId, ProviderConfig>> = providers,
    options: AgentRuntimeOptions = {},
  ) {
    this.configs = configs
    this.connectionsValue = options.connections
    this.timeouts = options.timeouts
    this.permissions = new PermissionBroker((settlement) =>
      this.forward(settlement.providerId, {
        threadId: settlement.threadId,
        workspaceId: settlement.workspaceId,
        sessionId: settlement.sessionId,
        category: 'permission',
        event: 'permission_resolved',
        data: { requestId: settlement.requestId, outcome: settlement.outcome },
      } as BackendEvent),
    )
    this.interactions = new InteractionBroker((settlement) =>
      this.forward(settlement.providerId, this.interactionResolved(settlement)),
    )
    this.registry = new SessionRuntimeRegistryImpl({
      runtimes: new ProviderSessionRuntimeFactory({
        configs,
        host,
        permissions: this.permissions,
        interactions: this.interactions,
        connections: () => this.acpConnections(),
        ...(options.claudeSdk ? { claudeSdk: options.claudeSdk } : {}),
        ...(options.timeouts ? { timeouts: options.timeouts } : {}),
      }),
      onEvent: (providerId, event) => this.forward(providerId, event),
      log: host.log,
      ...(options.maxRuntimes !== undefined ? { limit: options.maxRuntimes } : {}),
    })
    this.reaper = new SessionReaper({
      registry: this.registry,
      log: host.log,
      ...(options.reaper ?? {}),
    })
    // Decorated, not subclassed, so *every* probe result is observed exactly
    // once no matter who asked for it — the bootstrap, the health loop, or a
    // metadata refresh. Recording the catalog anywhere further downstream
    // would miss the health monitor's probes, which are the only ones a
    // provider the user has never selected ever gets.
    const probes = new ProviderProbeRuntimeFactory({
      configs,
      host,
      connections: () => this.acpConnections(),
      ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    })
    this.probes = {
      create: (providerId, cwd, probeOptions) => {
        const probe = probes.create(providerId, cwd, probeOptions)
        return {
          providerId: probe.providerId,
          probe: async () => {
            const result = await probe.probe()
            // A handshake that carries catalogs (Claude) is as much a live
            // confirmation as the ext call is, and has to mark the provider
            // discovered for the same reason: otherwise its catalog is never
            // persisted, and every launch starts the composer empty for it.
            if (result.models) {
              this.modelsByProvider.set(providerId, result.models)
              this.catalogVersions.set(providerId, result.agentInfo?.version)
              this.catalogsDiscovered.add(providerId)
            }
            if (result.modes) this.modesByProvider.set(providerId, result.modes)
            await this.adoptCatalog(providerId, cwd, probe, result)
            return result
          },
          listSessions: (dir) => probe.listSessions(dir),
          listModels: (dir) => probe.listModels(dir),
          dispose: () => probe.dispose(),
        }
      },
    }
    this.health = new ProviderHealthMonitor({
      providerIds: Object.keys(configs) as ProviderId[],
      probes: this.probes,
      census: (providerId) => this.census(providerId),
      probeCwd: (providerId) => this.lastCwdByProvider.get(providerId) ?? this.defaultProbeCwd,
      host,
      ...(options.health ?? {}),
    })
    // Provider health is a rollup over *all* this provider's runtimes plus its
    // probes. One session's process exiting is one input to that rollup, never
    // the whole answer — three healthy sessions are not "stopped" because a
    // fourth died.
    this.registry.onRuntimeExit((entry, exit) => {
      this.health.observeRuntimeExit(entry.providerId, entry.threadId, exit)
      // The dying runtime's last cursor is the only place it survives, and it
      // is exactly what a respawn wants. Recorded whether the death was a
      // reap, an eviction or a crash.
      const resume = this.resumes.get(entry.threadId)
      if (resume && exit.resumeCursor) resume.resumeCursor = exit.resumeCursor
    })
    this.reaper.start()
  }

  /** The child-process transport, built at most once and only when an ACP
   * provider actually needs it.
   *
   * It used to be constructed unconditionally in the constructor, which quietly
   * made "spawns a CLI" a property of the runtime rather than of the provider.
   * Nothing observable changes for the two ACP providers — the first runtime or
   * probe builds it, and every later one shares it. */
  private acpConnections(): AcpConnectionFactory {
    this.connectionsValue ??= new ChildProcessConnectionFactory(this.host.log)
    return this.connectionsValue
  }

  /** Fallback directory for health probes of providers the user has not used
   * yet — the last workspace they had open. Without it those providers stay
   * `'unknown'`, which is correct but uninformative. */
  setDefaultProbeCwd(cwd: string | undefined): void {
    this.defaultProbeCwd = cwd && cwd.length > 0 ? cwd : undefined
  }

  private census(providerId: ProviderId): ProviderRuntimeCensus {
    let liveProcesses = 0
    let readyProcesses = 0
    let activeTurns = 0
    for (const entry of this.registry.forProvider(providerId)) {
      if (!isRuntimeAlive(entry.runtime.phase)) continue
      liveProcesses += 1
      if (entry.runtime.phase === 'ready') readyProcesses += 1
      if (entry.activeTurn !== null) activeTurns += 1
    }
    return { liveProcesses, readyProcesses, activeTurns }
  }

  getProvider(providerId: ProviderId): ProviderConfig {
    return this.configs[providerId]
  }

  private bindProvider(threadId: string, providerId: ProviderId): void {
    const current = this.threadProviders.get(threadId)
    if (current && current !== providerId)
      throw new Error(`Thread ${threadId} is already bound to provider ${current}`)
    this.threadProviders.set(threadId, providerId)
  }
  /** Every wire response from any process for this provider — live session or
   * throwaway probe — is an observation of the same CLI a health probe would
   * spawn. Harvesting them here is what lets the monitor skip most probes:
   * an active session already proves install, auth and the model catalog. */
  private observeHealth(providerId: ProviderId, event: AgentEvent): void {
    switch (event.event) {
      case 'initialized':
        this.health.observeInitialized(providerId, event.data.agentInfo?.version)
        return
      case 'authenticated':
        this.health.observeAuthenticated(providerId, event.data.methodId)
        return
      case 'auth_required':
        this.health.observeAuthRequired(providerId, event.data.message, event.data.loginHint)
        return
      case 'session_created':
      case 'session_loaded':
        this.health.observeModels(providerId, event.data.models)
        return
      default:
        return
    }
  }

  /** Which resolution event a settled interaction becomes.
   *
   * Questions and plan reviews get their own events rather than riding
   * `extension_resolved`, which is what every consumer used to clear their
   * pending rows on. That only ever worked for providers whose questions and
   * plans arrive over ACP's `_ext` methods; a provider raising the same
   * interactions from an SDK callback would answer correctly and then leave the
   * row pending forever in the host map, in Convex and on mobile. The kind
   * travels on the pending record, so the transport no longer decides. */
  private interactionResolved(settlement: InteractionSettlement): BackendEvent {
    const route = {
      threadId: settlement.threadId,
      workspaceId: settlement.workspaceId,
      sessionId: settlement.sessionId,
    }
    const resolution = settlement.resolution
    if (resolution?.kind === 'question') {
      return {
        ...route,
        category: 'session',
        event: 'question_resolved',
        data: { requestId: settlement.requestId, outcome: resolution.outcome },
      } as BackendEvent
    }
    if (resolution?.kind === 'plan_review') {
      return {
        ...route,
        category: 'session',
        event: 'plan_review_resolved',
        data: { requestId: settlement.requestId, outcome: resolution.outcome },
      } as BackendEvent
    }
    return {
      ...route,
      category: 'extension',
      event: 'extension_resolved',
      data: {
        requestId: settlement.requestId,
        method: settlement.method,
        outcome: settlement.outcome,
      },
    } as BackendEvent
  }

  private forward(providerId: ProviderId, event: BackendEvent): void {
    const seq = (this.sequences.get(event.threadId) ?? 0) + 1
    this.sequences.set(event.threadId, seq)
    const id = crypto.randomUUID()
    if (event.event === 'prompt_started') {
      this.activeMessageIds.set(event.threadId, `agent_asst_${id}`)
    }
    const messageId = this.activeMessageIds.get(event.threadId)
    // `BackendEvent` is `Omit<AgentEvent, …>`, which collapses the union into
    // one merged object type, so its `data` cannot be narrowed by `event`.
    // The stamped event is the real discriminated union again.
    const stamped = {
      ...event,
      id,
      ...(messageId ? { messageId } : {}),
      timestamp: new Date().toISOString(),
      seq,
      providerId,
    } as AgentEvent
    this.observeHealth(providerId, stamped)
    this.host.emitEvent(stamped)
    if (
      event.event === 'prompt_completed' ||
      event.event === 'process_exited' ||
      // A recoverable error is a retry notice, not the end of the turn. Letting
      // it release the message id would leave every later event in the turn —
      // the assistant text that the retry then succeeds in producing, the tool
      // rows, the `prompt_completed` itself — carrying no `messageId`, and both
      // the projector and the live renderer drop those. The answer is truncated
      // in the UI and, worse, in the persisted `messages.metadata.parts`.
      ((event.event === 'rpc_error' || event.event === 'runtime_error') &&
        !isRecoverableError(event))
    ) {
      this.activeMessageIds.delete(event.threadId)
    }
  }
  private missing(args: RuntimeRoute, capability: CapabilityKey, operation: string): never {
    const error = new CapabilityMissingError(args.providerId, capability, operation)
    this.forward(args.providerId, {
      threadId: args.threadId,
      workspaceId: args.workspaceId,
      category: 'error',
      event: 'capability_missing',
      data: { capability, operation, message: error.message },
    })
    throw error
  }
  private require(args: RuntimeRoute, capability: CapabilityKey, operation: string): void {
    if (!this.configs[args.providerId].capabilities[capability])
      this.missing(args, capability, operation)
  }

  // ------------------------------------------------------------------- probes

  /** Model catalogs learned from handshakes, for every provider probed so far.
   *
   * Cached rather than asked for on demand: the caller is an IPC handler the
   * renderer polls, and answering it by spawning a CLI would put a ~230 MB
   * process behind a dropdown opening. Empty until the first probe answers,
   * and permanently empty for providers that only list models on a live
   * session. */
  providerModels(): Partial<Record<ProviderId, ModelListing>> {
    return Object.fromEntries(this.modelsByProvider) as Partial<Record<ProviderId, ModelListing>>
  }

  /** Mode catalogs learned from handshakes. Cached on the same terms, and for
   * the same caller, as `providerModels()`. */
  providerModes(): Partial<Record<ProviderId, ModeListing>> {
    return Object.fromEntries(this.modesByProvider) as Partial<Record<ProviderId, ModeListing>>
  }

  /** Seed catalogs from the host's boot cache, so the composer has a full
   * picker before the first probe answers.
   *
   * Fill-only, and that is the whole safety argument: a live catalog learned
   * this run always wins, and hydration never overwrites one. The restored
   * entry is a claim about the *last* run's binary, carried only until this
   * run's probe either confirms the version or replaces it.
   *
   * This is emphatically not the mistake `AppliedConfigCache` exists to avoid.
   * That cache holds what a live process was told — which model a turn will
   * actually run on — and Cursor's copy of it is process-global and survives on
   * disk, so a restored value can describe a process that has already exited.
   * A catalog is the opposite kind of fact: the *set* of models a build offers,
   * identical for every process of that build, and settable by nobody. */
  hydrateProviderCatalogs(cache: Partial<Record<ProviderId, ProviderCatalogSnapshot>>): void {
    for (const [id, snapshot] of Object.entries(cache)) {
      const providerId = id as ProviderId
      if (!snapshot?.models.availableModels?.length) continue
      if (this.modelsByProvider.get(providerId)?.availableModels?.length) continue
      this.modelsByProvider.set(providerId, snapshot.models)
      this.catalogVersions.set(providerId, snapshot.agentVersion)
      if (snapshot.modes?.availableModes?.length && !this.modesByProvider.has(providerId)) {
        this.modesByProvider.set(providerId, snapshot.modes)
      }
    }
  }

  /** Catalogs worth writing to the host's boot cache, each stamped with the
   * agent build that produced it. Only providers discovered live this run —
   * re-persisting a hydrated entry would launder a stale catalog into looking
   * freshly confirmed. */
  providerCatalogSnapshots(): Partial<Record<ProviderId, ProviderCatalogSnapshot>> {
    const snapshots: Partial<Record<ProviderId, ProviderCatalogSnapshot>> = {}
    for (const providerId of this.catalogsDiscovered) {
      const models = this.modelsByProvider.get(providerId)
      if (!models?.availableModels?.length) continue
      const agentVersion = this.catalogVersions.get(providerId)
      const modes = this.modesByProvider.get(providerId)
      snapshots[providerId] = {
        models,
        ...(modes?.availableModes?.length ? { modes } : {}),
        ...(agentVersion ? { agentVersion } : {}),
      }
    }
    return snapshots
  }

  /** Learn an ACP provider's catalog on the process that has just handshaken.
   *
   * The same trade `bootstrapSessions` makes, for the same reason: this probe
   * has already paid for a spawn and a handshake, and the catalog method needs
   * nothing else. Asking here costs one ext round trip; leaving it to the
   * composer costs either a whole second CLI or — far worse — nothing at all
   * until the user's first message, which is the empty-picker bug.
   *
   * Three guards, each load-bearing:
   *
   * - Only providers that advertise an *unattached* catalog method. Everything
   *   else would fall back to `session/new` inside `listModels`, and a 3.5s
   *   session opened on every health tick is not a health tick.
   * - Only when nothing is known yet. This runs on the health monitor's
   *   continuous loop, not just at boot, and re-asking every tick would spend a
   *   round trip per provider per interval to relearn a static list. A catalog
   *   that genuinely changed (a CLI upgrade) is picked up on the next launch,
   *   which is the same freshness the persisted cache promises.
   * - Failure is swallowed. A catalog nobody asked for must not turn a healthy
   *   provider into a failed probe; `recorder.failed` is for the handshake.
   *
   * Deliberately awaited rather than fired and forgotten: the probe is disposed
   * in `probeProvider`'s `finally`, so a detached call would race a terminated
   * transport and log a spurious failure. */
  private async adoptCatalog(
    providerId: ProviderId,
    cwd: string,
    probe: ProbeRuntime,
    result: ProbeResult,
  ): Promise<void> {
    const config = this.configs[providerId]
    if (config.kind !== 'acp' || !config.catalog) return
    // Already asked this run: the answer is from this binary, over this
    // protocol, and nothing since could have changed it.
    if (this.catalogsDiscovered.has(providerId)) return
    // A hydrated catalog is trusted only while the build that produced it is
    // still the one installed. Anything else — a version mismatch, or a disk
    // entry that never recorded one — is a guess, and re-asking costs one ext
    // call against serving a model the new binary may reject.
    const version = result.agentInfo?.version
    const known = this.modelsByProvider.get(providerId)?.availableModels?.length
    if (known && version !== undefined && this.catalogVersions.get(providerId) === version) return
    try {
      const listing = await probe.listModels(cwd)
      if (listing.availableModels?.length) {
        this.modelsByProvider.set(providerId, listing)
        this.catalogVersions.set(providerId, version)
        this.catalogsDiscovered.add(providerId)
      }
    } catch (error) {
      this.host.log({
        scope: 'agent-runtime',
        level: 'warn',
        message: 'Could not read the model catalog on the probe',
        data: {
          providerId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /** Provider-level bootstrap in a throwaway process: spawn, `initialize`,
   * `authenticate`, then `session/list` on that same process. This replaces the
   * old `start()`, which spawned the one shared per-provider process.
   * Pseudo-threads (`desktop-bootstrap:*`, `session-metadata:*`) must come
   * through here — they never create session runtimes.
   *
   * `beginProbe` is registered *synchronously*, before the first await. The
   * health monitor's boot sweep declines to probe a provider that already has
   * an adopted probe open, so a caller that starts the bootstrap before
   * `health.start()` gets one CLI for both questions instead of two racing
   * ones. `AgentHost.startHealthMonitor` is the other half of that contract. */
  async probeProvider(args: RuntimeRoute): Promise<ProviderBootstrap> {
    this.rememberCwd(args)
    const probe = this.probeRuntime(args, true)
    // This *is* a health probe, in a throwaway process, right now. The monitor
    // adopts its outcome so the bootstrap does not spawn one CLI here and a
    // second one on the health loop moments later.
    const recorder = this.health.beginProbe(args.providerId)
    try {
      const result = await probe.probe()
      recorder.ok(result)
      return {
        result,
        sessions: await this.bootstrapSessions(args, probe, result),
        commands: result.commands,
        models: result.models,
        modes: result.modes,
      }
    } catch (error) {
      recorder.failed(error)
      throw error
    } finally {
      await probe.dispose()
    }
  }

  /** `session/list` on the process that has just finished the handshake.
   *
   * A completed handshake is `session/list`'s only prerequisite, and this probe
   * has one — so asking here costs a ~55ms read, where leaving it to
   * `listSessions` costs a whole second CLI (~9s, ~230 MB) spawned purely to
   * redo a handshake this process already did. Failure is swallowed: a title
   * refresh nobody explicitly asked for must not fail the bootstrap that the
   * renderer reads as "provider ready". */
  private async bootstrapSessions(
    args: RuntimeRoute,
    probe: ProbeRuntime,
    result: ProbeResult,
  ): Promise<ProviderSessionInfo[] | undefined> {
    if (!result.sessionListAdvertised) return undefined
    if (!this.configs[args.providerId].capabilities.canListSessions) return undefined
    try {
      return await probe.listSessions(args.cwd)
    } catch (error) {
      this.host.log({
        scope: 'agent-runtime',
        level: 'warn',
        message: 'Could not list sessions on the bootstrap probe',
        data: {
          providerId: args.providerId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return undefined
    }
  }

  /** `session/list` for a provider + directory.
   *
   * Prefers a live runtime already pointed at that directory. This runs after
   * every completed prompt, and after a prompt completes that thread's runtime
   * is alive by definition — so the common case costs one ~55ms read on a
   * process that is already up, instead of a full CLI spawn (~4.4s, ~141 MB)
   * that is thrown away immediately. `session/list` touches no model or config
   * state, so borrowing cannot perturb the user's session; a health probe,
   * which does write config on Cursor, never borrows (invariant 9).
   *
   * Falls back to a throwaway probe when nothing is live — the bootstrap case,
   * where there is no thread at all. */
  async listSessions(args: RuntimeRoute): Promise<ProviderSessionInfo[]> {
    this.require(args, 'canListSessions', 'list sessions')
    this.rememberCwd(args)
    const live = this.liveListSessionsRuntime(args)
    if (live) {
      // Deliberately no `touch`. This borrows *another* thread's process, and
      // the borrowed thread did nothing — a title refresh runs after every
      // completed prompt anywhere in the workspace, so touching here would
      // reset the idle clock of an untouched thread every few minutes and pin
      // its ~230 MB for as long as the workspace is in use. The reaper's
      // signal has to stay "this thread was used".
      return live.runtime.listSessions()
    }
    // Silent: this runs after every completed prompt, and re-emitting the
    // handshake events each time would spam the renderer's chrome-event feed.
    const probe = this.probeRuntime(args, false)
    try {
      return await probe.listSessions(args.cwd)
    } finally {
      await probe.dispose()
    }
  }

  /** A started runtime for this provider in this directory whose own
   * `initialize` advertised `session/list`. Idle runtimes are preferred over
   * ones mid-turn; a runtime still starting has no usable connection yet. */
  private liveListSessionsRuntime(args: RuntimeRoute): SessionRuntimeEntry | undefined {
    const candidates = this.registry
      .forProvider(args.providerId)
      .filter(
        (entry) =>
          entry.cwd === args.cwd &&
          entry.runtime.phase === 'ready' &&
          entry.runtime.listSessionsAdvertised,
      )
    return candidates.find((entry) => entry.activeTurn === null) ?? candidates[0]
  }

  private rememberCwd(args: RuntimeRoute): void {
    if (args.cwd.length > 0) this.lastCwdByProvider.set(args.providerId, args.cwd)
  }

  private probeRuntime(args: RuntimeRoute, emitEvents: boolean): ProbeRuntime {
    return this.probes.create(args.providerId, args.cwd, {
      threadId: args.threadId,
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      ...(emitEvents
        ? { onEvent: (event: BackendEvent) => this.forward(args.providerId, event) }
        : {}),
    })
  }

  // ------------------------------------------------------------------ session

  async ensureSession(args: RuntimeSessionArgs): Promise<SessionResult> {
    return this.openSession(args, true)
  }

  /** `ensureSession`, with control over whether desired config is reconciled
   * against an already-live runtime here.
   *
   * `reconcile: false` is for `prompt`, which reconciles inside the runtime
   * atomically with dispatch. Doing it here as well would be a second,
   * *earlier* apply against a process that may still be streaming somebody
   * else's turn — the write is wasted, and on Cursor it costs 1.4–3.0s. A cold
   * start still applies the spec's config during bootstrap either way. */
  private async openSession(args: RuntimeSessionArgs, reconcile: boolean): Promise<SessionResult> {
    if (isPseudoThreadId(args.threadId))
      throw new Error(
        `${args.threadId} is a pseudo-thread and cannot own a session runtime; use a probe`,
      )
    this.bindProvider(args.threadId, args.providerId)
    if (args.sessionId) this.require(args, 'canLoadSession', 'load session')
    const desired = this.desiredFor(args)
    const result = await this.startOrRebind(args, desired)
    this.remember(args, result.sessionId)
    // A runtime applies `desiredConfig` once at start; a *reused* one never
    // saw it. Reconciling here covers both, and the applied-state cache makes
    // the reused case free whenever the agent already reports the desired
    // values. Failures propagate: a prompt must never run on a model other
    // than the one the composer shows.
    if (reconcile && desired) await this.entry(args).runtime.applyDesiredConfig(desired)
    return result
  }

  /** The desired config to open this session with: the caller's, where it has
   * an opinion (a job carrying a per-message override), and otherwise the
   * host's durable preference for this workspace and provider.
   *
   * Falling back to the host is what makes every entry point — a prompt, a
   * `set_model` respawn, `acp:load-session` — configure a fresh process the
   * same way, without any of them having to remember to pass it. */
  private desiredFor(args: RuntimeSessionArgs): DesiredSessionConfig | undefined {
    const desired = args.desiredConfig ?? this.durableDesired(args)
    return desired ? this.supported(args.providerId, desired) : undefined
  }

  private durableDesired(args: RuntimeRoute): DesiredSessionConfig | undefined {
    const workspacePath = args.workspaceId ?? args.cwd
    if (!workspacePath) return undefined
    return this.host.desiredSessionConfig?.({ providerId: args.providerId, workspacePath })
  }

  /** Record what a respawn of this thread would need. Called on every
   * successful `ensureSession`, which is the only place all of it is known. */
  private remember(args: RuntimeSessionArgs, sessionId: string): void {
    const previous = this.resumes.get(args.threadId)
    this.resumes.set(args.threadId, {
      providerId: args.providerId,
      workspaceId: args.workspaceId,
      cwd: args.cwd,
      sessionId,
      // A cursor only ever arrives from the wire, so an absent one on this
      // call means "nothing newer", not "reset to nothing".
      resumeCursor: args.resumeCursor ?? previous?.resumeCursor,
    })
  }

  private async startOrRebind(
    args: RuntimeSessionArgs,
    desired: DesiredSessionConfig | undefined,
  ): Promise<SessionResult> {
    this.rememberCwd(args)
    const rebound = await this.rebind(args)
    if (rebound) return rebound
    try {
      const started = await this.registry.ensureStarted({
        threadId: args.threadId,
        providerId: args.providerId,
        workspaceId: args.workspaceId,
        cwd: args.cwd,
        sessionId: args.sessionId,
        resumeCursor: args.resumeCursor,
        ...(desired ? { desiredConfig: desired } : {}),
      })
      // Spawn, handshake, auth and session bootstrap all just succeeded
      // against this CLI. That is a stronger and more recent observation than
      // any probe, so it clears an earlier crash.
      this.health.observeRuntimeStarted(args.providerId)
      return started.result
    } catch (error) {
      this.health.observeRuntimeStartFailed(
        args.providerId,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  /** Reconcile durable user intent against a live runtime's applied state.
   * Errors propagate; only writes the provider has no operation for at all are
   * dropped. */
  async applyDesiredConfig(args: RuntimeRoute, desired: DesiredSessionConfig): Promise<void> {
    const supported = this.supported(args.providerId, desired)
    if (!supported) return
    const entry = await this.liveEntry(args)
    await entry.runtime.applyDesiredConfig(supported)
  }

  /** Desired config minus what the provider advertises no operation for. A
   * provider without `canSetConfigOption` has no way to honour remembered
   * values, and failing every message over that would help nobody. */
  private supported(
    providerId: ProviderId,
    desired: DesiredSessionConfig,
  ): DesiredSessionConfig | undefined {
    const capabilities = this.configs[providerId].capabilities
    const supported: DesiredSessionConfig = {
      ...(desired.modelId !== undefined && capabilities.canSetModel
        ? { modelId: desired.modelId }
        : {}),
      ...(desired.modeId !== undefined && capabilities.canSetMode ? { modeId: desired.modeId } : {}),
      ...(desired.values && capabilities.canSetConfigOption ? { values: desired.values } : {}),
    }
    return Object.keys(supported).length > 0 ? supported : undefined
  }

  /** `create_session` creates a session under a provisional thread id and then
   * asks for it again under the created session's id. That is a rename, not a
   * second session: move the live runtime instead of spawning another process
   * and reloading the transcript. */
  private async rebind(args: RuntimeSessionArgs): Promise<SessionResult | undefined> {
    if (!args.sessionId || this.registry.get(args.threadId)) return undefined
    const owner = this.registry.findBySession(args.providerId, args.sessionId)
    if (!owner || owner.cwd !== args.cwd) return undefined
    const provisional = owner.threadId
    const moved = this.registry.rekey(owner.threadId, args.threadId, args.workspaceId)
    if (!moved) {
      // The rename lost a race — something took the permanent thread id while
      // this was deciding. Falling through would start a *second* process and
      // point it at the ACP session the provisional runtime is already
      // holding: two children, one session, both convinced they own it. Stop
      // the provisional one first so whatever runs under the permanent id
      // loads the session as its sole owner.
      this.host.log({
        scope: 'agent-runtime',
        level: 'warn',
        message: 'Could not rekey a provisional session runtime; stopping it instead',
        data: { providerId: args.providerId, from: provisional, to: args.threadId },
      })
      await this.registry.remove(provisional, { reason: 'superseded' })
      this.forgetThread(provisional)
      return undefined
    }
    // The provisional thread id is dead the moment the runtime moves off it;
    // its bookkeeping would otherwise sit in these maps for the whole run, one
    // leaked uuid per session the user creates.
    this.forgetThread(provisional)
    return {
      sessionId: args.sessionId,
      state: 'reused',
      resumeCursor: moved.runtime.resumeCursor,
    }
  }

  /** Drop every trace of a thread id that can never be used again. */
  private forgetThread(threadId: string): void {
    this.resumes.delete(threadId)
    this.threadProviders.delete(threadId)
    this.sequences.delete(threadId)
    this.activeMessageIds.delete(threadId)
    this.promptQueues.delete(threadId)
  }

  ensureThreadSession(args: RuntimeSessionArgs): Promise<SessionResult> {
    return this.ensureSession(args)
  }

  /** Queue one turn for a thread.
   *
   * The desired config travels *with* the prompt into the runtime, where it is
   * applied inside the same critical section that dispatches `session/prompt`.
   * It is deliberately not applied here: this method returns as soon as the
   * prompt is queued, and a turn already in flight can hold the queue for
   * minutes. Applying config here and dispatching later means a second prompt
   * arriving in between decides what model the first one runs on. */
  async prompt(
    args: RuntimeSessionArgs & { prompt: PromptInput; userMessageId?: string },
  ): Promise<SessionResult> {
    const session = await this.openSession(args, false)
    const key = args.threadId
    const previous = this.promptQueues.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.runPrompt(args))
    const queued = run.finally(() => {
      if (this.promptQueues.get(key) === queued) this.promptQueues.delete(key)
    })
    this.promptQueues.set(key, queued)
    await run
    return session
  }

  private async runPrompt(
    args: RuntimeSessionArgs & { prompt: PromptInput; userMessageId?: string },
  ): Promise<void> {
    const entry = this.entry(args)
    const userMessageId = args.userMessageId ?? `agent_usr_${crypto.randomUUID()}`
    // Re-resolved here rather than reused from `openSession`: this runs when
    // the turn ahead of it has finished, which may be minutes later, and the
    // answer that matters is the one that is current at dispatch.
    const desired = this.desiredFor(args)
    this.registry.beginTurn(args.threadId, { userMessageId, startedAt: Date.now() })
    try {
      await entry.runtime.prompt({
        prompt: args.prompt,
        userMessageId,
        ...(desired ? { desiredConfig: desired } : {}),
      })
    } finally {
      this.registry.endTurn(args.threadId)
    }
  }

  sendPrompt(
    args: RuntimeSessionArgs & { prompt: PromptInput; userMessageId?: string },
  ): Promise<SessionResult> {
    return this.prompt(args)
  }
  /** Wait until the current prompt for a thread has fully settled. Interactive
   * review responses use this before changing mode and starting a follow-up. */
  async waitForPromptIdle(threadId: string): Promise<void> {
    const pending = this.promptQueues.get(threadId)
    if (pending) await pending.catch(() => undefined)
  }
  /** Cancel the turn in flight on a thread.
   *
   * Unlike the config setters this deliberately does **not** respawn a missing
   * runtime. No in-flight prompt can exist without a registry entry: the
   * registry drops an entry in the same tick its process dies (invariant 5) —
   * which rejects the outstanding `session/prompt` — the reaper never touches
   * a runtime with an active turn (invariant 10), and neither does LRU
   * eviction. So a cancel with no entry has provably nothing to cancel, and
   * spawning a ~141 MB process for ~10.2s to send `session/cancel` into an
   * idle session would leave the user with a CLI they never asked for as the
   * result of pressing Stop. It resolves instead of throwing, which is the
   * part Phase 1 flagged as the gap. */
  async cancel(args: RuntimeRoute & { sessionId: string }): Promise<void> {
    this.require(args, 'canCancelPrompt', 'cancel prompt')
    const entry = this.registry.get(args.threadId)
    if (!entry || !isRuntimeAlive(entry.runtime.phase)) {
      this.host.log({
        scope: 'agent-runtime',
        level: 'info',
        message: 'Ignoring a cancel for a thread with no live process',
        data: { providerId: args.providerId, threadId: args.threadId },
      })
      return
    }
    await entry.runtime.cancel()
  }
  cancelPrompt(args: RuntimeRoute & { sessionId: string }): Promise<void> {
    return this.cancel(args)
  }

  /** The thread is gone for good — the user deleted the session.
   *
   * Stops its process now rather than leaving a CLI holding a session nobody
   * can reach until the idle reaper notices half an hour later, and forgets
   * every map entry keyed by the dead thread id. Resolves once the child is
   * actually gone; a thread with no runtime is a no-op, not an error. */
  async closeThread(args: { providerId: ProviderId; threadId: string }): Promise<void> {
    const entry = this.registry.get(args.threadId)
    if (entry && entry.providerId === args.providerId)
      await this.registry.remove(args.threadId, { reason: 'session_deleted' })
    this.forgetThread(args.threadId)
  }

  // Permissions and raw extension requests live entirely in the app-wide
  // brokers, keyed by requestId; only questions and plans need the runtime that
  // holds the provider-specific adapter for the request.
  respondPermission(args: {
    providerId: ProviderId
    requestId: string
    outcome: PermissionOutcome
  }): boolean {
    if (!this.permissions.respond(args.requestId, args.outcome))
      throw new Error('Permission request not found or already resolved')
    return true
  }
  respondExtension(args: {
    providerId: ProviderId
    requestId: string
    response: unknown
  }): boolean {
    if (!this.interactions.respond(args.requestId, args.response))
      throw new Error('Extension request not found or already resolved')
    return true
  }
  respondQuestion(args: {
    providerId: ProviderId
    requestId: string
    outcome: QuestionOutcome
  }): boolean {
    const found = this.anyRuntime(args.providerId, (runtime) =>
      runtime.respondQuestion(args.requestId, args.outcome),
    )
    if (!found) throw new Error('Question not found or already resolved')
    return true
  }
  respondPlan(args: {
    providerId: ProviderId
    requestId: string
    outcome: PlanReviewOutcome
  }): boolean {
    const found = this.anyRuntime(args.providerId, (runtime) =>
      runtime.respondPlan(args.requestId, args.outcome),
    )
    if (!found) throw new Error('Plan review not found or already resolved')
    return true
  }

  async setModel(args: RuntimeRoute & { sessionId: string; modelId: string }): Promise<void> {
    this.require(args, 'canSetModel', 'set model')
    const entry = await this.liveEntry(args)
    await entry.runtime.setModel(args.modelId)
  }
  setSessionModel(args: RuntimeRoute & { sessionId: string; modelId: string }): Promise<void> {
    return this.setModel(args)
  }
  async setMode(args: RuntimeRoute & { sessionId: string; modeId: string }): Promise<void> {
    this.require(args, 'canSetMode', 'set mode')
    const entry = await this.liveEntry(args)
    await entry.runtime.setMode(args.modeId)
  }
  setSessionMode(args: RuntimeRoute & { sessionId: string; modeId: string }): Promise<void> {
    return this.setMode(args)
  }
  async setConfigOption(
    args: RuntimeRoute & { sessionId: string; configId: string; value: string | boolean },
  ): Promise<void> {
    this.require(args, 'canSetConfigOption', 'set config option')
    const entry = await this.liveEntry(args)
    await entry.runtime.setConfigOption(args.configId, args.value)
  }
  setSessionConfigOption(
    args: RuntimeRoute & { sessionId: string; configId: string; value: string | boolean },
  ): Promise<void> {
    return this.setConfigOption(args)
  }

  /** Orderly app shutdown: stop the timers, settle everything pending, then
   * terminate every child and **wait for it to actually be gone**.
   *
   * The waiting is the point. `dispose()` delivers SIGTERM and returns, which
   * is fine for a test but not for app quit: if Electron exits before the
   * grace window, the SIGKILL escalation never fires and a CLI that ignored
   * SIGTERM is orphaned with no parent left to reap it. Runtimes mid-turn are
   * terminated too — a quit is a quit.
   *
   * Bounded by `SHUTDOWN_BUDGET_MS` so a child the OS will not kill cannot
   * hold the quit open indefinitely; blowing the budget is logged, not
   * thrown, because the app is on its way out and there is nobody to tell. */
  async shutdown(): Promise<void> {
    this.stopBackground()
    this.permissions.settleAll()
    this.interactions.settleAll()
    try {
      await withTimeout(
        this.registry.shutdown({ reason: 'disposed' }),
        SHUTDOWN_BUDGET_MS,
        () =>
          new Error(`Session runtimes did not all exit within ${SHUTDOWN_BUDGET_MS}ms`),
      )
    } catch (error) {
      this.host.log({
        scope: 'agent-runtime',
        level: 'error',
        message: 'Shutdown budget elapsed with session runtimes still alive',
        data: { error: error instanceof Error ? error.message : String(error) },
      })
    }
    this.clearBookkeeping()
  }

  /** Synchronous best-effort teardown. Signals every child but does not wait;
   * app quit should use `shutdown()`. */
  dispose(): void {
    // App shutdown reports `runtime_disposed`; an individual runtime dying
    // reports `session_closed`, which is why the brokers settle first.
    this.stopBackground()
    this.permissions.settleAll()
    this.interactions.settleAll()
    this.registry.disposeAll()
    this.clearBookkeeping()
  }
  disposeAll(): void {
    this.dispose()
  }

  private stopBackground(): void {
    this.reaper.stop()
    this.health.stop()
  }
  private clearBookkeeping(): void {
    this.promptQueues.clear()
    this.threadProviders.clear()
    this.activeMessageIds.clear()
    this.resumes.clear()
  }

  /** The live runtime for a thread. Callers reach this only after
   * `ensureSession`, so a missing entry means the process died in between.
   *
   * The identity check is not decoration. `ensureSession` resolves to *an*
   * entry for the thread; only comparing provider and cwd proves it is the one
   * this caller asked for. Without it a caller that lost a race to a
   * concurrent ensure for another directory would happily prompt a process
   * rooted somewhere else, which is the same class of failure as sharing an
   * in-flight start. */
  private entry(args: RuntimeRoute): SessionRuntimeEntry {
    const entry = this.registry.get(args.threadId)
    if (!entry) throw new Error(`No live ${args.providerId} session for thread ${args.threadId}`)
    if (entry.providerId !== args.providerId || entry.cwd !== args.cwd)
      throw new Error(
        `Thread ${args.threadId} is running ${entry.providerId} in ${entry.cwd}, not ${args.providerId} in ${args.cwd}`,
      )
    return entry
  }

  /** The live runtime for a thread, respawning and resuming if its process is
   * gone.
   *
   * This is the recovery path for everything the reaper, the LRU cap or a
   * crash can take away. Lazy, like the reference architecture: nothing
   * supervises or auto-restarts, and a thread nobody touches again stays dead
   * and costs nothing. There is no retry limit and no backoff, because there
   * is no loop — one user action produces at most one respawn attempt, and a
   * failure surfaces as that action failing.
   *
   * `session/load` fails with "Session not found" for a session that was
   * created but never prompted; `AcpSessionRuntimeImpl.openSession` catches
   * that and falls back to `session/new`, so a never-prompted thread resumes
   * as an empty session instead of failing. */
  private async liveEntry(args: RuntimeRoute & { sessionId?: string }): Promise<SessionRuntimeEntry> {
    const existing = this.registry.get(args.threadId)
    if (existing && isRuntimeAlive(existing.runtime.phase)) return existing

    const remembered = this.resumes.get(args.threadId)
    // Prefer the caller's session id: it comes from Convex `sessions.
    // externalId`, which survives an app restart that this map does not.
    const sessionId = args.sessionId ?? remembered?.sessionId
    const canLoad = this.configs[args.providerId].capabilities.canLoadSession
    this.host.log({
      scope: 'agent-runtime',
      level: 'info',
      message: 'Respawning a session runtime for a thread whose process is gone',
      data: {
        providerId: args.providerId,
        threadId: args.threadId,
        sessionId,
        resuming: Boolean(sessionId && canLoad),
      },
    })
    // Straight back through `ensureSession` so a respawn goes down exactly the
    // same path a cold start does — including re-applying desired config
    // against this process's own read-back state, which is what stops a
    // respawned Cursor inheriting the model left on disk by a dead process.
    // No desired config is carried here: `openSession` asks the host for the
    // current one, which is the only version that cannot be stale.
    await this.ensureSession({
      ...args,
      ...(sessionId && canLoad ? { sessionId } : {}),
      ...(remembered?.resumeCursor ? { resumeCursor: remembered.resumeCursor } : {}),
    })
    return this.entry(args)
  }
  /** requestIds are uuids, so the first runtime that recognises one owns it. */
  private anyRuntime(
    providerId: ProviderId,
    respond: (runtime: SessionRuntimeEntry['runtime']) => boolean,
  ): boolean {
    for (const entry of this.registry.forProvider(providerId)) {
      if (respond(entry.runtime)) return true
    }
    return false
  }
}
