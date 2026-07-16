import type {
  AgentEvent,
  PermissionRequest,
  PromptCapabilities,
  ProviderId,
} from '@agentpack/contract'
import { AgentRuntime, type HostLogEntry } from '@agentpack/runtime'
import type { BrowserWindow } from 'electron'
import type { SidecarHandshake, SidecarStatus } from '@openmanager/shared/contracts/sidecar'
import { ConvexProjector } from './convex-projector'

export class AgentHost {
  readonly runtime: AgentRuntime
  private readonly statusByProvider = new Map<ProviderId, SidecarStatus>()
  private readonly promptCapabilitiesByProvider = new Map<ProviderId, PromptCapabilities>()
  private localSequence = 0
  private readonly pendingPermissions = new Map<string, PermissionRequest>()

  constructor(
    readonly projector: ConvexProjector,
    private readonly getMainWindow: () => BrowserWindow | null,
  ) {
    this.runtime = new AgentRuntime({
      emitEvent: (event) => this.emitEvent(event),
      log: (entry) => this.log(entry),
      onSessionTitle: ({ threadId, workspaceId, title }) =>
        this.projector.updateSessionTitle(threadId, workspaceId, title),
    })
  }

  async ensureProvider(
    providerId: ProviderId,
    cwd: string,
    threadId = `desktop-bootstrap:${providerId}`,
  ): Promise<SidecarHandshake> {
    this.setStatus(providerId, 'starting')
    try {
      await this.runtime.start({ providerId, threadId, workspaceId: cwd, cwd })
      this.setStatus(providerId, 'healthy')
      return { ready: true }
    } catch (error) {
      this.setStatus(providerId, 'crashed')
      throw error
    }
  }

  getStatuses(): Partial<Record<ProviderId, SidecarStatus>> {
    return Object.fromEntries(this.statusByProvider) as Partial<Record<ProviderId, SidecarStatus>>
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
    approved: boolean
  }): void {
    const request = this.pendingPermissions.get(args.requestId)
    if (!request) throw new Error('Permission request not found or already resolved')
    const preferredKinds = args.approved
      ? (['allow_once', 'allow_always'] as const)
      : (['reject_once', 'reject_always'] as const)
    const option =
      preferredKinds
        .map((kind) => request.options.find((candidate) => candidate.kind === kind))
        .find(Boolean) ?? request.options[0]
    if (!option) throw new Error('Permission request has no response options')
    this.runtime.respondPermission({
      providerId: args.providerId,
      requestId: args.requestId,
      outcome: { outcome: 'selected', optionId: option.optionId },
    })
    this.pendingPermissions.delete(args.requestId)
    this.projector.resolvePermission(args.threadId, args.requestId)
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

  dispose(): void {
    this.runtime.dispose()
    for (const providerId of this.statusByProvider.keys()) this.setStatus(providerId, 'stopped')
  }

  private emitEvent(event: AgentEvent): void {
    if (event.event === 'initialized' && event.data.promptCapabilities) {
      this.promptCapabilitiesByProvider.set(event.providerId, event.data.promptCapabilities)
    }
    if (event.event === 'permission_request') {
      this.pendingPermissions.set(event.data.requestId, event.data)
    }
    this.projector.consume(event)
    const window = this.getMainWindow()
    if (window?.isDestroyed() !== false) return
    window.webContents.send('acp:event', event)
    if (
      event.category === 'stream' ||
      event.category === 'tool' ||
      event.event === 'prompt_started' ||
      event.event === 'prompt_completed' ||
      event.event === 'rpc_error' ||
      event.event === 'runtime_error' ||
      event.event === 'process_exited'
    ) {
      window.webContents.send('stream:token', event)
    }
    if (event.event === 'process_exited') {
      this.setStatus(event.providerId, event.data.expected ? 'stopped' : 'crashed')
    }
  }

  private setStatus(providerId: ProviderId, status: SidecarStatus): void {
    if (this.statusByProvider.get(providerId) === status) return
    this.statusByProvider.set(providerId, status)
    const window = this.getMainWindow()
    if (window?.isDestroyed() === false) {
      window.webContents.send('agent:status-changed', { providerId, status })
    }
  }

  private log(entry: HostLogEntry): void {
    const prefix = `[${entry.scope}] ${entry.message}`
    if (entry.level === 'error') console.error(prefix, entry.data ?? '')
    else if (entry.level === 'warn') console.warn(prefix, entry.data ?? '')
    else console.log(prefix, entry.data ?? '')
  }
}
