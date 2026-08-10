import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'

export interface TurnRuntimeMetadata {
  startedAt?: number
  completedAt?: number
  finishReason?: string
}

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
  let finalStart = parts.length

  while (finalStart > 0) {
    const part = parts[finalStart - 1]
    if (!part || part.type !== 'text' || part.synthetic || part.ignored) break
    finalStart -= 1
  }

  const beforeAnswer = parts.slice(0, finalStart)
  // Generated artifacts are answer content even though Cursor emits their
  // callback before it streams its closing text. Keep the tool trace folded,
  // but never hide the result the user asked for inside "Worked".
  const generatedImages = beforeAnswer.filter(
    (part) => part.type === 'image' && part.generated === true,
  )
  return {
    workParts: beforeAnswer.filter((part) => !generatedImages.includes(part)),
    finalParts: [...generatedImages, ...parts.slice(finalStart)],
  }
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
    return 'Worked'
  }

  return `Worked for ${formatDuration(Math.max(0, completedAt - startedAt))}`
}
