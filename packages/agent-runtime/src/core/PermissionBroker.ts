import type {
  PermissionCancellationReason,
  PermissionOption,
  PermissionOutcome,
  ProviderId,
} from '@agentpack/contract'
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000
type ProtocolResponse = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}
type Pending = {
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  sessionId: string
  options: PermissionOption[]
  resolve: (value: ProtocolResponse) => void
  timer: NodeJS.Timeout
}
export type PermissionSettlement = {
  requestId: string
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  sessionId: string
  outcome: PermissionOutcome
}
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly onSettle?: (settlement: PermissionSettlement) => void) {}
  add(requestId: string, args: Omit<Pending, 'timer'>): void {
    const timer = setTimeout(
      () => this.respond(requestId, { outcome: 'cancelled', reason: 'timeout' }),
      PERMISSION_TIMEOUT_MS,
    )
    timer.unref?.()
    this.pending.set(requestId, { ...args, timer })
  }
  respond(requestId: string, outcome: PermissionOutcome): boolean {
    const request = this.pending.get(requestId)
    if (!request) return false
    if (
      outcome.outcome === 'selected' &&
      !request.options.some((option) => option.optionId === outcome.optionId)
    )
      throw new Error(`Invalid permission optionId: ${outcome.optionId}`)
    clearTimeout(request.timer)
    this.pending.delete(requestId)
    request.resolve(
      outcome.outcome === 'selected' ? { outcome } : { outcome: { outcome: 'cancelled' } },
    )
    this.settled(requestId, request, outcome)
    return true
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
      clearTimeout(request.timer)
      this.pending.delete(id)
      request.resolve({ outcome: { outcome: 'cancelled' } })
      this.settled(id, request, { outcome: 'cancelled', reason })
    }
  }
  private settled(requestId: string, request: Pending, outcome: PermissionOutcome): void {
    this.onSettle?.({
      requestId,
      providerId: request.providerId,
      threadId: request.threadId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      outcome,
    })
  }
}
