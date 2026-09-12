import { useCallback, useMemo, type ReactNode } from 'react'
import type { PlanReviewOutcome } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useActiveThreadState } from '@openmanager/app-core/providers/active-thread-provider'
import { PlanStateProvider, type PlanRow } from '@openmanager/app-core/providers/plan-provider'
export { usePlanState, usePlanStateOptional } from '@openmanager/app-core/providers/plan-provider'

/** The session's plan history from Convex, answered through the active thread. */
export function DesktopPlanStateProvider({ children }: { children: ReactNode }) {
  const { activeSessionId } = useSessionState()
  const { resolvePlan: resolveSessionPlan } = useActiveThreadState()
  const queriedPlanHistory = useTrackedQuery(
    'plans.listForSession',
    api.plans.listForSession,
    activeSessionId ? { sessionExternalId: activeSessionId } : 'skip',
  ) as PlanRow[] | undefined
  const planHistory = useMemo(() => queriedPlanHistory ?? [], [queriedPlanHistory])
  const pendingPlan = planHistory.find((plan) => plan.status === 'pending') ?? null

  const resolvePlan = useCallback(
    async (outcome: PlanReviewOutcome) => {
      if (!activeSessionId || !pendingPlan) return
      await resolveSessionPlan(activeSessionId, pendingPlan.requestId, outcome)
    },
    [activeSessionId, pendingPlan, resolveSessionPlan],
  )

  return (
    <PlanStateProvider
      activeSessionId={activeSessionId}
      planHistory={planHistory}
      resolvePlan={resolvePlan}
    >
      {children}
    </PlanStateProvider>
  )
}
