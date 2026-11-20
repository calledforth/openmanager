import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { isMovedPart } from '../../lib/turn-notice-parts'

export interface TurnRuntimeMetadata {
  startedAt?: number
  completedAt?: number
  finishReason?: string
  /**
   * Nobody prompted this turn: a background task finished and the agent woke
   * to act on the result. The transcript says so, since otherwise the agent
   * appears to answer a message that is not there.
   */
  unprompted?: boolean
}

/** What an unprompted turn is introduced with, in place of a user message. */
export const UNPROMPTED_TURN_LABEL = 'Resumed after background work'

export interface TurnPartPartition {
  workParts: StreamMessagePart[]
  finalParts: StreamMessagePart[]
}

/**
 * A settled turn's answer, and the work before it. Projectors already split
 * text whenever a tool, thought, plan, or subtask arrives, so this preserves
 * every existing part and only derives a presentation boundary.
 *
 * A provider that marks its messages (Codex) says which text is which: its
 * `partial_answer` and `final_answer` text is the answer, wherever it stands,
 * and its `commentary` is narration of the work, never the answer. Text
 * without a phase (older history, other providers, a review's output) keeps
 * the rule from before phases: the turn's last visible run of text is its
 * answer, and commentary ends that run as a tool would.
 */
export function partitionSettledTurnParts(parts: readonly StreamMessagePart[]): TurnPartPartition {
  // What the turn ended on (its failure, a notice the provider sent after the
  // answer) closes the turn rather than being its work, and must not hide the
  // answer before it by ending the text run.
  // A subagent card after the answer is one an older environment could not
  // place; it must not end the text run either.
  let answerEnd = parts.length
  while (answerEnd > 0 && isTrailer(parts[answerEnd - 1])) answerEnd -= 1
  let finalStart = answerEnd

  while (finalStart > 0) {
    const part = parts[finalStart - 1]
    if (!isVisibleText(part) || textPhase(part) === 'commentary') break
    finalStart -= 1
  }

  const earlier = parts.slice(0, finalStart)
  // Answer text the provider marked before the last run (a partial answer a
  // tool call followed) is answer all the same.
  const marked = earlier.filter(isMarkedAnswer)
  const beforeAnswer = marked.length ? earlier.filter((part) => !marked.includes(part)) : earlier
  const answer = [...marked, ...parts.slice(finalStart)]
  // Generated artifacts are answer content even though Cursor emits their
  // callback before it streams its closing text. Keep the tool trace folded,
  // but never hide the result the user asked for inside "Worked". Notices
  // that change how to read the answer (the conversation before it was
  // compacted, another model wrote it, the model declined, a limit is close,
  // the session moved to another project) stay out with it.
  const lifted = beforeAnswer.filter(
    (part) =>
      ((part.type === 'image' || part.type === 'video') && part.generated === true) ||
      (part.type === 'notice' && (LIFTED_NOTICE_KINDS.has(noticeKind(part)) || isMovedPart(part))),
  )
  // The subagents the turn started keep their place in the work, where each
  // ran, and all of them also head the answer as its summary: each is a chat
  // of its own the reader goes to, and a background one is still at work.
  const subagents = parts.filter(isSubagent)
  return {
    workParts: [
      ...beforeAnswer.filter((part) => !lifted.includes(part)),
      ...answer.filter(isSubagent),
    ],
    finalParts: [...subagents, ...lifted, ...answer.filter((part) => !isSubagent(part))],
  }
}

function isSubagent(part: StreamMessagePart): boolean {
  return part.type === 'subagent'
}

function isVisibleText(part: StreamMessagePart | undefined): part is StreamMessagePart {
  return part?.type === 'text' && !part.synthetic && !part.ignored
}

/** The phase a text part's message has, when its provider marked one. */
function textPhase(part: StreamMessagePart): string | undefined {
  return typeof part.phase === 'string' ? part.phase : undefined
}

function isMarkedAnswer(part: StreamMessagePart): boolean {
  const phase = textPhase(part)
  return isVisibleText(part) && (phase === 'partial_answer' || phase === 'final_answer')
}

/**
 * What the copy button under a reply copies: the answer text the reader sees, without tool
 * calls, reasoning or hidden parts. A settled turn with collapsed work copies only the answer
 * below it. Empty while the turn streams, so no button shows.
 */
export function assistantCopyText(
  content: string,
  isFinal: boolean | undefined,
  parts: readonly StreamMessagePart[] | undefined,
): string {
  if (isFinal !== true) return ''
  if (!parts?.length) return content.trim()
  const { workParts, finalParts } = partitionSettledTurnParts(parts)
  return (workParts.length > 0 ? finalParts : parts)
    .filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => (typeof part.text === 'string' ? part.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

const LIFTED_NOTICE_KINDS = new Set(['compacted', 'model_fallback', 'refusal', 'usage_warning'])

function noticeKind(part: StreamMessagePart): string {
  const notice = part.notice as { kind?: unknown } | undefined
  return typeof notice?.kind === 'string' ? notice.kind : ''
}

function isTrailer(part: StreamMessagePart | undefined): boolean {
  return part?.type === 'failure' || part?.type === 'notice' || part?.type === 'subagent'
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function settledTurnLabel(runtime?: TurnRuntimeMetadata): string {
  const finishReason = runtime?.finishReason?.trim()
  if (finishReason && finishReason !== 'end_turn') return 'Stopped'

  const startedAt = runtime?.startedAt
  const completedAt = runtime?.completedAt
  if (
    typeof startedAt !== 'number' ||
    typeof completedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt)
  ) {
    return runtime?.unprompted ? UNPROMPTED_TURN_LABEL : 'Worked'
  }

  const duration = formatDuration(Math.max(0, completedAt - startedAt))
  return runtime?.unprompted ? `${UNPROMPTED_TURN_LABEL} · ${duration}` : `Worked for ${duration}`
}
