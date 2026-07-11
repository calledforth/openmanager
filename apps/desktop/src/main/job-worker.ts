import { ConvexClient } from 'convex/browser'
import { api } from '@openmanager/convex/_generated/api'
import type { Id } from '@openmanager/convex/_generated/dataModel'
import type { ProviderId } from '@agentpack/contract'
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

export class JobWorker {
  private unsubscribe: (() => void) | null = null
  private processing = new Set<string>()

  constructor(
    private convex: ConvexClient,
    private agentHost: AgentHost,
    private clientId: string,
    private getLastModelForWorkspace: (workspacePath: string) => string | null,
    private setLastModelForWorkspace: (workspacePath: string, modelId: string) => void,
  ) {}

  private providerId(value: unknown): ProviderId {
    return value === 'cursor' ? 'cursor' : 'opencode'
  }

  private route(parsed: Record<string, any>, threadId: string) {
    return {
      providerId: this.providerId(parsed.providerId),
      threadId,
      workspaceId: parsed.workspacePath as string,
      cwd: parsed.workspacePath as string,
    }
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
        case 'send_message':
          await this.agentHost.runtime.prompt({
            ...this.route(parsed, parsed.sessionExternalId),
            sessionId: parsed.sessionExternalId,
            prompt: parsed.content,
            userMessageId: parsed.userMessageId,
          })
          break
        case 'create_session': {
          const threadId = crypto.randomUUID()
          const session = await this.agentHost.runtime.ensureSession(this.route(parsed, threadId))
          const rememberedModel = this.getLastModelForWorkspace(parsed.workspacePath)
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
          await this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.sessionId,
            status: 'idle',
            title: parsed.title,
            clientId: this.clientId,
          })
          break
        }
        case 'start_session_with_message': {
          const threadId = crypto.randomUUID()
          const session = await this.agentHost.runtime.ensureSession(this.route(parsed, threadId))
          const preferredModel =
            parsed.preferredModelId ?? this.getLastModelForWorkspace(parsed.workspacePath)
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
          await this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.sessionId,
            status: 'idle',
            title: parsed.title,
            clientId: this.clientId,
          })
          await this.agentHost.runtime.prompt({
            ...this.route(parsed, threadId),
            sessionId: session.sessionId,
            prompt: parsed.content,
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
          this.setLastModelForWorkspace(parsed.workspacePath, parsed.modelId)
          break
        case 'set_mode':
          await this.agentHost.runtime.setMode({
            ...this.route(parsed, parsed.sessionExternalId),
            sessionId: parsed.sessionExternalId,
            modeId: parsed.modeId,
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
