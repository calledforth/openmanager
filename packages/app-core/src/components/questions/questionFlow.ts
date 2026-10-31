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

/** Multi-select toggles; single-select sets. Picking a single-select option
 * is "this one" — it moves the flow on — so picking the current choice again
 * keeps it rather than clearing it out from under the advance. */
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
  return { ...draft, selectedOptionIds: [optionId] }
}

export type NextStep = { kind: 'goto'; index: number } | { kind: 'submit' }

/** Where moving on from `index` leads. Mid-set it is simply the next question.
 * From the last one it is the first gap if any remain — never a send with
 * holes in it — and otherwise the send itself; there is no review step. */
export function nextStep(
  questions: Question[],
  drafts: Record<string, QuestionDraft>,
  index: number,
): NextStep {
  if (index < questions.length - 1) return { kind: 'goto', index: index + 1 }
  const gap = firstUnansweredIndex(questions, drafts)
  return gap === -1 ? { kind: 'submit' } : { kind: 'goto', index: gap }
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
