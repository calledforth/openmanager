import { ConvexClient } from 'convex/browser'
import { api } from '@openmanager/convex/_generated/api'
import type { Id } from '@openmanager/convex/_generated/dataModel'
import {
  isProviderId,
  type PromptAttachment,
  type PromptInput,
  type ProviderId,
} from '@agentpack/contract'
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

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export class JobWorker {
  private unsubscribe: (() => void) | null = null
  private processing = new Set<string>()

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

  private async applyConfigValues(
    parsed: Record<string, any>,
    threadId: string,
    sessionId: string,
    values: SessionConfigValues | undefined,
  ): Promise<void> {
    if (!values) return
    const route = this.route(parsed, threadId)
    for (const [configId, value] of Object.entries(values)) {
      try {
        await this.agentHost.runtime.setConfigOption({
          ...route,
          sessionId,
          configId,
          value,
        })
      } catch (error) {
        // Config availability is model-specific. A remembered setting may no
        // longer exist after an agent or model update, so restore the valid
        // options and leave stale ones non-fatal.
        console.warn(`[job-worker] failed to apply config ${configId}: ${(error as Error).message}`)
      }
    }
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
        console.log(`[job-worker] ${jobs.length} pending job(s)`)
        for (const job of jobs as JobDoc[]) {
          if (!this.processing.has(job._id)) {
            this.processing.add(job._id)
            this.processJob(job).finally(() => this.processing.delete(job._id))
          }
        }
      },
    )
    this.unsubscribe = unsub
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    recordConvexTelemetry({
      source: 'main',
      kind: 'subscription',
      phase: 'unsubscribe',
      name: 'jobs.listPending',
      requestBytes: estimateConvexPayloadBytes({ clientId: this.clientId }),
    })
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
          await this.agentHost.runtime.ensureSession({
            ...route,
            sessionId: parsed.sessionExternalId,
          })
          // Model selection is provider-global agent state (another session may
          // have changed it since this one was last used), so re-apply the
          // workspace's current selection before every prompt. This is the one
          // sync point that keeps "what the composer shows" and "what the
          // agent runs" identical, for prompts from any device.
          const preferredModel =
            parsed.preferredModelId ??
            this.getLastModelForWorkspace(parsed.workspacePath, route.providerId)
          if (preferredModel) {
            try {
              await this.agentHost.runtime.setModel({
                ...route,
                sessionId: parsed.sessionExternalId,
                modelId: preferredModel,
              })
            } catch (error) {
              console.warn(
                `[job-worker] failed to apply model ${preferredModel}: ${(error as Error).message}`,
              )
            }
          }
          const preferredConfigValues =
            this.configValues(parsed.preferredConfigValues) ??
            this.getConfigValuesForWorkspace(parsed.workspacePath, route.providerId)
          await this.applyConfigValues(
            parsed,
            parsed.sessionExternalId,
            parsed.sessionExternalId,
            preferredConfigValues,
          )
          await this.agentHost.runtime.prompt({
            ...route,
            sessionId: parsed.sessionExternalId,
            prompt: await this.promptInput(parsed),
            userMessageId: parsed.userMessageId,
          })
          break
        }
        case 'create_session': {
          const threadId = crypto.randomUUID()
          const session = await this.agentHost.runtime.ensureSession(this.route(parsed, threadId))
          const rememberedModel = this.getLastModelForWorkspace(parsed.workspacePath, providerId)
          if (rememberedModel) {
            try {
              await this.agentHost.runtime.setModel({
                ...this.route(parsed, threadId),
                sessionId: session.sessionId,
                modelId: rememberedModel,
              })
            } catch (error) {
              console.warn(
                `[job-worker] failed to apply remembered model ${rememberedModel}: ${(error as Error).message}`,
              )
            }
          }
          await this.applyConfigValues(
            parsed,
            threadId,
            session.sessionId,
            this.getConfigValuesForWorkspace(parsed.workspacePath, providerId),
          )
          await this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.sessionId,
            status: 'idle',
            providerId,
            title: parsed.title,
            clientId: this.clientId,
          })
          break
        }
        case 'start_session_with_message': {
          const threadId = crypto.randomUUID()
          const session = await this.agentHost.runtime.ensureSession(this.route(parsed, threadId))
          const preferredModel =
            parsed.preferredModelId ??
            this.getLastModelForWorkspace(parsed.workspacePath, providerId)
          if (preferredModel) {
            try {
              await this.agentHost.runtime.setModel({
                ...this.route(parsed, threadId),
                sessionId: session.sessionId,
                modelId: preferredModel,
              })
            } catch (error) {
              console.warn(
                `[job-worker] failed to apply model ${preferredModel}: ${(error as Error).message}`,
              )
            }
          }
          if (parsed.preferredModeId) {
            try {
              await this.agentHost.runtime.setMode({
                ...this.route(parsed, threadId),
                sessionId: session.sessionId,
                modeId: parsed.preferredModeId,
              })
            } catch (error) {
              console.warn(
                `[job-worker] failed to apply mode ${parsed.preferredModeId}: ${(error as Error).message}`,
              )
            }
          }
          const preferredConfigValues =
            this.configValues(parsed.preferredConfigValues) ??
            this.getConfigValuesForWorkspace(parsed.workspacePath, providerId)
          await this.applyConfigValues(parsed, threadId, session.sessionId, preferredConfigValues)
          await this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.sessionId,
            status: 'idle',
            providerId,
            title: parsed.title,
            clientId: this.clientId,
          })
          await this.agentHost.runtime.prompt({
            ...this.route(parsed, threadId),
            sessionId: session.sessionId,
            prompt: await this.promptInput(parsed),
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
        case 'delete_session': {
          const capabilities = this.agentHost.runtime.getProvider(providerId).capabilities
          if (capabilities.canDeleteSession) {
            throw new Error(
              `Provider ${providerId} advertises session deletion without a runtime operation`,
            )
          }
          this.agentHost.emitSessionDeleted({
            providerId,
            threadId: parsed.sessionExternalId,
            workspacePath: parsed.workspacePath,
            sessionId: parsed.sessionExternalId,
          })
          await this.agentHost.projector.waitForThread(parsed.sessionExternalId)
          break
        }
        case 'resolve_permission':
          this.agentHost.respondPermission({
            providerId,
            threadId: parsed.sessionExternalId,
            requestId: parsed.permissionId,
            approved: parsed.approved,
          })
          break
        case 'set_model':
          await this.agentHost.runtime.setModel({
            ...this.route(parsed, parsed.sessionExternalId),
            sessionId: parsed.sessionExternalId,
            modelId: parsed.modelId,
          })
          this.setLastModelForWorkspace(parsed.workspacePath, providerId, parsed.modelId)
          await this.applyConfigValues(
            parsed,
            parsed.sessionExternalId,
            parsed.sessionExternalId,
            this.getConfigValuesForWorkspace(parsed.workspacePath, providerId),
          )
          break
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
