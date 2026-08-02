import type {
  AgentEvent,
  PermissionOutcome,
  PermissionRequest,
  PlanDocument,
  PlanReviewOutcome,
  PromptCapabilities,
  ProviderId,
  ProviderSessionInfo,
  QuestionOutcome,
  QuestionRequest,
} from '@agentpack/contract'
import { AgentRuntime, type DesiredSessionConfig, type HostLogEntry } from '@agentpack/runtime'
import type { BrowserWindow } from 'electron'
import type { ProviderHealthReport } from '@openmanager/shared/contracts/provider-health'
import type { SidecarHandshake } from '@openmanager/shared/contracts/sidecar'
import { ConvexProjector } from './convex-projector'
import { toProviderHealthCache, type ProviderHealthCache } from './provider-health-cache'

/** How long to sit on health changes before writing the boot cache. Health
 * churns in bursts (a handshake fires initialized + authenticated + probe
 * within a second); the cache only has to be roughly current at the next
 * launch, so it is not worth a disk write per event. */
const HEALTH_CACHE_WRITE_DELAY_MS = 2_000

export type AgentHostOptions = {
  /** Boot cache. Read once at construction, written back as health changes. */
  healthCache?: {
    load: () => ProviderHealthCache
    save: (cache: ProviderHealthCache) => void
  }
  /** Directory health probes spawn in for providers the user has not opened
   * this run — normally the last active workspace. */
  probeCwd?: string
  /** The workspace's persisted composer selection, read on demand. The runtime
   * keeps no copy: a respawn asks for the current answer rather than replaying
   * whatever was remembered when the thread first started. */
  desiredSessionConfig?: (args: {
    providerId: ProviderId
    workspacePath: string
  }) => DesiredSessionConfig | undefined
}

export class AgentHost {
  readonly runtime: AgentRuntime
  private readonly promptCapabilitiesByProvider = new Map<ProviderId, PromptCapabilities>()
  private healthCacheTimer: NodeJS.Timeout | undefined
  private localSequence = 0
  private readonly pendingPermissions = new Map<string, PermissionRequest>()
  private readonly pendingExtensions = new Map<string, { method: string; params: unknown }>()
  private readonly pendingQuestions = new Map<string, QuestionRequest>()
  private readonly pendingPlans = new Map<string, PlanDocument>()
  private readonly titleRefreshes = new Map<string, Promise<void>>()

  constructor(
    readonly projector: ConvexProjector,
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly options: AgentHostOptions = {},
  ) {
    this.runtime = new AgentRuntime({
      emitEvent: (event) => this.emitEvent(event),
      log: (entry) => this.log(entry),
      onSessionTitle: ({ threadId, workspaceId, title }) =>
        this.projector.updateSessionTitle(threadId, workspaceId, title),
      ...(options.desiredSessionConfig
        ? { desiredSessionConfig: options.desiredSessionConfig }
        : {}),
    })
    // Render last run's answer immediately rather than "unavailable" for the
    // ~10s a cold Cursor probe takes. Hydration restores past-tense axes only;
    // the runtime axis is rebuilt from the live registry, which is empty here.
    const cached = options.healthCache?.load()
    if (cached) this.runtime.health.hydrate(cached)
    this.runtime.setDefaultProbeCwd(options.probeCwd)
    this.runtime.health.onChange((providerId, report) => this.pushHealth(providerId, report))
  }

  /** Start the continuous health loop.
   *
   * Deliberately *not* done in the constructor. `ProviderHealthMonitor.start()`
   * runs a boot refresh for every provider, and a provider the desktop is
   * already bootstrapping does not need one — `ensureProvider` registers its
   * throwaway probe with the monitor synchronously, and the monitor declines to
   * spawn against an adopted probe. Constructing the host and starting the loop
   * in one step meant the monitor always registered first and the bootstrap
   * always duplicated it: two `cursor-agent` processes at every launch, each
   * ~9s and ~230 MB, answering the same handshake.
   *
   * So the contract is ordering, and it is the caller's to keep: kick off the
   * bootstrap `ensureProvider` first, then call this. Providers the bootstrap
   * does not cover are probed here as before. */
  startHealthMonitor(): void {
    this.runtime.health.start()
  }

