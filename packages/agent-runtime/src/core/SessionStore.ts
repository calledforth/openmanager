import type { ProviderId } from '@agentpack/contract'
export type SessionBinding = {
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  sessionId: string
  generation: number
  resumeCursor?: string
}
export class SessionStore {
  private generation = 0
  private readonly byThread = new Map<string, SessionBinding>()
  private readonly bySession = new Map<string, SessionBinding>()
  get currentGeneration(): number {
    return this.generation
  }
  nextGeneration(): number {
    this.clear()
    return ++this.generation
  }
  bind(binding: Omit<SessionBinding, 'generation'>): SessionBinding {
    const value = { ...binding, generation: this.generation }
    const oldSession = this.byThread.get(binding.threadId)
    if (oldSession) this.bySession.delete(oldSession.sessionId)
    const oldThread = this.bySession.get(binding.sessionId)
    if (oldThread) this.byThread.delete(oldThread.threadId)
    this.byThread.set(binding.threadId, value)
    this.bySession.set(binding.sessionId, value)
    return value
  }
  forThread(threadId: string): SessionBinding | undefined {
    const v = this.byThread.get(threadId)
    return v?.generation === this.generation ? v : undefined
  }
  forSession(sessionId: string): SessionBinding | undefined {
    const v = this.bySession.get(sessionId)
    return v?.generation === this.generation ? v : undefined
  }
  setResumeCursor(threadId: string, cursor?: string): void {
    const v = this.forThread(threadId)
    if (v) v.resumeCursor = cursor
  }
  clear(): void {
    this.byThread.clear()
    this.bySession.clear()
  }
  bindings(): SessionBinding[] {
    return [...this.byThread.values()]
  }
}
