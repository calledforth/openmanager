import type { PermissionCancellationReason } from './permissions.js'

export type QuestionOption = {
  optionId: string
  label: string
  description?: string
}

export type Question = {
  questionId: string
  prompt: string
  options: QuestionOption[]
  allowMultiple?: boolean
  allowFreeText?: boolean
}

export type QuestionRequest = {
  requestId: string
  sessionId: string
  title?: string
  questions: Question[]
  /** The tool call this request belongs to, when the provider says. */
  toolCallId?: string
}

export type QuestionAnswer = {
  questionId: string
  selectedOptionIds?: string[]
  /** Free-text answer typed by the user; provider adapters decide how to encode it. */
  text?: string
}

export type QuestionOutcome =
  | { outcome: 'answered'; answers: QuestionAnswer[] }
  | { outcome: 'cancelled'; reason?: PermissionCancellationReason }
