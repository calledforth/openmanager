/** Reading an answered `AskUserQuestion` back out of a transcript tool part.
 *
 * The environment states the answers on the tool's input once they exist: from
 * Claude Code's structured result, or from the question's own answer on Cursor.
 * A call with no answers may simply not have any yet, so it is not a skipped
 * question unless its status says it ended that way. A running tool's text can
 * also carry them, on the providers that put them there.
 */

export interface AskedQuestion {
  /** The question text — the key answers are looked up by. */
  prompt: string
  /** What the user picked or typed, or null when it went unanswered. */
  answer: string | null
  /** Short label the model attached to the question, if any. */
  header?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Answers can arrive on the input or, depending on the provider, on the
 * output — as an object or as a JSON string. */
function readAnswers(input: Record<string, unknown>, output: unknown): Record<string, string> {
  const candidates: unknown[] = [input.answers]
  if (typeof output === 'string') {
    try {
      const parsed: unknown = JSON.parse(output)
      candidates.push(record(parsed).answers, parsed)
    } catch {
      // Not JSON — a plain-text tool result carries no structured answers.
    }
  } else if (output != null) {
    candidates.push(record(output).answers, output)
  }

  for (const candidate of candidates) {
    const map = record(candidate)
    const entries = Object.entries(map).flatMap(([key, value]) =>
      typeof value === 'string' && value ? [[key, value] as const] : [],
    )
    if (entries.length) return Object.fromEntries(entries)
  }
  return {}
}

/** How a call ends when nobody answered it. */
const UNANSWERED = new Set(['error', 'failed', 'declined', 'cancelled'])

/** Returns null for anything that is not a recognisable question set, and for a
 * call with no answers whose status does not say they were skipped. Both keep
 * the caller on the ordinary tool row rather than a card of "Skipped". */
export function readAskedQuestions(state: unknown): AskedQuestion[] | null {
  const toolState = record(state)
  const input = record(toolState.input)
  const raw = Array.isArray(input.questions) ? input.questions : []
  if (raw.length === 0) return null

  const answers = readAnswers(input, toolState.output)
  const questions = raw.flatMap((value): AskedQuestion[] => {
    const question = record(value)
    // `question` is Claude's field; `prompt` is the contract's own shape.
    const prompt = text(question.question) || text(question.prompt)
    if (!prompt) return []
    const header = text(question.header)
    return [
      {
        prompt,
        answer: answers[prompt] ?? null,
        ...(header ? { header } : {}),
      },
    ]
  })

  if (questions.length === 0) return null
  const answered = questions.some((question) => question.answer !== null)
  return answered || UNANSWERED.has(text(toolState.status)) ? questions : null
}
