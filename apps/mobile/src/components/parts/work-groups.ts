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
