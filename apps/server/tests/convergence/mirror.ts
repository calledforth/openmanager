import type { FrameRecord } from './link-proxy.ts'

/*
 * What a client was sent, read from the proxy's recording of its socket(s),
 * never from the client's own state. Until F3 this also derived the workspace
 * recency a client should hold under its own mirror rule (touchWorkspaceActivity);
 * F3 announces recency (§4.7.1) and the rule is gone.
 */

/** The timestamp of the `session.created` event the server sent for a session. */
export function createdAt(frames: readonly FrameRecord[], sessionId: string): string {
  for (const frame of frames) {
    const event = (
      frame.json as { payload?: { record?: { event?: Record<string, unknown> } } } | undefined
    )?.payload?.record?.event
    if (
      frame.direction === 'down' &&
      event?.name === 'session.created' &&
      (event.payload as { session?: { sessionId?: string } }).session?.sessionId === sessionId
    ) {
      return event.timestamp as string
    }
  }
  throw new Error(`No session.created reached this socket for ${sessionId}.`)
}
