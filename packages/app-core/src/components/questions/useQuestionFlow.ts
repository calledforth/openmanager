import { useCallback, useMemo, useRef, useState } from 'react'
import type { Question, QuestionOutcome } from '@agentpack/contract'
import type { PendingQuestion } from '../../providers/question-provider'
import {
  allAnswered,
  buildAnswers,
  draftFor,
  isAnswered,
  nextStep,
  toggleOption,
  type QuestionDraft,
} from './questionFlow'

export interface QuestionFlow {
  questions: Question[]
  /** Question on screen. */
  index: number
  /** +1 forward, -1 back — drives which way the slide animates in. */
  direction: number
  drafts: Record<string, QuestionDraft>
  question: Question
  lastIndex: number
  /** Free text for the current question — the composer is bound to this. */
  text: string
  submitting: boolean
  complete: boolean
  /**
   * Why the answers can't be sent just now (the host holds every send), or
   * null while they can. Choosing and moving between questions still work;
   * only sending and dismissing wait.
   */
  heldReason: string | null
  /** Whether the primary action is available right now. */
  canAdvance: boolean
  /** Whether the primary action sends the answers rather than moving on. */
  willSubmit: boolean
  setText: (next: string) => void
  /** Pick an option. Multi-select toggles it and stays; single-select takes it
   * and moves on (or sends, from the last question). */
  choose: (question: Question, optionId: string) => void
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
  heldReason: string | null = null,
): QuestionFlow | null {
  const [state, setState] = useState<FlowState>(() => initial(pending?.requestId ?? ''))
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const held = heldReason !== null

  // A new request resets the flow during render, so the first paint of a new
  // question set can never show the previous one's answers.
  if (pending && state.requestId !== pending.requestId) {
    setState(initial(pending.requestId))
    setSubmitting(false)
  }

  // Stable identity: the empty fallback would otherwise be a fresh array every
  // render and invalidate every callback below it.
  const questions = useMemo(() => pending?.questions ?? [], [pending])
  const lastIndex = Math.max(0, questions.length - 1)
  const index = Math.min(state.index, lastIndex)
  const question = questions[index]
  const draft = question ? draftFor(state.drafts, question.questionId) : undefined
  const complete = questions.length > 0 && allAnswered(questions, state.drafts)

  const goTo = useCallback(
    (next: number) => {
      setState((current) => {
        const clamped = Math.max(0, Math.min(lastIndex, next))
        if (clamped === current.index) return current
        return { ...current, index: clamped, direction: clamped > current.index ? 1 : -1 }
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

  const submit = useCallback(
    async (drafts: Record<string, QuestionDraft>) => {
      if (!onResolve || submittingRef.current) return
      submittingRef.current = true
      setSubmitting(true)
      try {
        await onResolve({ outcome: 'answered', answers: buildAnswers(questions, drafts) })
      } catch {
        // Whoever answers says why it didn't go; the card stays to try again.
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    },
    [onResolve, questions],
  )

  /** Move on from the current question against `drafts` — passed in so an
   * action that has just written a draft never moves on against the old one. */
  const moveOn = useCallback(
    (drafts: Record<string, QuestionDraft>) => {
      const step = nextStep(questions, drafts, index)
      if (step.kind !== 'submit') goTo(step.index)
      // Held, the choice is kept and waits for Submit once it can go.
      else if (!held) void submit(drafts)
    },
    [goTo, held, index, questions, submit],
  )

  const choose = useCallback(
    (target: Question, optionId: string) => {
      const drafts = {
        ...state.drafts,
        [target.questionId]: toggleOption(
          target,
          draftFor(state.drafts, target.questionId),
          optionId,
        ),
      }
      setState((current) => ({ ...current, drafts }))
      if (!target.allowMultiple) moveOn(drafts)
    },
    [moveOn, state.drafts],
  )

  const willSubmit = nextStep(questions, state.drafts, index).kind === 'submit'
  const canAdvance =
    !!question && !!draft && isAnswered(question, draft) && !submitting && !(held && willSubmit)

  const advance = useCallback(() => {
    if (!canAdvance) return
    moveOn(state.drafts)
  }, [canAdvance, moveOn, state.drafts])

  // Dismissing is an answer too, so it waits with the rest.
  const skip = useCallback(() => {
    if (held || !onResolve) return
    void Promise.resolve(onResolve({ outcome: 'cancelled', reason: 'user' })).catch(() => undefined)
  }, [held, onResolve])

  if (!pending || !question) return null

  return {
    questions,
    index,
    direction: state.direction,
    drafts: state.drafts,
    question,
    lastIndex,
    text: draft?.text ?? '',
    submitting,
    complete,
    heldReason,
    canAdvance,
    willSubmit,
    setText,
    choose,
    goTo,
    advance,
    skip,
  }
}
