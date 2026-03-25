import { ConvexClient } from 'convex/browser'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
import {
  estimateConvexPayloadBytes,
  extractConvexTelemetryContext,
  recordConvexTelemetry,
} from './convex-telemetry'
import type { AgentClient, AgentSession } from './agent-client'

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
    private getClient: (workspacePath: string) => Promise<AgentClient | null>,
    private clientId: string,
    private getLastModelForWorkspace: (workspacePath: string) => string | null,
    private setLastModelForWorkspace: (workspacePath: string, modelId: string) => void,
  ) {}

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
      const client = await this.getClient(parsed.workspacePath)
      if (!client) throw new Error('OpenCode ACP runtime is unavailable')

      switch (job.type) {
        case 'send_message':
          await client.sendMessageAsync(parsed.sessionExternalId, parsed.content)
          break
        case 'create_session': {
          const session: AgentSession = await client.createSession(parsed.title)
          const rememberedModel = this.getLastModelForWorkspace(parsed.workspacePath)
          if (rememberedModel && client.setSessionModel) {
            try {
              await client.setSessionModel(session.id, rememberedModel)
            } catch (error) {
              console.warn(
                `[job-worker] failed to apply remembered model ${rememberedModel}: ${(error as Error).message}`,
              )
            }
          }
          await this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.id,
            status: session.status ?? 'idle',
            title: session.title,
            clientId: this.clientId,
          })
          break
        }
        case 'start_session_with_message': {
          const session: AgentSession = await client.createSession(parsed.title)
          const preferredModel =
            parsed.preferredModelId ?? this.getLastModelForWorkspace(parsed.workspacePath)
          if (preferredModel && client.setSessionModel) {
            try {
              await client.setSessionModel(session.id, preferredModel)
            } catch (error) {
              console.warn(
                `[job-worker] failed to apply model ${preferredModel}: ${(error as Error).message}`,
              )
            }
          }
          if (parsed.preferredModeId && client.setSessionMode) {
            try {
              await client.setSessionMode(session.id, parsed.preferredModeId)
            } catch (error) {
              console.warn(
                `[job-worker] failed to apply mode ${parsed.preferredModeId}: ${(error as Error).message}`,
              )
            }
          }
          await this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.id,
            status: session.status ?? 'idle',
            title: session.title,
            clientId: this.clientId,
          })
          await client.sendMessageAsync(session.id, parsed.content)
          break
        }
        case 'abort':
          await client.abortSession(parsed.sessionExternalId)
          break
        case 'delete_session':
          await client.deleteSession(parsed.sessionExternalId)
          break
        case 'resolve_permission':
          await client.resolvePermission(
            parsed.sessionExternalId,
            parsed.permissionId,
            parsed.approved,
          )
          break
        case 'set_model':
          if (!client.setSessionModel) throw new Error('Session model switching not supported')
          await client.setSessionModel(parsed.sessionExternalId, parsed.modelId)
          this.setLastModelForWorkspace(parsed.workspacePath, parsed.modelId)
          break
        case 'set_mode':
          if (!client.setSessionMode) throw new Error('Session mode switching not supported')
          await client.setSessionMode(parsed.sessionExternalId, parsed.modeId)
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