  /** Verify the provider's CLI works, in a throwaway process, and refresh its
   * session titles. There is no shared per-provider process to start any more:
   * session processes belong to threads, and a pseudo-thread is not a thread.
   *
   * No status is latched here. The probe's outcome is adopted by the health
   * monitor, which keeps re-verifying it; this call only reports whether this
   * one round trip answered. */
  async ensureProvider(
    providerId: ProviderId,
    cwd: string,
    threadId = `desktop-bootstrap:${providerId}`,
  ): Promise<SidecarHandshake> {
    this.runtime.setDefaultProbeCwd(cwd)
    const { sessions } = await this.runtime.probeProvider({
      providerId,
      threadId,
      workspaceId: cwd,
      cwd,
    })
    // The bootstrap probe already answered `session/list` on the process it had
    // open, so there is nothing here for `refreshSessionTitles` to spawn a
    // second CLI for. `undefined` means the agent does not advertise listing —
    // in which case a separate probe could not have answered either.
    if (sessions) await this.syncSessionTitles(providerId, cwd, sessions)
    return { ready: true }
  }

  /** Project a session list onto Convex, tolerating failure. A title sync that
   * fails must not turn a working provider into "unavailable" in the renderer,
   * which is what `ensureProvider` rejecting would mean. */
  private async syncSessionTitles(
    providerId: ProviderId,
    workspacePath: string,
    sessions: ProviderSessionInfo[],
  ): Promise<void> {
    try {
      await this.projector.syncProviderSessionTitles(workspacePath, providerId, sessions)
    } catch (error) {
      this.log({
        scope: 'agent-runtime',
        level: 'warn',
        message: 'Could not sync provider session titles',
        data: { providerId, workspacePath, error: (error as Error).message },
      })
    }
  }

  getHealth(): Partial<Record<ProviderId, ProviderHealthReport>> {
    return this.runtime.health.reports()
  }

  getPromptCapabilities(): Partial<Record<ProviderId, PromptCapabilities>> {
    return Object.fromEntries(this.promptCapabilitiesByProvider) as Partial<
      Record<ProviderId, PromptCapabilities>
    >
  }

  respondPermission(args: {
    providerId: ProviderId
    threadId: string
    requestId: string
    optionId?: string
    approved?: boolean
  }): void {
    const request = this.pendingPermissions.get(args.requestId)
    if (!request) throw new Error('Permission request not found or already resolved')
    this.runtime.respondPermission({
      providerId: args.providerId,
      requestId: args.requestId,
      outcome: this.permissionOutcome(request, args),
    })
    // Map + Convex cleanup happens on the permission_resolved event the broker
    // emits for every settlement (including this one).
  }

  respondExtension(args: { providerId: ProviderId; requestId: string; response: unknown }): void {
    if (!this.pendingExtensions.has(args.requestId))
      throw new Error('Extension request not found or already resolved')
    this.runtime.respondExtension(args)
    // Map cleanup happens on the extension_resolved event the broker emits.
  }

  respondQuestion(args: {
    providerId: ProviderId
    requestId: string
    outcome: QuestionOutcome
  }): void {
    if (!this.pendingQuestions.has(args.requestId))
      throw new Error('Question not found or already resolved')
    this.runtime.respondQuestion(args)
    // Map cleanup happens on the question_resolved event the broker emits for
    // every settlement (this one, a timeout, a dying process).
  }

  /** The plan document as the provider actually asked it, still parked and
   * unanswered. This map — not the job payload and not the Convex row — is the
   * source of truth for a pending review: it is written straight off the
   * `plan_review_request` event, it is what `respondPlan` validates against,
   * and it lives in the same process as the job worker. A caller that needs to
   * know how the provider expects the plan to continue asks here. */
  getPendingPlan(requestId: string): PlanDocument | undefined {
    return this.pendingPlans.get(requestId)
  }

