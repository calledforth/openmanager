import type {
  PlanDocument,
  PlanReviewOutcome,
  PlanTodo,
  Question,
  QuestionOutcome,
  SubtaskStatus,
  SubtaskUpdate,
  ToolCall,
  ToolCallStatus,
  ToolCallUpdate,
} from '@agentpack/contract'

export type ExtensionRequestHandler = (params: unknown) => unknown | Promise<unknown>
export type ExtensionNotificationHandler = (params: unknown) => void | Promise<void>
export type QuestionAdapter = {
  /** Extract structured questions from the wire params; undefined falls back to
   * plain extension-request handling. */
  parse: (params: unknown) => { title?: string; questions: Question[] } | undefined
  /** Build the provider-native wire response from the user's outcome. */
  respond: (outcome: QuestionOutcome, params: unknown) => unknown
}
export type PlanAdapter = {
  /** Extract the plan document from the wire params; undefined falls back to
   * plain extension-request handling. */
  parse: (params: unknown) => Omit<PlanDocument, 'requestId' | 'sessionId'> | undefined
  /** Build the provider-native wire response from the user's review outcome. */
  respond: (outcome: PlanReviewOutcome, params: unknown) => unknown
}
export type PlanSnapshot = { todos: PlanTodo[]; merge: boolean }
export type SubtaskToolContext = {
  phase: 'call' | 'update'
  /** The toolCallId was already classified as a subtask by an earlier event. */
  tracked: boolean
}
export type SubtaskAdapter = {
  /** Classify a tool call as a delegated child-agent task and map it to a
   * SubtaskUpdate. A non-undefined return claims the toolCallId: its raw tool
   * events are suppressed and every later update is routed back through here. */
  fromToolCall?: (
    tool: ToolCall | ToolCallUpdate,
    context: SubtaskToolContext,
  ) => SubtaskUpdate | undefined
  /** Extension methods carrying subtask metadata (e.g. cursor/task). The parsed
   * update is emitted and, for requests, the wire is acked `{}` immediately. */
  fromExtension?: Record<string, (params: unknown) => SubtaskUpdate | undefined>
}
export const subtaskStatusFromTool = (status?: ToolCallStatus): SubtaskStatus | undefined => {
  if (!status) return undefined
  if (status === 'pending') return 'pending'
  if (status === 'in_progress') return 'running'
  return status
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
  /** Blocking requests surfaced as reviewable plan documents (respondPlan).
   * Implicitly deferred. */
  plans?: Record<string, PlanAdapter>
  /** Requests carrying a todo snapshot; the parsed snapshot is emitted as a
   * plan_update and the request is acked `{}` immediately. */
  planSnapshots?: Record<string, (params: unknown) => PlanSnapshot | undefined>
}
export class ExtensionRegistry {
  constructor(private readonly handlers: ExtensionHandlers = {}) {}
  isDeferred(method: string): boolean {
    return this.handlers.deferred?.includes(method) ?? false
  }
  questionAdapter(method: string): QuestionAdapter | undefined {
    return this.handlers.questions?.[method]
  }
  planAdapter(method: string): PlanAdapter | undefined {
    return this.handlers.plans?.[method]
  }
  planSnapshot(method: string): ((params: unknown) => PlanSnapshot | undefined) | undefined {
    return this.handlers.planSnapshots?.[method]
  }
  async request(method: string, params: unknown): Promise<unknown> {
    return this.handlers.requests?.[method]?.(params) ?? { outcome: { outcome: 'cancelled' } }
  }
  async notification(method: string, params: unknown): Promise<void> {
    await this.handlers.notifications?.[method]?.(params)
  }
}
