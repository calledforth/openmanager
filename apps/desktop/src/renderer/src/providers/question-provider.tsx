import { useCallback, type ReactNode } from 'react'
import type { QuestionOutcome } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useActiveThreadState } from '@openmanager/app-core/providers/active-thread-provider'
import {
  QuestionStateProvider,
  type PendingQuestion,
} from '@openmanager/app-core/providers/question-provider'
export {
  useQuestionState,
  useQuestionStateOptional,
} from '@openmanager/app-core/providers/question-provider'

/** The pending question row from Convex, answered through the active thread. */
export function DesktopQuestionStateProvider({ children }: { children: ReactNode }) {
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

  return (
    <QuestionStateProvider
      activeSessionId={activeSessionId}
      pendingQuestion={pendingQuestion}
      resolveQuestion={resolveQuestion}
    >
      {children}
    </QuestionStateProvider>
  )
}
