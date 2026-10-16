import type { ToolCallState, ToolCallStatus, ToolCallUpdate } from './domains.js'
import { appendToolOutput } from './tool-output.js'

/** A status the tool call does not leave again. */
export function isTerminalToolStatus(status: ToolCallStatus | undefined): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'declined' || status === 'cancelled'
  )
}

/**
 * Fold one `tool.updated` payload into what is held for the call. The
 * environment's projection and every client fold with this, so a stored tool
 * call, a history page and a client that watched it live agree.
 *
 * - A field the update carries replaces the held one; an absent field keeps it.
 * - `output` replaces the whole output; `outputDelta` appends to it.
 * - A final status is kept: a late progress update cannot reopen the call.
 * - `startedAt` and `finishedAt` are kept once set.
 */
export function applyToolUpdate(
  previous: ToolCallState | undefined,
  update: ToolCallUpdate,
): ToolCallState {
  const settled = isTerminalToolStatus(previous?.status)
  const next: ToolCallState = { ...previous, toolCallId: update.toolCallId, turnId: update.turnId }
  if (update.toolName !== undefined) next.toolName = update.toolName
  if (update.title !== undefined) next.title = update.title
  if (update.kind !== undefined) next.kind = update.kind
  if (update.status !== undefined && !settled) next.status = update.status
  if (update.input !== undefined) next.input = update.input
  if (update.locations !== undefined) next.locations = update.locations
  if (update.lineChanges !== undefined) next.lineChanges = update.lineChanges
  if (update.startedAt !== undefined && next.startedAt === undefined) {
    next.startedAt = update.startedAt
  }
  if (update.finishedAt !== undefined && next.finishedAt === undefined && !settled) {
    next.finishedAt = update.finishedAt
  }
  if (update.output !== undefined) next.output = update.output
  else if (update.outputDelta !== undefined) {
    next.output = appendToolOutput(next.output, update.outputDelta)
  }
  return next
}
