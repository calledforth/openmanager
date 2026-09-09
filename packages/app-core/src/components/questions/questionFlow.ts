import type { Question, QuestionAnswer } from '@agentpack/contract'

/** Per-question draft state: chosen option ids plus any free text typed. */
export interface QuestionDraft {
  selectedOptionIds: string[]
  text: string
}

export const emptyDraft: QuestionDraft = { selectedOptionIds: [], text: '' }

export function draftFor(drafts: Record<string, QuestionDraft>, questionId: string): QuestionDraft {
  return drafts[questionId] ?? emptyDraft
}

/** A question counts as answered once it has a selection or non-blank free text. */
export function isAnswered(question: Question, draft: QuestionDraft): boolean {
  return draft.selectedOptionIds.length > 0 || draft.text.trim().length > 0
}

export function allAnswered(questions: Question[], drafts: Record<string, QuestionDraft>): boolean {
  return questions.every((question) => isAnswered(question, draftFor(drafts, question.questionId)))
}

/** Index of the first unanswered question, or -1 when the set is complete. */
export function firstUnansweredIndex(
  questions: Question[],
  drafts: Record<string, QuestionDraft>,
): number {
  return questions.findIndex(
    (question) => !isAnswered(question, draftFor(drafts, question.questionId)),
  )
}

/** Multi-select toggles; single-select replaces, and re-picking clears it so a
 * mistaken choice can be undone without a "none" option existing. */
export function toggleOption(
  question: Question,
  draft: QuestionDraft,
  optionId: string,
): QuestionDraft {
  const selected = draft.selectedOptionIds
  if (question.allowMultiple) {
    return {
      ...draft,
      selectedOptionIds: selected.includes(optionId)
        ? selected.filter((id) => id !== optionId)
        : [...selected, optionId],
    }
  }
  return { ...draft, selectedOptionIds: selected.includes(optionId) ? [] : [optionId] }
}

/** Free text is only sent when non-blank — an empty string is not an answer. */
export function buildAnswers(
  questions: Question[],
  drafts: Record<string, QuestionDraft>,
): QuestionAnswer[] {
  return questions.map((question) => {
    const draft = draftFor(drafts, question.questionId)
    const text = draft.text.trim()
    return {
      questionId: question.questionId,
      selectedOptionIds: draft.selectedOptionIds,
      ...(text ? { text } : {}),
    }
  })
}

/** Human-readable summary of one answer, for the review slide. */
export function summarizeAnswer(question: Question, draft: QuestionDraft): string | null {
  const labels = draft.selectedOptionIds.map(
    (id) => question.options.find((option) => option.optionId === id)?.label ?? id,
  )
  const text = draft.text.trim()
  if (text) labels.push(text)
  return labels.length ? labels.join(', ') : null
}

/** Shortcut hint for an option row. Digits, so the key you press is the number
 * you see; past nine there is no single keystroke left to offer. */
export function optionKey(index: number): string | null {
  return index < 9 ? String(index + 1) : null
}

export function indexForKey(key: string): number {
  const digit = Number.parseInt(key, 10)
  return Number.isInteger(digit) && digit >= 1 && digit <= 9 ? digit - 1 : -1
}
