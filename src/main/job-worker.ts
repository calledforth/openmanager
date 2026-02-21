import { ConvexClient } from 'convex/browser'
import { api } from '@convex/_generated/api'
import { OpenCodeClient, type OcSession } from '@shared/lib/opencode-client'
import type { Id } from '@convex/_generated/dataModel'

type JobDoc = {
  _id: Id<'pending_jobs'>
  type: string
  payload: string
  status: string
}

export class JobWorker {
  private unsubscribe: (() => void) | null = null
  private processing = new Set<string>()
  private machineId: string

  constructor(
    private convex: ConvexClient,
    private getClient: (workspacePath: string) => OpenCodeClient | null,
  ) {
    this.machineId = `machine-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  start(): void {
    console.log('[job-worker] subscribing to pending jobs')
    const unsub = this.convex.onUpdate(api.jobs.listPending, {}, (jobs) => {
      if (!jobs) return
      console.log(`[job-worker] ${jobs.length} pending job(s)`)
      for (const job of jobs as JobDoc[]) {
        if (!this.processing.has(job._id)) {
          this.processing.add(job._id)
          this.processJob(job).finally(() => this.processing.delete(job._id))
        }
      }
    })
    this.unsubscribe = unsub
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async processJob(job: JobDoc): Promise<void> {
    console.log(`[job-worker] claiming job ${job._id} type=${job.type}`)
    const claimed = await this.convex.mutation(api.jobs.claim, {
      jobId: job._id,
      machineId: this.machineId,
    })
    if (!claimed) {
      console.log(`[job-worker] job ${job._id} already claimed`)
      return
    }

    try {
      const parsed = JSON.parse(job.payload)
      const client = this.getClient(parsed.workspacePath)
      if (!client) throw new Error(`No active sidecar for workspace: ${parsed.workspacePath}`)

      switch (job.type) {
        case 'send_message':
          await client.sendMessageAsync(parsed.sessionExternalId, parsed.content)
          break
        case 'create_session': {
          const session: OcSession = await client.createSession(parsed.title)
          await this.convex.action(api.streaming.updateSessionStatus, {
            workspacePath: parsed.workspacePath,
            externalId: session.id,
            status: session.status ?? 'idle',
            title: session.title,
          })
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
        default:
          throw new Error(`Unknown job type: ${job.type}`)
      }

      console.log(`[job-worker] job ${job._id} done`)
      await this.convex.mutation(api.jobs.complete, { jobId: job._id, status: 'done' })
    } catch (err) {
      console.error(`[job-worker] job ${job._id} failed:`, (err as Error).message)
      await this.convex.mutation(api.jobs.complete, {
        jobId: job._id,
        status: 'failed',
        lastError: (err as Error).message,
      })
    }
  }
}
