import { useCallback, useMemo, type ReactNode } from 'react'
import type { QuestionOutcome } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'

import {
  QuestionStateContext,
  type PendingQuestion,
  type QuestionStateValue,
} from '@openmanager/app-core/providers/question-provider'
export * from '@openmanager/app-core/providers/question-provider'

export function QuestionStateProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()
  const pendingQuestion =
    (useTrackedQuery(
      'questions.getPendingForSession',
      api.questions.getPendingForSession,
      ui.activeSessionId ? { sessionExternalId: ui.activeSessionId } : 'skip',
    ) as PendingQuestion | null | undefined) ?? null

  const resolveQuestion = useCallback(
    async (outcome: QuestionOutcome) => {
      if (!ui.activeSessionId || !pendingQuestion) return
      await ui.resolveQuestion(ui.activeSessionId, pendingQuestion.requestId, outcome)
    },
    [ui, pendingQuestion],
  )

  const value = useMemo<QuestionStateValue>(
    () => ({
      activeSessionId: ui.activeSessionId,
      pendingQuestion,
      resolveQuestion,
    }),
    [ui.activeSessionId, pendingQuestion, resolveQuestion],
  )

  return <QuestionStateContext.Provider value={value}>{children}</QuestionStateContext.Provider>
}
