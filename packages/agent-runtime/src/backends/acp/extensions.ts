import type { Question, QuestionOutcome } from '@agentpack/contract'

export type ExtensionRequestHandler = (params: unknown) => unknown | Promise<unknown>
export type ExtensionNotificationHandler = (params: unknown) => void | Promise<void>
export type QuestionAdapter = {
  /** Extract structured questions from the wire params; undefined falls back to
   * plain extension-request handling. */
  parse: (params: unknown) => { title?: string; questions: Question[] } | undefined
  /** Build the provider-native wire response from the user's outcome. */
  respond: (outcome: QuestionOutcome, params: unknown) => unknown
}
export type ExtensionHandlers = {
  requests?: Record<string, ExtensionRequestHandler>
  notifications?: Record<string, ExtensionNotificationHandler>
  /** Request methods held open for a UI answer (respondExtension). The registered
   * request handler (if any) supplies the response when the wait is cancelled.
   * Question-adapter methods are implicitly deferred. */
  deferred?: string[]
  /** Request methods surfaced as structured questions (respondQuestion). */
  questions?: Record<string, QuestionAdapter>
}
export class ExtensionRegistry {
  constructor(private readonly handlers: ExtensionHandlers = {}) {}
  isDeferred(method: string): boolean {
    return this.handlers.deferred?.includes(method) ?? false
  }
  questionAdapter(method: string): QuestionAdapter | undefined {
    return this.handlers.questions?.[method]
  }
  async request(method: string, params: unknown): Promise<unknown> {
    return this.handlers.requests?.[method]?.(params) ?? { outcome: { outcome: 'cancelled' } }
  }
  async notification(method: string, params: unknown): Promise<void> {
    await this.handlers.notifications?.[method]?.(params)
  }
}
