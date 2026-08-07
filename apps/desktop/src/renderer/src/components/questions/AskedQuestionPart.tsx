import { typographyCaption, typographyLabel } from '../../lib/typography'
import type { AskedQuestion } from './askedQuestion'

/** An answered question in the transcript.
 *
 * Deliberately not styled as a user message: it is a record of an exchange, so
 * it sits a shade darker than the canvas and just lists what was asked and what
 * was answered. */
export function AskedQuestionPart({ questions }: { questions: AskedQuestion[] }) {
  return (
    <div className="my-0.5 flex flex-col gap-2 rounded-[var(--basis-chat-shell-radius)] bg-[color-mix(in_srgb,var(--basis-text)_3%,transparent)] px-3 py-2">
      {questions.map((question, index) => (
        <div key={`${question.prompt}:${index}`} className="flex flex-col gap-0.5">
          <span className={`${typographyCaption} text-[var(--basis-text)]`}>{question.prompt}</span>
          <span
            className={`${typographyLabel} ${
              question.answer ? 'text-[var(--basis-text-strong)]' : 'text-[var(--basis-text-faint)]'
            }`}
          >
            {question.answer ?? 'Skipped'}
          </span>
        </div>
      ))}
    </div>
  )
}
