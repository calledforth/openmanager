import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PlanReviewOutcome } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useActiveThreadState } from '@openmanager/app-core/providers/active-thread-provider'

import {
  PlanStateContext,
  type PlanRow,
  type PlanStateValue,
} from '@openmanager/app-core/providers/plan-provider'
export * from '@openmanager/app-core/providers/plan-provider'

export function PlanStateProvider({ children }: { children: ReactNode }) {
  const { activeSessionId } = useSessionState()
  const { resolvePlan: resolveSessionPlan } = useActiveThreadState()
  const [isExpanded, setIsExpanded] = useState(false)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [isBuilding, setIsBuilding] = useState(false)
  const buildHandlerRef = useRef<(() => void | Promise<void>) | null>(null)
  const buildingRequestRef = useRef<string | null>(null)
  const buildUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoExpandedRequestRef = useRef<string | null>(null)

  const queriedPlanHistory = useTrackedQuery(
    'plans.listForSession',
    api.plans.listForSession,
    activeSessionId ? { sessionExternalId: activeSessionId } : 'skip',
  ) as PlanRow[] | undefined
  const planHistory = useMemo(() => queriedPlanHistory ?? [], [queriedPlanHistory])
  const pendingPlan = planHistory.find((plan) => plan.status === 'pending') ?? null
  const latestPlan = planHistory[0] ?? null
  const selectedPlan =
    planHistory.find((plan) => plan.requestId === selectedRequestId) ?? pendingPlan ?? latestPlan

  const expandPlan = useCallback(() => setIsExpanded(true), [])
  const collapsePlan = useCallback(() => setIsExpanded(false), [])

  useEffect(() => {
    setSelectedRequestId(null)
    setIsExpanded(false)
    autoExpandedRequestRef.current = null
  }, [activeSessionId])

  // A freshly ready plan expands the composer chip once so the user sees it;
  // collapsing stays collapsed for that plan.
  const pendingRequestId = pendingPlan?.requestId ?? null
  useEffect(() => {
    if (pendingRequestId && autoExpandedRequestRef.current !== pendingRequestId) {
      autoExpandedRequestRef.current = pendingRequestId
      setSelectedRequestId(pendingRequestId)
      setIsExpanded(true)
    }
  }, [pendingRequestId])

  // Keep Build locked until the reviewed request leaves the pending state.
  // A safety timeout makes the action retryable if a queued desktop job fails
  // before Cursor can acknowledge the response.
  useEffect(() => {
    const buildingRequestId = buildingRequestRef.current
    if (buildingRequestId && pendingRequestId !== buildingRequestId) {
      buildingRequestRef.current = null
      if (buildUnlockTimerRef.current) clearTimeout(buildUnlockTimerRef.current)
      buildUnlockTimerRef.current = null
      setIsBuilding(false)
    }
  }, [pendingRequestId])

  useEffect(
    () => () => {
      if (buildUnlockTimerRef.current) clearTimeout(buildUnlockTimerRef.current)
    },
    [],
  )

  const resolvePlan = useCallback(
    async (outcome: PlanReviewOutcome) => {
      if (!activeSessionId || !pendingPlan) return
      await resolveSessionPlan(activeSessionId, pendingPlan.requestId, outcome)
    },
    [activeSessionId, pendingPlan, resolveSessionPlan],
  )

  const setBuildHandler = useCallback((handler: (() => void | Promise<void>) | null) => {
    buildHandlerRef.current = handler
  }, [])

  const buildPendingPlan = useCallback(async () => {
    if (buildingRequestRef.current || !pendingPlan) return
    const requestId = pendingPlan.requestId
    buildingRequestRef.current = requestId
    setIsBuilding(true)
    try {
      if (buildHandlerRef.current) {
        await buildHandlerRef.current()
      } else {
        await resolvePlan({ outcome: 'accepted' })
      }
      if (buildingRequestRef.current !== requestId) return
      buildUnlockTimerRef.current = setTimeout(() => {
        if (buildingRequestRef.current !== requestId) return
        buildingRequestRef.current = null
        buildUnlockTimerRef.current = null
        setIsBuilding(false)
      }, 15_000)
    } catch (error) {
      if (buildingRequestRef.current === requestId) {
        buildingRequestRef.current = null
        setIsBuilding(false)
      }
      throw error
    }
  }, [pendingPlan, resolvePlan])

  const selectPlan = useCallback((requestId: string) => setSelectedRequestId(requestId), [])

  const value = useMemo<PlanStateValue>(
    () => ({
      activeSessionId,
      pendingPlan,
      latestPlan,
      planHistory,
      selectedPlan,
      selectPlan,
      isExpanded,
      expandPlan,
      collapsePlan,
      resolvePlan,
      setBuildHandler,
      buildPendingPlan,
      isBuilding,
    }),
    [
      activeSessionId,
      pendingPlan,
      latestPlan,
      planHistory,
      selectedPlan,
      selectPlan,
      isExpanded,
      expandPlan,
      collapsePlan,
      resolvePlan,
      setBuildHandler,
      buildPendingPlan,
      isBuilding,
    ],
  )

  return <PlanStateContext.Provider value={value}>{children}</PlanStateContext.Provider>
}
