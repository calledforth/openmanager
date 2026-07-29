import { ConvexClient } from 'convex/browser'
import { api } from '@openmanager/convex/_generated/api'
import type { Id } from '@openmanager/convex/_generated/dataModel'
import {
  isProviderId,
  type PromptAttachment,
  type PromptInput,
  type ProviderId,
} from '@agentpack/contract'
import type { DesiredSessionConfig } from '@agentpack/runtime'
import {
  estimateConvexPayloadBytes,
  extractConvexTelemetryContext,
  recordConvexTelemetry,
} from './convex-telemetry'
import type { AgentHost } from './agent-host'

type JobDoc = {
  _id: Id<'pending_jobs'>
  type: string
  payload: string
  status: string
}

type SessionConfigValues = Record<string, string | boolean>

export type DeleteSessionHost = {
  runtime: Pick<AgentHost['runtime'], 'getProvider' | 'closeThread'>
  projector: Pick<AgentHost['projector'], 'waitForThread'>
  emitSessionDeleted: AgentHost['emitSessionDeleted']
}

export async function deleteSession(
  host: DeleteSessionHost,
  args: {
    providerId: ProviderId
    sessionExternalId: string
    workspacePath: string
  },
): Promise<void> {
  const capabilities = host.runtime.getProvider(args.providerId).capabilities
  if (capabilities.canDeleteSession) {
    throw new Error(
      `Provider ${args.providerId} advertises session deletion without a runtime operation`,
    )
  }
  host.emitSessionDeleted({
    providerId: args.providerId,
    threadId: args.sessionExternalId,
    workspacePath: args.workspacePath,
    sessionId: args.sessionExternalId,
  })
  await host.projector.waitForThread(args.sessionExternalId)
  // Reclaim the process. A deleted session's runtime is unreachable —
  // nothing will ever prompt that thread again — so leaving it for the idle
  // reaper holds a ~230 MB CLI for up to half an hour for a session the user
  // has already thrown away. Stopped after the projector settles so the
  // deletion the UI sees is not interleaved with this thread's process_exited.
  await host.runtime.closeThread({
    providerId: args.providerId,
    threadId: args.sessionExternalId,
  })
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export class JobWorker {
  private unsubscribe: (() => void) | null = null
  /** Jobs claimed and still running, so `stop()` can wait for them. */
  private processing = new Map<string, Promise<void>>()
  /** Set by `stop()`. The app is quitting; do not claim anything else. */
  private stopped = false

  constructor(
    private convex: ConvexClient,
    private agentHost: AgentHost,
    private clientId: string,
    private getLastModelForWorkspace: (
      workspacePath: string,
      providerId: ProviderId,
    ) => string | null,
    private getConfigValuesForWorkspace: (
      workspacePath: string,
      providerId: ProviderId,
    ) => SessionConfigValues | undefined,
    private setLastModelForWorkspace: (
      workspacePath: string,
      providerId: ProviderId,
      modelId: string,
    ) => void,
  ) {}

  private providerId(value: unknown): ProviderId {
    return isProviderId(value) ? value : 'opencode'
  }

  private route(parsed: Record<string, any>, threadId: string) {
    return {
      providerId: this.providerId(parsed.providerId),
      threadId,
      workspaceId: parsed.workspacePath as string,
      cwd: parsed.workspacePath as string,
    }
  }

  private configValues(value: unknown): SessionConfigValues | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const entries = Object.entries(value).filter(
      (entry): entry is [string, string | boolean] =>
        entry[0].length > 0 && (typeof entry[1] === 'string' || typeof entry[1] === 'boolean'),
    )
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  /** What the composer shows, from the job's own overrides where present and
   * the workspace's remembered preferences otherwise.
   *
   * This used to be applied by hand before every prompt: an unconditional
   * `set_model` plus one `set_config_option` per remembered key, ~11.5s of
   * dead time per Cursor message. It is now handed to the runtime, which
   * reconciles it against the state its session actually reported and issues a
   * write only for what genuinely differs. The enforcement is the same; only
   * the round trips that changed nothing are gone. */
  private desiredConfig(
    parsed: Record<string, any>,
    providerId: ProviderId,
  ): DesiredSessionConfig | undefined {
    const modelId =
      typeof parsed.preferredModelId === 'string' && parsed.preferredModelId
        ? parsed.preferredModelId
        : (this.getLastModelForWorkspace(parsed.workspacePath, providerId) ?? undefined)
    const modeId =
      typeof parsed.preferredModeId === 'string' && parsed.preferredModeId
        ? parsed.preferredModeId
        : undefined
    const values =
      this.configValues(parsed.preferredConfigValues) ??
      this.getConfigValuesForWorkspace(parsed.workspacePath, providerId)
    const desired: DesiredSessionConfig = {
      ...(modelId ? { modelId } : {}),
      ...(modeId ? { modeId } : {}),
      ...(values ? { values } : {}),
    }
    return Object.keys(desired).length > 0 ? desired : undefined
  }

  private async promptInput(parsed: Record<string, any>): Promise<PromptInput> {
    const text = typeof parsed.content === 'string' ? parsed.content.trim() : ''
    const requested = Array.isArray(parsed.attachments)
      ? (parsed.attachments as PromptAttachment[]).filter(
          (item) => item && typeof item.id === 'string',
        )
      : []
    const resolved = requested.length
      ? ((await this.convex.query((api as any).attachments.resolveMany, {
          ids: requested.map((item) => item.id),
          clientId: this.clientId,
        })) as Array<{
          id: string
          name: string
          mimeType: string
          size: number
          url: string
        } | null>)
      : []

    if (resolved.some((item) => !item) || resolved.length !== requested.length) {
      throw new Error('One or more image attachments could not be resolved')
    }

    const blocks: PromptInput['blocks'] = text ? [{ type: 'text', text }] : []
    const attachments: PromptAttachment[] = []
    for (const item of resolved) {
      if (!item) continue
      if (!ALLOWED_IMAGE_TYPES.has(item.mimeType)) {
        throw new Error(`Unsupported image type: ${item.mimeType}`)
      }
      if (item.size <= 0 || item.size > MAX_IMAGE_BYTES) {
        throw new Error(`Image ${item.name} exceeds the 10 MB limit`)
      }
      const response = await fetch(item.url)
      if (!response.ok) throw new Error(`Failed to read image ${item.name}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(`Image ${item.name} is empty or exceeds the 10 MB limit`)
      }
      blocks.push({ type: 'image', mimeType: item.mimeType, data: bytes.toString('base64') })
      attachments.push({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        size: bytes.length,
      })
    }
    if (blocks.length === 0) throw new Error('A prompt must contain text or an image')
    return { text, blocks, ...(attachments.length ? { attachments } : {}) }
  }

  private async runTrackedMutation(name: string, mutationRef: any, args: Record<string, unknown>) {
    const startedAt = Date.now()
    const context = extractConvexTelemetryContext(args)
    recordConvexTelemetry({
      source: 'main',
      kind: 'mutation',
      phase: 'start',
      name,
      requestBytes: estimateConvexPayloadBytes(args),
      ...context,
    })
    try {
      const result = await this.convex.mutation(mutationRef, args)
      recordConvexTelemetry({
        source: 'main',
        kind: 'mutation',
        phase: 'success',
        name,
        durationMs: Date.now() - startedAt,
        requestBytes: estimateConvexPayloadBytes(args),
        responseBytes: estimateConvexPayloadBytes(result),
        ...context,
      })
      return result
    } catch (error) {
      recordConvexTelemetry({
        source: 'main',
        kind: 'mutation',
        phase: 'error',
        name,
        durationMs: Date.now() - startedAt,
        requestBytes: estimateConvexPayloadBytes(args),
        details: error instanceof Error ? error.message : 'Mutation failed',
        ...context,
      })
      throw error
    }
  }

  start(): void {
    console.log('[job-worker] subscribing to pending jobs')
    recordConvexTelemetry({
      source: 'main',
      kind: 'subscription',
      phase: 'subscribe',
      name: 'jobs.listPending',
      requestBytes: estimateConvexPayloadBytes({ clientId: this.clientId }),
    })
    const unsub = this.convex.onUpdate(
      api.jobs.listPending,
      { clientId: this.clientId },
      (jobs) => {
        recordConvexTelemetry({
          source: 'main',
          kind: 'subscription',
          phase: 'update',
          name: 'jobs.listPending',
          requestBytes: estimateConvexPayloadBytes({ clientId: this.clientId }),
          responseBytes: estimateConvexPayloadBytes(jobs),
        })
        if (!jobs) return
        if (this.stopped) return
        console.log(`[job-worker] ${jobs.length} pending job(s)`)
        for (const job of jobs as JobDoc[]) {
          if (this.processing.has(job._id)) continue
          const run = this.processJob(job).finally(() => this.processing.delete(job._id))
          this.processing.set(job._id, run)
        }
      },
    )
    this.unsubscribe = unsub
  }

  /** Stop claiming work and wait for what is already claimed.
   *
   * Unsubscribing alone was not enough for a quit: a job claimed a moment
   * earlier keeps running, and the very next thing it does is `ensureSession`,
   * which spawns a CLI the shutdown sweep has already walked past. Waiting
   * here — before the host tears the runtimes down — is what makes that
   * ordering deterministic instead of a race. A job that throws still settles;
   * `processJob` reports failures rather than rejecting. */
  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    recordConvexTelemetry({
      source: 'main',
      kind: 'subscription',
      phase: 'unsubscribe',
      name: 'jobs.listPending',
      requestBytes: estimateConvexPayloadBytes({ clientId: this.clientId }),
    })
    const inFlight = [...this.processing.values()]
    if (inFlight.length > 0) {
      console.log(`[job-worker] waiting for ${inFlight.length} in-flight job(s)`)
      await Promise.allSettled(inFlight)
    }
  }

  private async processJob(job: JobDoc): Promise<void> {
    console.log(`[job-worker] claiming job ${job._id} type=${job.type}`)
    const claimed = await this.runTrackedMutation('jobs.claim', api.jobs.claim, {
      jobId: job._id,
      clientId: this.clientId,
    })
    if (!claimed) {
      console.log(`[job-worker] job ${job._id} already claimed`)
      return
    }

    try {
      const parsed = JSON.parse(job.payload)
      const providerId = this.providerId(parsed.providerId)

      switch (job.type) {
        case 'send_message': {
          const route = this.route(parsed, parsed.sessionExternalId)
          const desired = this.desiredConfig(parsed, route.providerId)
          // The composer's selection is still enforced before every prompt —
          // it has to be, because prompts arrive from other devices too — but
          // it is handed to `prompt` rather than applied here. Applying it
          // first and prompting second used to leave a window that a network
          // round trip sat inside: `promptInput` resolves and downloads image
          // attachments, and any config a *different* job applied during that
          // download would be what this turn ran on. The runtime now applies
          // it atomically with dispatch, so there is no window to widen.
          const prompt = await this.promptInput(parsed)
          await this.agentHost.runtime.prompt({
            ...route,
            sessionId: parsed.sessionExternalId,
            ...(desired ? { desiredConfig: desired } : {}),
            prompt,
            userMessageId: parsed.userMessageId,
          })
          break
        }
        case 'create_session': {
          const provisionalThreadId = crypto.randomUUID()
          const desired = this.desiredConfig(parsed, providerId)
          // Carried on the spec so a cold process reconciles while the cache is
          // still warm from the `session/new` response.
          const session = await this.agentHost.runtime.ensureSession({
            ...this.route(parsed, provisionalThreadId),
            ...(desired ? { desiredConfig: desired } : {}),
          })
          const threadId = session.sessionId
          await this.agentHost.runtime.ensureSession({
            ...this.route(parsed, threadId),
            sessionId: session.sessionId,
          })
          await this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.sessionId,
            status: 'idle',
            providerId,
            title: parsed.title,
            ...(parsed.title ? { titleSource: 'fallback' } : {}),
            clientId: this.clientId,
          })
          break
        }
        case 'start_session_with_message': {
          const provisionalThreadId = crypto.randomUUID()
          const desired = this.desiredConfig(parsed, providerId)
          const session = await this.agentHost.runtime.ensureSession({
            ...this.route(parsed, provisionalThreadId),
            ...(desired ? { desiredConfig: desired } : {}),
          })
          const threadId = session.sessionId
          await this.agentHost.runtime.ensureSession({
            ...this.route(parsed, threadId),
            sessionId: session.sessionId,
          })
          await this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.sessionId,
            status: 'idle',
            providerId,
            title: parsed.title,
            ...(parsed.title ? { titleSource: 'fallback' } : {}),
            clientId: this.clientId,
          })
          const prompt = await this.promptInput(parsed)
          await this.agentHost.runtime.prompt({
            ...this.route(parsed, threadId),
            sessionId: session.sessionId,
            ...(desired ? { desiredConfig: desired } : {}),
            prompt,
            userMessageId: parsed.userMessageId,
          })
          break
        }
        case 'abort':
          await this.agentHost.runtime.cancel({
            ...this.route(parsed, parsed.sessionExternalId),
            sessionId: parsed.sessionExternalId,
          })
          break
        case 'delete_session':
          await deleteSession(this.agentHost, {
            providerId,
            sessionExternalId: parsed.sessionExternalId,
            workspacePath: parsed.workspacePath,
          })
          break
        case 'resolve_permission':
          this.agentHost.respondPermission({
            providerId,
            threadId: parsed.sessionExternalId,
            requestId: parsed.permissionId,
            optionId: typeof parsed.optionId === 'string' ? parsed.optionId : undefined,
            approved: typeof parsed.approved === 'boolean' ? parsed.approved : undefined,
          })
          break
        case 'resolve_extension':
          this.agentHost.respondExtension({
            providerId,
            requestId: parsed.requestId,
            response: parsed.response,
          })
          break
        case 'resolve_question':
          this.agentHost.respondQuestion({
            providerId,
            requestId: parsed.requestId,
            outcome: parsed.outcome,
          })
          break
        case 'resolve_plan':
          this.agentHost.respondPlan({
            providerId,
            requestId: parsed.requestId,
            outcome: parsed.outcome,
          })
          break
        case 'build_plan': {
          const route = this.route(parsed, parsed.sessionExternalId)
          this.agentHost.respondPlan({
            providerId,
            requestId: parsed.requestId,
            outcome: { outcome: 'accepted' },
          })
          // Accepting the plan releases the original Cursor prompt. Wait for
          // that prompt to finish before switching mode and starting execution.
          await this.agentHost.runtime.waitForPromptIdle(parsed.sessionExternalId)
          const modeId =
            typeof parsed.modeId === 'string' && parsed.modeId ? parsed.modeId : undefined
          if (modeId) {
            await this.agentHost.runtime.setMode({
              ...route,
              sessionId: parsed.sessionExternalId,
              modeId,
            })
          }
          const prompt = await this.promptInput(parsed)
          await this.agentHost.runtime.prompt({
            ...route,
            sessionId: parsed.sessionExternalId,
            // Carried on the prompt as well as set above: the mode this turn
            // must run in is the point of the job, and only reconciling it
            // inside the dispatch guarantees another job cannot change it in
            // between. It costs no round trip once `setMode` has landed.
            ...(modeId ? { desiredConfig: { modeId } } : {}),
            prompt,
            userMessageId: parsed.userMessageId,
          })
          break
        }
        case 'set_model': {
          const route = this.route(parsed, parsed.sessionExternalId)
          await this.agentHost.runtime.setModel({
            ...route,
            sessionId: parsed.sessionExternalId,
            modelId: parsed.modelId,
          })
          this.setLastModelForWorkspace(parsed.workspacePath, providerId, parsed.modelId)
          // A model change rewrites which options are legal, so the remembered
          // values are re-reconciled against the refreshed option list. Ones
          // the new model dropped are pruned rather than attempted.
          const values = this.getConfigValuesForWorkspace(parsed.workspacePath, providerId)
          if (values) await this.agentHost.runtime.applyDesiredConfig(route, { values })
          break
        }
        case 'set_mode':
          await this.agentHost.runtime.setMode({
            ...this.route(parsed, parsed.sessionExternalId),
            sessionId: parsed.sessionExternalId,
            modeId: parsed.modeId,
          })
          break
        case 'set_config_option':
          await this.agentHost.runtime.setConfigOption({
            ...this.route(parsed, parsed.sessionExternalId),
            sessionId: parsed.sessionExternalId,
            configId: parsed.configId,
            value: parsed.value,
          })
          break
        default:
          throw new Error(`Unknown job type: ${job.type}`)
      }

      console.log(`[job-worker] job ${job._id} done`)
      await this.runTrackedMutation('jobs.complete', api.jobs.complete, {
        jobId: job._id,
        status: 'done',
      })
    } catch (err) {
      console.error(`[job-worker] job ${job._id} failed:`, (err as Error).message)
      await this.runTrackedMutation('jobs.complete', api.jobs.complete, {
        jobId: job._id,
        status: 'failed',
        lastError: (err as Error).message,
      })
    }
  }
}
