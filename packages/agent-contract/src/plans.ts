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

export type PlanDocument = {
  requestId: string
  sessionId: string
  name?: string
  overview?: string
  markdown: string
  todos: PlanTodo[]
  phases?: PlanPhase[]
}

export type PlanReviewOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason?: string }
  | { outcome: 'cancelled'; reason?: PermissionCancellationReason }
