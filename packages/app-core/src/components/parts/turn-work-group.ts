import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'

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
 * A settled turn's last visible text run is its terminal answer. Everything
 * before it is the work transcript. Projectors already split text whenever a
 * tool, thought, plan, or subtask arrives, so this preserves every existing
 * part and only derives a presentation boundary.
 */
export function partitionSettledTurnParts(parts: readonly StreamMessagePart[]): TurnPartPartition {
  // What the turn ended on (its failure, a notice the provider sent after the
  // answer) closes the turn rather than being its work, and must not hide the
  // answer before it by ending the text run.
  let answerEnd = parts.length
  while (answerEnd > 0 && isTrailer(parts[answerEnd - 1])) answerEnd -= 1
  let finalStart = answerEnd

  while (finalStart > 0) {
    const part = parts[finalStart - 1]
    if (!part || part.type !== 'text' || part.synthetic || part.ignored) break
    finalStart -= 1
  }

  const beforeAnswer = parts.slice(0, finalStart)
  // Generated artifacts are answer content even though Cursor emits their
  // callback before it streams its closing text. Keep the tool trace folded,
  // but never hide the result the user asked for inside "Worked". Notices
  // that change how to read the answer (the conversation before it was
  // compacted, another model wrote it, the model declined, a limit is close)
  // stay out with it.
  const lifted = beforeAnswer.filter(
    (part) =>
      (part.type === 'image' && part.generated === true) ||
      (part.type === 'notice' && LIFTED_NOTICE_KINDS.has(noticeKind(part))),
  )
  return {
    workParts: beforeAnswer.filter((part) => !lifted.includes(part)),
    finalParts: [...lifted, ...parts.slice(finalStart)],
  }
}

const LIFTED_NOTICE_KINDS = new Set(['compacted', 'model_fallback', 'refusal', 'usage_warning'])

function noticeKind(part: StreamMessagePart): string {
  const notice = part.notice as { kind?: unknown } | undefined
  return typeof notice?.kind === 'string' ? notice.kind : ''
}

function isTrailer(part: StreamMessagePart | undefined): boolean {
  return part?.type === 'failure' || part?.type === 'notice'
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
