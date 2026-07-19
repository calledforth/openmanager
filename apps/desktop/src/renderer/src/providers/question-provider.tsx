import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Question, QuestionOutcome } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'

export interface PendingQuestion {
  requestId: string
  title?: string
  questions: Question[]
  createdAt: number
  updatedAt: number
}

interface QuestionStateValue {
  activeSessionId: string | null
  pendingQuestion: PendingQuestion | null
  resolveQuestion: (outcome: QuestionOutcome) => Promise<void>
}

const QuestionStateContext = createContext<QuestionStateValue | null>(null)

export function useQuestionState() {
  const ctx = useContext(QuestionStateContext)
  if (!ctx) throw new Error('useQuestionState must be used within QuestionStateProvider')
  return ctx
}

/** Safe variant for components also rendered outside the provider (e.g. Storybook). */
export function useQuestionStateOptional() {
  return useContext(QuestionStateContext)
}

export function QuestionStateProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()
  const pendingQuestion =
    (useTrackedQuery(
      'questions.getPendingForSession',
      (api as any).questions.getPendingForSession,
      ui.activeSessionId ? { sessionExternalId: ui.activeSessionId } : 'skip',
    ) as PendingQuestion | null | undefined) ?? null

  const resolveQuestion = async (outcome: QuestionOutcome) => {
    if (!ui.activeSessionId || !pendingQuestion) return
    await ui.resolveQuestion(ui.activeSessionId, pendingQuestion.requestId, outcome)
  }

  const value = useMemo<QuestionStateValue>(
    () => ({
      activeSessionId: ui.activeSessionId,
      pendingQuestion,
      resolveQuestion,
    }),
    [ui.activeSessionId, pendingQuestion],
  )

  return <QuestionStateContext.Provider value={value}>{children}</QuestionStateContext.Provider>
}
