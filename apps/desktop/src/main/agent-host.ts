import type {
  AgentEvent,
  PermissionOutcome,
  PermissionRequest,
  PromptCapabilities,
  ProviderId,
  QuestionOutcome,
  QuestionRequest,
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
  private readonly pendingExtensions = new Map<string, { method: string; params: unknown }>()
  private readonly pendingQuestions = new Map<string, QuestionRequest>()

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
    // Map cleanup happens on the extension_resolved event the broker emits.
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
    if (event.event === 'extension_resolved') {
      this.pendingExtensions.delete(event.data.requestId)
      this.pendingQuestions.delete(event.data.requestId)
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
