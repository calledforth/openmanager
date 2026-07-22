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
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'

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

interface PlanStateValue {
  activeSessionId: string | null
  pendingPlan: PlanRow | null
  latestPlan: PlanRow | null
  planHistory: PlanRow[]
  selectedPlan: PlanRow | null
  selectPlan: (requestId: string) => void
  isPanelOpen: boolean
  openPanel: () => void
  closePanel: () => void
  resolvePlan: (outcome: PlanReviewOutcome) => Promise<void>
  /** Registered by MessageInput so the panel's Build button runs the same
   * accept + mode-switch + build-prompt flow as the composer pill. */
  setBuildHandler: (handler: (() => void | Promise<void>) | null) => void
  /** Build the pending plan through the registered handler (falls back to a
   * plain accept when nothing is registered). */
  buildPendingPlan: () => Promise<void>
  isBuilding: boolean
}

const PlanStateContext = createContext<PlanStateValue | null>(null)

export function usePlanState() {
  const ctx = useContext(PlanStateContext)
  if (!ctx) throw new Error('usePlanState must be used within PlanStateProvider')
  return ctx
}

/** Safe variant for components also rendered outside the provider (e.g. Storybook). */
export function usePlanStateOptional() {
  return useContext(PlanStateContext)
}

export function PlanStateProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [isBuilding, setIsBuilding] = useState(false)
  const buildHandlerRef = useRef<(() => void | Promise<void>) | null>(null)
  const buildingRequestRef = useRef<string | null>(null)
  const buildUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoOpenedRequestRef = useRef<string | null>(null)

  const queriedPlanHistory = useTrackedQuery(
    'plans.listForSession',
    api.plans.listForSession,
    ui.activeSessionId ? { sessionExternalId: ui.activeSessionId } : 'skip',
  ) as PlanRow[] | undefined
  const planHistory = useMemo(() => queriedPlanHistory ?? [], [queriedPlanHistory])
  const pendingPlan = planHistory.find((plan) => plan.status === 'pending') ?? null
  const latestPlan = planHistory[0] ?? null
  const selectedPlan =
    planHistory.find((plan) => plan.requestId === selectedRequestId) ?? pendingPlan ?? latestPlan

  const openPanel = useCallback(() => setIsPanelOpen(true), [])
  const closePanel = useCallback(() => setIsPanelOpen(false), [])

  useEffect(() => {
    setSelectedRequestId(null)
    setIsPanelOpen(false)
    autoOpenedRequestRef.current = null
  }, [ui.activeSessionId])

  // A freshly ready plan opens the panel once so the user immediately sees it;
  // closing it stays closed for that plan.
  const pendingRequestId = pendingPlan?.requestId ?? null
  useEffect(() => {
    if (pendingRequestId && autoOpenedRequestRef.current !== pendingRequestId) {
      autoOpenedRequestRef.current = pendingRequestId
      setSelectedRequestId(pendingRequestId)
      setIsPanelOpen(true)
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
      if (!ui.activeSessionId || !pendingPlan) return
      await ui.resolvePlan(ui.activeSessionId, pendingPlan.requestId, outcome)
    },
    [ui, pendingPlan],
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
      activeSessionId: ui.activeSessionId,
      pendingPlan,
      latestPlan,
      planHistory,
      selectedPlan,
      selectPlan,
      isPanelOpen,
      openPanel,
      closePanel,
      resolvePlan,
      setBuildHandler,
      buildPendingPlan,
      isBuilding,
    }),
    [
      ui.activeSessionId,
      pendingPlan,
      latestPlan,
      planHistory,
      selectedPlan,
      selectPlan,
      isPanelOpen,
      openPanel,
      closePanel,
      resolvePlan,
      setBuildHandler,
      buildPendingPlan,
      isBuilding,
    ],
  )

  return <PlanStateContext.Provider value={value}>{children}</PlanStateContext.Provider>
}
