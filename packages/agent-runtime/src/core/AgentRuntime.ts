import type {
  AgentEvent,
  CapabilityKey,
  PermissionOutcome,
  PlanReviewOutcome,
  PromptInput,
  ProviderId,
  QuestionOutcome,
} from '@agentpack/contract'
import { AcpBackend } from '../backends/acp/AcpBackend.js'
import type { Backend, BackendEvent, SessionResult } from '../backends/Backend.js'
import type { HostDeps } from '../host.js'
import { providers, type ProviderConfig } from '../providers/index.js'
import { CapabilityMissingError } from './errors.js'

export type RuntimeRoute = {
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  cwd: string
}
export type RuntimeSessionArgs = RuntimeRoute & { sessionId?: string; resumeCursor?: string }

export class AgentRuntime {
  private readonly backends = new Map<ProviderId, Backend>()
  private readonly sequences = new Map<string, number>()
  private readonly threadProviders = new Map<string, ProviderId>()
  private readonly promptQueues = new Map<string, Promise<void>>()
  private readonly activeMessageIds = new Map<string, string>()
  private readonly configs: Readonly<Record<ProviderId, ProviderConfig>>

  constructor(
    private readonly host: HostDeps,
    configs: Readonly<Record<ProviderId, ProviderConfig>> = providers,
  ) {
    this.configs = configs
    for (const config of Object.values(configs)) {
      const backend = new AcpBackend(config, host)
      backend.events((event) => this.forward(config.id, event))
      this.backends.set(config.id, backend)
    }
  }

  getProvider(providerId: ProviderId): ProviderConfig {
    return this.configs[providerId]
  }
  private backend(providerId: ProviderId): Backend {
    const backend = this.backends.get(providerId)
    if (!backend) throw new Error(`Unknown provider: ${providerId}`)
    return backend
  }
  private bindProvider(threadId: string, providerId: ProviderId): void {
    const current = this.threadProviders.get(threadId)
    if (current && current !== providerId)
      throw new Error(`Thread ${threadId} is already bound to provider ${current}`)
    this.threadProviders.set(threadId, providerId)
  }
  private forward(providerId: ProviderId, event: BackendEvent): void {
    const seq = (this.sequences.get(event.threadId) ?? 0) + 1
    this.sequences.set(event.threadId, seq)
    const id = crypto.randomUUID()
    if (event.event === 'prompt_started') {
      this.activeMessageIds.set(event.threadId, `agent_asst_${id}`)
    }
    const messageId = this.activeMessageIds.get(event.threadId)
    this.host.emitEvent({
      ...event,
      id,
      ...(messageId ? { messageId } : {}),
      timestamp: new Date().toISOString(),
      seq,
      providerId,
    } as AgentEvent)
    if (
      event.event === 'prompt_completed' ||
      event.event === 'rpc_error' ||
      event.event === 'runtime_error' ||
      event.event === 'process_exited'
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

  async start(args: RuntimeRoute): Promise<void> {
    this.bindProvider(args.threadId, args.providerId)
    await this.backend(args.providerId).start(args)
  }
  async ensureSession(args: RuntimeSessionArgs): Promise<SessionResult> {
    this.bindProvider(args.threadId, args.providerId)
    if (args.sessionId) this.require(args, 'canLoadSession', 'load session')
    return this.backend(args.providerId).ensureSession(args)
  }
  ensureThreadSession(args: RuntimeSessionArgs): Promise<SessionResult> {
    return this.ensureSession(args)
  }

  async prompt(
    args: RuntimeSessionArgs & { prompt: PromptInput; userMessageId?: string },
  ): Promise<SessionResult> {
    const session = await this.ensureSession(args)
    const key = args.threadId
    const previous = this.promptQueues.get(key) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(() => this.backend(args.providerId).prompt({ ...args, sessionId: session.sessionId }))
    const queued = run.finally(() => {
      if (this.promptQueues.get(key) === queued) this.promptQueues.delete(key)
    })
    this.promptQueues.set(key, queued)
    await run
    return session
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
  async cancel(args: RuntimeRoute & { sessionId: string }): Promise<void> {
    this.require(args, 'canCancelPrompt', 'cancel prompt')
    await this.backend(args.providerId).cancel(args)
  }
  cancelPrompt(args: RuntimeRoute & { sessionId: string }): Promise<void> {
    return this.cancel(args)
  }
  respondPermission(args: {
    providerId: ProviderId
    requestId: string
    outcome: PermissionOutcome
  }): boolean {
    const found = this.backend(args.providerId).respondPermission(args.requestId, args.outcome)
    if (!found) throw new Error('Permission request not found or already resolved')
    return true
  }
  respondExtension(args: {
    providerId: ProviderId
    requestId: string
    response: unknown
  }): boolean {
    const found = this.backend(args.providerId).respondExtension(args.requestId, args.response)
    if (!found) throw new Error('Extension request not found or already resolved')
    return true
  }
  respondQuestion(args: {
    providerId: ProviderId
    requestId: string
    outcome: QuestionOutcome
  }): boolean {
    const found = this.backend(args.providerId).respondQuestion(args.requestId, args.outcome)
    if (!found) throw new Error('Question not found or already resolved')
    return true
  }
  respondPlan(args: {
    providerId: ProviderId
    requestId: string
    outcome: PlanReviewOutcome
  }): boolean {
    const found = this.backend(args.providerId).respondPlan(args.requestId, args.outcome)
    if (!found) throw new Error('Plan review not found or already resolved')
    return true
  }
  async setModel(args: RuntimeRoute & { sessionId: string; modelId: string }): Promise<void> {
    this.require(args, 'canSetModel', 'set model')
    await this.backend(args.providerId).setModel(args)
  }
  setSessionModel(args: RuntimeRoute & { sessionId: string; modelId: string }): Promise<void> {
    return this.setModel(args)
  }
  async setMode(args: RuntimeRoute & { sessionId: string; modeId: string }): Promise<void> {
    this.require(args, 'canSetMode', 'set mode')
    await this.backend(args.providerId).setMode(args)
  }
  setSessionMode(args: RuntimeRoute & { sessionId: string; modeId: string }): Promise<void> {
    return this.setMode(args)
  }
  async setConfigOption(
    args: RuntimeRoute & { sessionId: string; configId: string; value: string | boolean },
  ): Promise<void> {
    this.require(args, 'canSetConfigOption', 'set config option')
    await this.backend(args.providerId).setConfigOption(args)
  }
  setSessionConfigOption(
    args: RuntimeRoute & { sessionId: string; configId: string; value: string | boolean },
  ): Promise<void> {
    return this.setConfigOption(args)
  }
  dispose(): void {
    for (const backend of this.backends.values()) backend.dispose()
    this.promptQueues.clear()
    this.threadProviders.clear()
    this.activeMessageIds.clear()
  }
  disposeAll(): void {
    this.dispose()
  }
}
