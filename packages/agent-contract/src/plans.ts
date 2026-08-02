import type { PermissionCancellationReason } from './permissions.js'

export type PlanTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type PlanTodo = {
  id: string
  content: string
  status: PlanTodoStatus
}

export type PlanPhase = {
  name: string
  todos: PlanTodo[]
}

/** What accepting a plan does to the turn that proposed it.
 *
 * - `follow_up_turn`: plan review is a blocking side-channel request, and
 *   answering it *ends* the proposing turn (Cursor's `cursor/create_plan`).
 *   Implementation only happens if the host dispatches a second prompt.
 * - `same_turn`: approval releases the same turn to continue straight into
 *   implementation (Claude Code's `ExitPlanMode` tool call). Dispatching a
 *   follow-up prompt here would run the whole plan a second time, repeating
 *   every edit and command.
 *
 * This lives on the plan document rather than being inferred from the provider
 * id because it is a property of *how the provider asked*, and one provider may
 * eventually ask both ways. */
export type PlanContinuation = 'same_turn' | 'follow_up_turn'

export type PlanDocument = {
  requestId: string
  sessionId: string
  name?: string
  overview?: string
  markdown: string
  todos: PlanTodo[]
  phases?: PlanPhase[]
  continuation: PlanContinuation
}

export type PlanReviewOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason?: string }
  | { outcome: 'cancelled'; reason?: PermissionCancellationReason }
