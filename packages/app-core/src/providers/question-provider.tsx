import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Question, QuestionOutcome } from '@agentpack/contract'
export interface PendingQuestion {
  requestId: string
  title?: string
  questions: Question[]
  createdAt: number
  updatedAt: number
}

export interface QuestionStateValue {
  activeSessionId: string | null
  pendingQuestion: PendingQuestion | null
  resolveQuestion: (outcome: QuestionOutcome) => Promise<void>
}

export const QuestionStateContext = createContext<QuestionStateValue | null>(null)

export function useQuestionState() {
  const ctx = useContext(QuestionStateContext)
  if (!ctx) throw new Error('useQuestionState must be used within QuestionStateProvider')
  return ctx
}

/** Safe variant for components also rendered outside the provider (e.g. Storybook). */
export function useQuestionStateOptional() {
  return useContext(QuestionStateContext)
}

/** Publishes the pending question set the host resolved for the active session. */
export function QuestionStateProvider({
  activeSessionId,
  pendingQuestion,
  resolveQuestion,
  children,
}: {
  activeSessionId: string | null
  pendingQuestion: PendingQuestion | null
  resolveQuestion: (outcome: QuestionOutcome) => Promise<void>
  children: ReactNode
}) {
  const value = useMemo<QuestionStateValue>(
    () => ({ activeSessionId, pendingQuestion, resolveQuestion }),
    [activeSessionId, pendingQuestion, resolveQuestion],
  )
  return <QuestionStateContext.Provider value={value}>{children}</QuestionStateContext.Provider>
}
