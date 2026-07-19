import { useState } from 'react'
import type { Question, QuestionOutcome } from '@agentpack/contract'
import { useQuestionStateOptional, type PendingQuestion } from '../../providers/question-provider'
import { typographyCaption, typographyLabelSm } from '../../lib/typography'

const chipBase = `rounded-[var(--basis-chat-shell-radius)] border px-2.5 py-1 ${typographyLabelSm} transition-colors`
const chipIdle = `${chipBase} border-[var(--basis-border)] bg-[var(--basis-surface)] text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]`
const chipSelected = `${chipBase} border-transparent bg-[var(--basis-action-bg)] text-[var(--basis-action-fg)] hover:bg-[var(--basis-action-hover)]`

function QuestionCard({
  pending,
  onResolve,
}: {
  pending: PendingQuestion
  onResolve: (outcome: QuestionOutcome) => void
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const questions = pending.questions
  const isSingleChoice = questions.length === 1 && !questions[0].allowMultiple
  const needsConfirm = !isSingleChoice

  const answerAll = (
    finalSelections: Record<string, string[]>,
    finalCustomAnswers = customAnswers,
  ) => {
    onResolve({
      outcome: 'answered',
      answers: questions.map((question) => ({
        questionId: question.questionId,
        selectedOptionIds: finalSelections[question.questionId] ?? [],
        ...(finalCustomAnswers[question.questionId]?.trim()
          ? { text: finalCustomAnswers[question.questionId].trim() }
          : {}),
      })),
    })
  }

  const toggle = (question: Question, optionId: string) => {
    if (isSingleChoice) {
      answerAll({ [question.questionId]: [optionId] })
      return
    }
    setSelections((current) => {
      const selected = current[question.questionId] ?? []
      const next = question.allowMultiple
        ? selected.includes(optionId)
          ? selected.filter((id) => id !== optionId)
          : [...selected, optionId]
        : [optionId]
      return { ...current, [question.questionId]: next }
    })
  }

  const allAnswered = questions.every(
    (question) =>
      (selections[question.questionId] ?? []).length > 0 ||
      Boolean(customAnswers[question.questionId]?.trim()),
  )

  return (
    <div className="mb-1.5 overflow-hidden rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className={`${typographyLabelSm} text-[var(--basis-text)]`}>
          {pending.title || 'The agent has a question'}
        </div>
        <button
          onClick={() => onResolve({ outcome: 'cancelled', reason: 'user' })}
          className={`shrink-0 ${typographyCaption} text-[var(--basis-text-muted)] transition-colors hover:text-[var(--basis-text)]`}
        >
          Skip
        </button>
      </div>
      {questions.map((question) => (
        <div key={question.questionId} className="mt-1.5">
          {question.prompt && question.prompt !== pending.title ? (
            <div className={`${typographyCaption} mb-1 text-[var(--basis-text-muted)]`}>
              {question.prompt}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => {
              const selected = (selections[question.questionId] ?? []).includes(option.optionId)
              return (
                <button
                  key={option.optionId}
                  onClick={() => toggle(question, option.optionId)}
                  title={option.description}
                  className={selected ? chipSelected : chipIdle}
                >
                  {option.label || option.optionId}
                </button>
              )
            })}
          </div>
          {question.allowFreeText && questions.length > 1 ? (
            <input
              value={customAnswers[question.questionId] ?? ''}
              onChange={(event) =>
                setCustomAnswers((current) => ({
                  ...current,
                  [question.questionId]: event.target.value,
                }))
              }
              placeholder="Or type your own answer"
              className={`mt-1.5 w-full rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-canvas-bg)] px-2.5 py-1.5 ${typographyCaption} text-[var(--basis-text)] outline-none placeholder:text-[var(--basis-text-faint)] focus:border-[var(--basis-border-strong)]`}
            />
          ) : null}
        </div>
      ))}
      <div
        className={`mt-1.5 flex items-center justify-between gap-3 ${typographyCaption} text-[var(--basis-text-muted)]`}
      >
        <span>
          {questions.length === 1 && questions[0].allowFreeText
            ? 'Pick an option, or type your own answer below.'
            : ''}
        </span>
        {needsConfirm ? (
          <button
            onClick={() => answerAll(selections)}
            disabled={!allAnswered}
            className={`rounded-[var(--basis-chat-shell-radius)] bg-[var(--basis-action-bg)] px-2.5 py-1 ${typographyLabelSm} text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)] disabled:cursor-not-allowed disabled:opacity-50`}
          >
            Answer
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** Structured agent question rendered as an extension of the composer. */
export function ComposerQuestionPrompt() {
  const ctx = useQuestionStateOptional()
  if (!ctx?.pendingQuestion || !ctx.activeSessionId) return null
  return (
    <QuestionCard
      key={ctx.pendingQuestion.requestId}
      pending={ctx.pendingQuestion}
      onResolve={ctx.resolveQuestion}
    />
  )
}
