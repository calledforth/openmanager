/**
 * How a turn's work folds, pure so the tests read it. A live turn lays its
 * parts out in the order they happened, each run of tool calls its own work
 * group with web's summary wording (`groupActivityParts`). A settled turn
 * folds everything before its answer into one group labelled with how long
 * the turn took (web's `partitionSettledTurnParts` / `settledTurnLabel`),
 * and the answer follows it.
 */
import type { ActivitySummary } from '@openmanager/shared/lib/activity-groups'
import { partitionSettledTurnParts, type MessagePart } from '@openmanager/app-core/logic'

/** "1 tool call", "4 tool calls". */
export function toolCallCount(count: number): string {
  return `${count} tool call${count === 1 ? '' : 's'}`
}

/** Web's summary starts lower-case so it can join other phrases; a label starts a line. */
export function workGroupLabel(
  summary: Pick<ActivitySummary, 'isRunning' | 'text' | 'runningText'>,
) {
  const text = summary.isRunning ? summary.runningText : summary.text
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}

export interface SettledTurnFold {
  /** Everything before the answer: thoughts, tool calls, words between them. */
  work: MessagePart[]
  /** The answer, drawn under the fold. */
  answer: MessagePart[]
  /** The fold's count, on its right. */
  toolCount: number
}

/** A settled turn's parts, split into its folded work and its answer. */
export function foldSettledTurn(parts: readonly MessagePart[]): SettledTurnFold {
  const { workParts, finalParts } = partitionSettledTurnParts(parts)
  return {
    work: workParts,
    answer: finalParts,
    toolCount: workParts.filter((part) => part.type === 'tool').length,
  }
}

/**
 * How a turn's parts are laid out. A turn is drawn as it streams (each run of
 * tools its own group) while it is live, and also once it settles if the
 * reader watched it stream: re-folding a reply in front of them would make
 * it jump, so it settles in place (labels and marks change, nothing changes
 * height). A turn that mounts already settled (opened later, or scrolled
 * back into view) is folded under its timing.
 */
export function turnLayout(turn: { streaming: boolean; watchedLive: boolean }): 'live' | 'folded' {
  return turn.streaming || turn.watchedLive ? 'live' : 'folded'
}

/** Whether a thought is still going: its own timing says, else the turn's. */
export function isThoughtStreaming(
  part: { type: string; time?: unknown },
  isStreaming: boolean | undefined,
): boolean {
  const time =
    part.time && typeof part.time === 'object' ? (part.time as Record<string, unknown>) : undefined
  return time ? typeof time.end !== 'number' : !!isStreaming
}

/**
 * The thought a work group hangs on its branch: its last member, while that
 * is a thought still going. Only the last can be; one the work has moved
 * past reads as had. A run of thoughts alone is no group, so has none.
 */
export function liveThoughtOf<T extends { type: string; time?: unknown }>(
  items: readonly T[],
  toolCount: number,
  isStreaming: boolean | undefined,
): T | undefined {
  if (toolCount === 0) return undefined
  const tail = items[items.length - 1]
  return tail?.type === 'reasoning' && isThoughtStreaming(tail, isStreaming) ? tail : undefined
}
