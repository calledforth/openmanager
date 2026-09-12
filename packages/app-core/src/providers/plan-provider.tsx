import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
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

/** How long Build stays locked after the handler resolves when the host never
 * reports the request leaving the pending state. */
const BUILD_UNLOCK_TIMEOUT_MS = 15_000

/**
 * Owns the review chip's UI state — which revision is shown, whether it is
 * expanded, and the Build lock — over a plan history the host supplies,
 * newest first. `resolvePlan` answers the pending request.
 */
export function PlanStateProvider({
  activeSessionId,
  planHistory,
  resolvePlan,
  children,
}: {
  activeSessionId: string | null
  planHistory: PlanRow[]
  resolvePlan: (outcome: PlanReviewOutcome) => Promise<void>
  children: ReactNode
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [isBuilding, setIsBuilding] = useState(false)
  const buildHandlerRef = useRef<(() => void | Promise<void>) | null>(null)
  const buildingRequestRef = useRef<string | null>(null)
  const buildUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoExpandedRequestRef = useRef<string | null>(null)

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
  // A safety timeout makes the action retryable if the host's job fails
  // before the provider can acknowledge the response.
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
      }, BUILD_UNLOCK_TIMEOUT_MS)
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