  respondPlan(args: {
    providerId: ProviderId
    requestId: string
    outcome: PlanReviewOutcome
  }): void {
    if (!this.pendingPlans.has(args.requestId))
      throw new Error('Plan review not found or already resolved')
    this.runtime.respondPlan(args)
    // Map cleanup happens on the plan_review_resolved event the broker emits.
  }

  private permissionOutcome(
    request: PermissionRequest,
    args: { optionId?: string; approved?: boolean },
  ): PermissionOutcome {
    if (args.optionId) {
      const option = request.options.find((candidate) => candidate.optionId === args.optionId)
      if (!option) throw new Error(`Permission option not offered: ${args.optionId}`)
      return { outcome: 'selected', optionId: option.optionId }
    }
    if (typeof args.approved !== 'boolean')
      throw new Error('Permission response requires optionId or approved')
    // Boolean compat path (mobile client): pick by kind, never fall back to an
    // option of the opposite polarity.
    const preferredKinds = args.approved
      ? (['allow_once', 'allow_always'] as const)
      : (['reject_once', 'reject_always'] as const)
    const option = preferredKinds
      .map((kind) => request.options.find((candidate) => candidate.kind === kind))
      .find(Boolean)
    if (option) return { outcome: 'selected', optionId: option.optionId }
    if (!args.approved) return { outcome: 'cancelled', reason: 'user' }
    throw new Error('Permission request offers no allow option')
  }

