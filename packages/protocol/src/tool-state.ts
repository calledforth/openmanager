import { isSettledToolStatus, type ToolCallState, type ToolCallUpdate } from './domains.js'

/**
 * A settled tool's output is read back with
 * `GET /tool-output/<session-id>/<tool-call-id>`, relative to the environment's
 * HTTP origin, like an artifact's bytes: over the route the client reached the
 * environment through, with its credential.
 */
export const TOOL_OUTPUT_PATH_PREFIX = '/tool-output/' as const

/** Where a settled tool's output lives. */
export const toolOutputPath = (sessionId: string, toolCallId: string) =>
  `${TOOL_OUTPUT_PATH_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(toolCallId)}`

/**
 * Fold one `tool.updated` payload into what is held for the call. The
 * environment's projection and every client fold with this, so a stored row, a
 * snapshot and a client that watched the call live hold the same thing.
 *
 * - A field the update carries replaces the held one; an absent field keeps it.
 * - `output` replaces the running text; `outputDelta` appends to it.
 * - The update that settles a call drops the running text: it stays on the
 *   environment from then on, and a snapshot of a settled call has none.
 * - A final status is kept: a late progress update cannot reopen the call.
 * - `startedAt` and `finishedAt` are kept once set.
 */
export function applyToolUpdate(
  previous: ToolCallState | undefined,
  update: ToolCallUpdate,
): ToolCallState {
  const settled = isSettledToolStatus(previous?.status)
  const { outputDelta, output, status, startedAt, finishedAt, ...fields } = update
  const next: ToolCallState = { ...previous, ...definedOnly(fields) }
  if (status !== undefined && !settled) next.status = status
  if (startedAt !== undefined && next.startedAt === undefined) next.startedAt = startedAt
  if (finishedAt !== undefined && next.finishedAt === undefined && !settled) {
    next.finishedAt = finishedAt
  }
  if (output !== undefined) next.output = output
  else if (outputDelta !== undefined) next.output = (next.output ?? '') + outputDelta
  if (isSettledToolStatus(next.status)) delete next.output
  return next
}

function definedOnly<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T
}
