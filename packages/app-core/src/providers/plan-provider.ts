import { createContext, useContext } from 'react'
import type { PlanPhase, PlanReviewOutcome, PlanTodo } from '@agentpack/contract'
export interface PlanRow {
  requestId: string
  name?: string
  overview?: string
  markdown: string
  todos: PlanTodo[]
  phases?: PlanPhase[]
  status: string
  resolutionReason?: string
  createdAt: number
  updatedAt: number
}

export interface PlanStateValue {
  activeSessionId: string | null
  pendingPlan: PlanRow | null
  latestPlan: PlanRow | null
  planHistory: PlanRow[]
  selectedPlan: PlanRow | null
  selectPlan: (requestId: string) => void
  /** Composer plan chip expanded to show the full plan body. */
  isExpanded: boolean
  expandPlan: () => void
  collapsePlan: () => void
  resolvePlan: (outcome: PlanReviewOutcome) => Promise<void>
  /** Registered by MessageInput so Build runs the same accept + mode-switch
   * + build-prompt flow from the composer chip. */
  setBuildHandler: (handler: (() => void | Promise<void>) | null) => void
  /** Build the pending plan through the registered handler (falls back to a
   * plain accept when nothing is registered). */
  buildPendingPlan: () => Promise<void>
  isBuilding: boolean
}

export const PlanStateContext = createContext<PlanStateValue | null>(null)

export function usePlanState() {
  const ctx = useContext(PlanStateContext)
  if (!ctx) throw new Error('usePlanState must be used within PlanStateProvider')
  return ctx
}

/** Safe variant for components also rendered outside the provider (e.g. Storybook). */
export function usePlanStateOptional() {
  return useContext(PlanStateContext)
}
