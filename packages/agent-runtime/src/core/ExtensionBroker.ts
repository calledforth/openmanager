import type { ExtensionOutcome, PermissionCancellationReason, ProviderId } from '@agentpack/contract'
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
  add(requestId: string, args: Omit<Pending, 'timer'>): void {
    const timer = setTimeout(
      () => this.settleOne(requestId, { outcome: 'cancelled', reason: 'timeout' }),
      EXTENSION_TIMEOUT_MS,
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
