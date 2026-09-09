import { useCallback, useMemo, useState } from 'react'
import type { Question, QuestionOutcome } from '@agentpack/contract'
import type { PendingQuestion } from '../../providers/question-provider'
import {
  allAnswered,
  buildAnswers,
  draftFor,
  firstUnansweredIndex,
  isAnswered,
  toggleOption,
  type QuestionDraft,
} from './questionFlow'

export interface QuestionFlow {
  questions: Question[]
  /** Current slide; equals `questions.length` on the review slide. */
  index: number
  /** +1 forward, -1 back — drives which way the slide animates in. */
  direction: number
  drafts: Record<string, QuestionDraft>
  question: Question | undefined
  onReview: boolean
  hasReview: boolean
  lastIndex: number
  /** Free text for the current question — the composer is bound to this. */
  text: string
  submitting: boolean
  complete: boolean
  /** Whether the primary action (Next/Submit) is available right now. */
  canAdvance: boolean
  setText: (next: string) => void
  pick: (question: Question, optionId: string) => void
  goTo: (index: number) => void
  advance: () => void
  skip: () => void
}

interface FlowState {
  requestId: string
  drafts: Record<string, QuestionDraft>
  index: number
  direction: number
}

const initial = (requestId: string): FlowState => ({
  requestId,
  drafts: {},
  index: 0,
  direction: 1,
})

/** Slide and selection state for a pending question set.
 *
 * It lives here rather than inside the card because the composer *is* the
 * card's free-text field: both need the same drafts and the same notion of
 * which question is on screen. Returns null when nothing is pending, but every
 * hook still runs, so it is safe to call unconditionally.
 */
export function useQuestionFlow(
  pending: PendingQuestion | null,
  onResolve: ((outcome: QuestionOutcome) => void | Promise<void>) | undefined,
): QuestionFlow | null {
  const [state, setState] = useState<FlowState>(() => initial(pending?.requestId ?? ''))
  const [submitting, setSubmitting] = useState(false)

  // A new request resets the flow during render, so the first paint of a new
  // question set can never show the previous one's answers.
  if (pending && state.requestId !== pending.requestId) {
    setState(initial(pending.requestId))
    setSubmitting(false)
  }

  // Stable identity: the empty fallback would otherwise be a fresh array every
  // render and invalidate every callback below it.
  const questions = useMemo(() => pending?.questions ?? [], [pending])
  const hasReview = questions.length > 1
  const lastIndex = hasReview ? questions.length : Math.max(0, questions.length - 1)
  const index = Math.min(state.index, lastIndex)
  const onReview = hasReview && index === questions.length
  const question = onReview ? undefined : questions[index]
  const draft = question ? draftFor(state.drafts, question.questionId) : undefined
  const complete = questions.length > 0 && allAnswered(questions, state.drafts)

  const goTo = useCallback(
    (next: number) => {
      setState((current) => {
        const clamped = Math.max(0, Math.min(lastIndex, next))
        return { ...current, index: clamped, direction: clamped >= current.index ? 1 : -1 }
      })
    },
    [lastIndex],
  )

  const setText = useCallback(
    (next: string) => {
      if (!question) return
      setState((current) => ({
        ...current,
        drafts: {
          ...current.drafts,
          [question.questionId]: { ...draftFor(current.drafts, question.questionId), text: next },
        },
      }))
    },
    [question],
  )

  const pick = useCallback((target: Question, optionId: string) => {
    setState((current) => ({
      ...current,
      drafts: {
        ...current.drafts,
        [target.questionId]: toggleOption(
          target,
          draftFor(current.drafts, target.questionId),
          optionId,
        ),
      },
    }))
  }, [])

  const submit = useCallback(async () => {
    if (!onResolve || !complete || submitting) return
    setSubmitting(true)
    try {
      await onResolve({ outcome: 'answered', answers: buildAnswers(questions, state.drafts) })
    } finally {
      setSubmitting(false)
    }
  }, [complete, onResolve, questions, state.drafts, submitting])

  const advance = useCallback(() => {
    if (index >= lastIndex) {
      void submit()
      return
    }
    // Leaving the last question jumps to the first gap rather than walking the
    // user forward through slides they already filled in.
    if (hasReview && index === questions.length - 1) {
      const gap = firstUnansweredIndex(questions, state.drafts)
      goTo(gap === -1 ? questions.length : gap)
      return
    }
    goTo(index + 1)
  }, [goTo, hasReview, index, lastIndex, questions, state.drafts, submit])

  const skip = useCallback(() => {
    void onResolve?.({ outcome: 'cancelled', reason: 'user' })
  }, [onResolve])

  if (!pending || questions.length === 0) return null

  return {
    questions,
    index,
    direction: state.direction,
    drafts: state.drafts,
    question,
    onReview,
    hasReview,
    lastIndex,
    text: draft?.text ?? '',
    submitting,
    complete,
    canAdvance: onReview
      ? complete && !submitting
      : question
        ? isAnswered(question, draft!) && !submitting
        : false,
    setText,
    pick,
    goTo,
    advance,
    skip,
  }
}