  emitSessionDeleted(args: {
    providerId: ProviderId
    threadId: string
    workspacePath: string
    sessionId: string
  }): void {
    this.emitEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      seq: ++this.localSequence,
      providerId: args.providerId,
      threadId: args.threadId,
      workspaceId: args.workspacePath,
      sessionId: args.sessionId,
      category: 'lifecycle',
      event: 'session_deleted',
      data: {},
    })
  }

  /** Orderly shutdown for app quit: waits for every CLI child to be gone
   * before resolving, so nothing is orphaned when Electron exits. Bounded
   * internally by the runtime's shutdown budget. */
  async shutdown(): Promise<void> {
    this.flushHealthCache()
    await this.runtime.shutdown()
  }

  /** Synchronous best-effort teardown. Signals the children but does not wait
   * for them; prefer `shutdown()` wherever there is somewhere to await. */
  dispose(): void {
    this.flushHealthCache()
    this.runtime.dispose()
  }

  private flushHealthCache(): void {
    if (this.healthCacheTimer) {
      clearTimeout(this.healthCacheTimer)
      this.healthCacheTimer = undefined
    }
    // Write the final snapshot before the monitor stops emitting.
    this.writeHealthCache()
  }

  private emitEvent(event: AgentEvent): void {
    if (event.event === 'initialized' && event.data.promptCapabilities) {
      this.promptCapabilitiesByProvider.set(event.providerId, event.data.promptCapabilities)
    }
    if (event.event === 'permission_request') {
      this.pendingPermissions.set(event.data.requestId, event.data)
    }
    if (event.event === 'permission_resolved') {
      this.pendingPermissions.delete(event.data.requestId)
    }
    if (event.event === 'extension_request') {
      this.pendingExtensions.set(event.data.requestId, {
        method: event.data.method,
        params: event.data.params,
      })
    }
    if (event.event === 'question_request') {
      this.pendingQuestions.set(event.data.requestId, event.data)
    }
    if (event.event === 'plan_review_request') {
      this.pendingPlans.set(event.data.requestId, event.data)
    }
    // Each pending kind clears on its own settlement event. These used to share
    // `extension_resolved`, which only fires for interactions that travelled
    // over ACP's `_ext` methods — a provider raising questions or plans any
    // other way answered correctly and then left the row pending forever here,
    // in Convex and on mobile.
    if (event.event === 'extension_resolved') {
      this.pendingExtensions.delete(event.data.requestId)
    }
    if (event.event === 'question_resolved') {
      this.pendingQuestions.delete(event.data.requestId)
    }
    if (event.event === 'plan_review_resolved') {
      this.pendingPlans.delete(event.data.requestId)
    }
    this.projector.consume(event)
    if (event.event === 'prompt_completed' && event.workspaceId) {
      void this.refreshSessionTitles(event.providerId, event.workspaceId)
    }
    const window = this.getMainWindow()
    if (window?.isDestroyed() !== false) return
    window.webContents.send('acp:event', event)
    if (
      event.category === 'stream' ||
      event.category === 'tool' ||
      event.event === 'plan_update' ||
      event.event === 'prompt_started' ||
      event.event === 'prompt_completed' ||
      event.event === 'rpc_error' ||
      event.event === 'runtime_error' ||
      event.event === 'process_exited'
    ) {
      window.webContents.send('stream:token', event)
    }
    // `process_exited` deliberately does *not* set provider status here. One
    // session's process dying says nothing about the other three that are
    // still serving turns; the health monitor folds it into a rollup over all
    // of this provider's runtimes and its probes.
  }

  private pushHealth(providerId: ProviderId, report: ProviderHealthReport): void {
    const window = this.getMainWindow()
    if (window?.isDestroyed() === false) {
      window.webContents.send('agent:status-changed', { providerId, report })
    }
    this.scheduleHealthCacheWrite()
  }

  private scheduleHealthCacheWrite(): void {
    if (!this.options.healthCache || this.healthCacheTimer) return
    this.healthCacheTimer = setTimeout(() => {
      this.healthCacheTimer = undefined
      this.writeHealthCache()
    }, HEALTH_CACHE_WRITE_DELAY_MS)
    this.healthCacheTimer.unref?.()
  }

  private writeHealthCache(): void {
    const cache = this.options.healthCache
    if (!cache) return
    try {
      cache.save(toProviderHealthCache(this.runtime.health.reports()))
    } catch (error) {
      this.log({
        scope: 'agent-runtime',
        level: 'warn',
        message: 'Could not persist the provider health cache',
        data: { error: (error as Error).message },
      })
    }
  }

  /** `session/list`, preferring a live runtime for this provider + workspace
   * and falling back to a throwaway process only when none exists. See
   * `AgentRuntime.listSessions`: after a prompt completes that thread's
   * runtime is alive by definition, so the common case costs one ~55ms read
   * rather than a full CLI spawn. */
  private refreshSessionTitles(providerId: ProviderId, workspacePath: string): Promise<void> {
    if (!this.runtime.getProvider(providerId).capabilities.canListSessions) {
      return Promise.resolve()
    }
    const key = `${providerId}\u0000${workspacePath}`
    const active = this.titleRefreshes.get(key)
    if (active) return active

    const refresh = this.runtime
      .listSessions({
        providerId,
        threadId: `session-metadata:${providerId}`,
        workspaceId: workspacePath,
        cwd: workspacePath,
      })
      .then((sessions) =>
        this.projector.syncProviderSessionTitles(workspacePath, providerId, sessions),
      )
      .catch((error) => {
        this.log({
          scope: 'agent-runtime',
          level: 'warn',
          message: 'Could not refresh provider session titles',
          data: { providerId, workspacePath, error: (error as Error).message },
        })
      })
      .finally(() => {
        if (this.titleRefreshes.get(key) === refresh) this.titleRefreshes.delete(key)
      })
    this.titleRefreshes.set(key, refresh)
    return refresh
  }

  private log(entry: HostLogEntry): void {
    const prefix = `[${entry.scope}] ${entry.message}`
    if (entry.level === 'error') console.error(prefix, entry.data ?? '')
    else if (entry.level === 'warn') console.warn(prefix, entry.data ?? '')
    else console.log(prefix, entry.data ?? '')
  }
}
