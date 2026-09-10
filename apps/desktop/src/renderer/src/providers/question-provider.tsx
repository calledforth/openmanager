import { useCallback, useMemo, type ReactNode } from 'react'
import type { QuestionOutcome } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useActiveThreadState } from '@openmanager/app-core/providers/active-thread-provider'

import {
  QuestionStateContext,
  type PendingQuestion,
  type QuestionStateValue,
} from '@openmanager/app-core/providers/question-provider'
export * from '@openmanager/app-core/providers/question-provider'

export function QuestionStateProvider({ children }: { children: ReactNode }) {
  const { activeSessionId } = useSessionState()
  const { resolveQuestion: resolveSessionQuestion } = useActiveThreadState()
  const pendingQuestion =
    (useTrackedQuery(
      'questions.getPendingForSession',
      api.questions.getPendingForSession,
      activeSessionId ? { sessionExternalId: activeSessionId } : 'skip',
    ) as PendingQuestion | null | undefined) ?? null

  const resolveQuestion = useCallback(
    async (outcome: QuestionOutcome) => {
      if (!activeSessionId || !pendingQuestion) return
      await resolveSessionQuestion(activeSessionId, pendingQuestion.requestId, outcome)
    },
    [activeSessionId, pendingQuestion, resolveSessionQuestion],
  )

  const value = useMemo<QuestionStateValue>(
    () => ({
      activeSessionId,
      pendingQuestion,
      resolveQuestion,
    }),
    [activeSessionId, pendingQuestion, resolveQuestion],
  )

  return <QuestionStateContext.Provider value={value}>{children}</QuestionStateContext.Provider>
}
