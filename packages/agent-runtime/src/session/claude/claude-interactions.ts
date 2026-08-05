import type {
  PlanDocument,
  PlanTodo,
  Question,
  QuestionOption,
  QuestionOutcome,
} from '@agentpack/contract'
import { object, string } from '../wire.js'

/** Everything needed to translate the user's answer back into the shape the
 * `AskUserQuestion` tool expects, kept private to the runtime.
 *
 * It exists because the two sides key answers differently and neither key can
 * be used for the other:
 * - Claude looks answers up by the FULL ORIGINAL QUESTION TEXT. That is the
 *   contract of `AskUserQuestionOutput.answers` — `{[questionText]: string}`.
 * - The desktop keys React rows and the user's selections by `questionId`
 *   (`ComposerQuestionPrompt`), so two questions sharing a text would collide
 *   and overwrite each other's selections in the composer's local state.
 *
 * So the UI gets a synthetic `${requestId}:${index}` id and this record keeps
 * the original text and the option labels to translate back with. */
export type PendingClaudeQuestions = {
  /** The tool input, verbatim. The response REPLACES the input wholesale, so
   * the original `questions` array has to be handed straight back. */
  input: Record<string, unknown>
  entries: {
    questionId: string
    /** The key Claude looks the answer up by. */
    text: string
    /** Option labels in wire order; `selectedOptionIds` index into this. */
    labels: string[]
  }[]
  /** Question texts that appear more than once in this request. */
  duplicateTexts: string[]
}

export type ParsedClaudeQuestions = {
  title?: string
  questions: Question[]
  pending: PendingClaudeQuestions
}

/** Wire shape (claude 2.1.220, `AskUserQuestionInput`):
 * `{questions: [{question, header, multiSelect, options: [{label, description, preview?}]}]}`.
 *
 * Returns undefined for anything that is not a recognisable question set, which
 * makes the caller fall through to the ordinary permission path rather than
 * park a request the UI cannot render. */
export function parseAskUserQuestion(
  requestId: string,
  input: Record<string, unknown>,
): ParsedClaudeQuestions | undefined {
  const raw = Array.isArray(input.questions) ? input.questions : []
  if (raw.length === 0) return undefined

  const questions: Question[] = []
  const entries: PendingClaudeQuestions['entries'] = []
  const seen = new Map<string, number>()

  raw.forEach((value, index) => {
    const question = object(value)
    const text = string(question.question) ?? ''
    if (!text) return
    const rawOptions = Array.isArray(question.options) ? question.options : []
    const labels = rawOptions.map((option) => string(object(option).label) ?? '')
    const options: QuestionOption[] = labels.flatMap((label, optionIndex): QuestionOption[] => {
      if (!label) return []
      const description = string(object(rawOptions[optionIndex]).description)
      return [
        {
          // Scoped to the question, so the same label under two questions stays
          // two distinct rows in the composer.
          optionId: `o${optionIndex}`,
          label,
          ...(description ? { description } : {}),
        },
      ]
    })
    // `${requestId}:${index}`, NOT the question text: the composer keys rows and
    // selections by this and duplicate texts would collide.
    const questionId = `${requestId}:${index}`
    questions.push({
      questionId,
      prompt: text,
      options,
      allowMultiple: question.multiSelect === true,
      // The tool always offers an implicit "Other" — the schema explicitly says
      // not to include one — so free text is always accepted.
      allowFreeText: true,
    })
    entries.push({ questionId, text, labels })
    seen.set(text, (seen.get(text) ?? 0) + 1)
  })

  if (questions.length === 0) return undefined
  const duplicateTexts = [...seen.entries()].flatMap(([text, count]) => (count > 1 ? [text] : []))
  const headers = raw.map((value) => string(object(value).header)).filter(Boolean)
  return {
    // `header` is a per-question chip and the contract has one title per
    // request, so it is only usable as a title when there is one question.
    ...(questions.length === 1 && headers[0] ? { title: headers[0] } : {}),
    questions,
    pending: { input, entries, duplicateTexts },
  }
}

/** The user's answer, in Claude's vocabulary.
 *
 * `answers` is `{[questionText]: string}` with multi-select answers joined by
 * commas — that is the documented shape of `AskUserQuestionOutput`, verified
 * against the SDK's own `sdk-tools.d.ts`.
 *
 * Duplicate question texts are the one case the SDK's shape cannot express: two
 * questions, one key. Rather than silently letting the later answer win, both
 * answers are merged into the single value the SDK will apply to both, and the
 * caller logs it. Dropping one would answer a question the user never saw
 * answered; refusing the whole tool call over a model formatting quirk would be
 * worse. */
export function claudeQuestionAnswers(
  pending: PendingClaudeQuestions,
  outcome: Extract<QuestionOutcome, { outcome: 'answered' }>,
): Record<string, string> {
  const byQuestionId = new Map(outcome.answers.map((answer) => [answer.questionId, answer]))
  const answers: Record<string, string> = {}
  for (const entry of pending.entries) {
    const answer = byQuestionId.get(entry.questionId)
    if (!answer) continue
    const selected = (answer.selectedOptionIds ?? []).flatMap((optionId) => {
      // `o<index>` positions into the wire order the question arrived in, which
      // is how a synthetic option id becomes the label Claude expects.
      const index = Number.parseInt(optionId.replace(/^o/, ''), 10)
      const label = Number.isInteger(index) ? entry.labels[index] : undefined
      return label ? [label] : []
    })
    const free = answer.text?.trim()
    const parts = [...selected, ...(free ? [free] : [])]
    if (parts.length === 0) continue
    const value = parts.join(', ')
    const existing = answers[entry.text]
    answers[entry.text] = existing ? `${existing}, ${value}` : value
  }
  return answers
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s*)?(.*\S)\s*$/

/** `ExitPlanMode`'s plan is free-form markdown — the tool has no structured
 * todo list — so the document is derived from it rather than parsed out of it.
 *
 * The markdown itself is always the source of truth and is passed through
 * verbatim; the extracted heading, lead paragraph and list items exist only so
 * a client that renders a structured plan has something to render. Nothing is
 * invented: a plan with no list produces no todos, and the reviewer still sees
 * the full markdown. */
export function planFromExitPlanMode(
  input: Record<string, unknown>,
): Omit<PlanDocument, 'requestId' | 'sessionId'> {
  const markdown = string(input.plan) ?? ''
  const lines = markdown.split('\n')
  let name: string | undefined
  let overview: string | undefined
  const todos: PlanTodo[] = []

  for (const line of lines) {
    const heading = HEADING.exec(line)
    if (heading?.[1]) {
      name ??= heading[1]
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item?.[2]) {
      todos.push({
        id: `plan-${todos.length}`,
        content: item[2],
        // Only an explicitly ticked checkbox is complete. An unchecked box and
        // a plain bullet are both work still to do.
        status: item[1] === 'x' || item[1] === 'X' ? 'completed' : 'pending',
      })
      continue
    }
    const text = line.trim()
    if (text && overview === undefined && todos.length === 0) overview = text
  }

  return {
    ...(name ? { name } : {}),
    ...(overview ? { overview } : {}),
    markdown,
    todos,
    // The load-bearing field. Approving an `ExitPlanMode` releases the SAME
    // turn to continue straight into implementation, so the host must NOT
    // dispatch a follow-up prompt: doing so would run the entire plan a second
    // time, repeating every edit and every command.
    continuation: 'same_turn',
  }
}
