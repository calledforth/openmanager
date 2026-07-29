import type {
  ExtensionOutcome,
  PermissionCancellationReason,
  ProviderId,
} from '@agentpack/contract'

export const EXTENSION_TIMEOUT_MS = 5 * 60 * 1000
type Pending = {
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  sessionId: string
  method: string
  resolve: (outcome: ExtensionOutcome) => void
  timer: NodeJS.Timeout
}
export type ExtensionSettlement = {
  requestId: string
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  sessionId: string
  method: string
  outcome: ExtensionOutcome
}
export class ExtensionBroker {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly onSettle?: (settlement: ExtensionSettlement) => void) {}
  add(requestId: string, args: Omit<Pending, 'timer'>, timeoutMs = EXTENSION_TIMEOUT_MS): void {
    const timer = setTimeout(
      () => this.settleOne(requestId, { outcome: 'cancelled', reason: 'timeout' }),
      timeoutMs,
    )
    timer.unref?.()
    this.pending.set(requestId, { ...args, timer })
  }
  respond(requestId: string, response: unknown): boolean {
    return this.settleOne(requestId, { outcome: 'responded', response })
  }

  cancelThread(providerId: ProviderId, threadId: string): void {
    this.settle('tool_cancelled', providerId, threadId)
  }

  /** See `PermissionBroker.rekeyThread`: a `create_session` rebind renames the
   * thread every pending record here is tagged with. */
  rekeyThread(
    providerId: ProviderId,
    from: string,
    to: string,
    workspaceId: string | undefined,
  ): void {
    if (from === to) return
    for (const request of this.pending.values()) {
      if (request.providerId !== providerId || request.threadId !== from) continue
      request.threadId = to
      if (workspaceId !== undefined) request.workspaceId = workspaceId
    }
  }

  /** The thread's process is gone. Distinct from `cancelThread`, which reports
   * `tool_cancelled` because a user asked for it. */
  settleThread(providerId: ProviderId, threadId: string): void {
    this.settle('session_closed', providerId, threadId)
  }

  settleProvider(providerId: ProviderId): void {
    this.settle('session_closed', providerId)
  }

  settleAll(): void {
    this.settle('runtime_disposed')
  }
  private settle(
    reason: PermissionCancellationReason,
    providerId?: ProviderId,
    threadId?: string,
  ): void {
    for (const [id, request] of this.pending) {
      if (providerId && request.providerId !== providerId) continue
      if (threadId && request.threadId !== threadId) continue
      this.settleOne(id, { outcome: 'cancelled', reason })
    }
  }
  private settleOne(requestId: string, outcome: ExtensionOutcome): boolean {
    const request = this.pending.get(requestId)
    if (!request) return false
    clearTimeout(request.timer)
    this.pending.delete(requestId)
    request.resolve(outcome)
    this.onSettle?.({
      requestId,
      providerId: request.providerId,
      threadId: request.threadId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      method: request.method,
      outcome,
    })
    return true
  }
}
