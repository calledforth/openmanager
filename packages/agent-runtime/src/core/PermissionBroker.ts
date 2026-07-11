import type { PermissionOption, PermissionOutcome, ProviderId } from '@agentpack/contract'
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000
type ProtocolResponse = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}
type Pending = {
  providerId: ProviderId
  threadId: string
  options: PermissionOption[]
  resolve: (value: ProtocolResponse) => void
  timer: NodeJS.Timeout
}
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>()
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
    return true
  }
  cancelThread(providerId: ProviderId, threadId: string): void {
    this.settle(providerId, threadId)
  }
  settleProvider(providerId: ProviderId): void {
    this.settle(providerId)
  }
  settleAll(): void {
    this.settle()
  }
  private settle(providerId?: ProviderId, threadId?: string): void {
    for (const [id, request] of this.pending) {
      if (providerId && request.providerId !== providerId) continue
      if (threadId && request.threadId !== threadId) continue
      clearTimeout(request.timer)
      this.pending.delete(id)
      request.resolve({ outcome: { outcome: 'cancelled' } })
    }
  }
}
