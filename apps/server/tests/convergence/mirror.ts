import type { FrameRecord } from './link-proxy.ts'

/**
 * What a client should hold as a workspace's `lastActivityAt`, derived only
 * from what the server sent it (the proxy's recording of its socket), never
 * from the client's own state: the value a workspace listing, a snapshot or
 * a `workspace.updated` gives it (each replaces the workspace), moved forward
 * by `session.created`, a `session.create` answer's `announcedAt`, and turn
 * events (`touchWorkspaceActivity`, state.ts:253-270, called at :413, :495,
 * :882).
 *
 * This is the client's contract for one field written out; a client that
 * holds anything else has a bug of its own, which then shows as an entry no
 * cause explains. The recording must hold only the subject's socket(s) and
 * must have started before its first workspace listing.
 */
export function mirroredRecency(
  frames: readonly FrameRecord[],
  workspaceId: string,
): string | null {
  let value: string | null | undefined
  const ms = (time: string | null | undefined) =>
    time ? Date.parse(time) : Number.NEGATIVE_INFINITY
  const touch = (time: unknown) => {
    if (value === undefined || typeof time !== 'string') return
    if (ms(time) > ms(value)) value = time
  }
  const replace = (workspaces: unknown) => {
    const found = (
      workspaces as Array<{ workspaceId: string; lastActivityAt: string | null }>
    ).find((workspace) => workspace.workspaceId === workspaceId)
    if (found) value = found.lastActivityAt
  }
  for (const frame of frames) {
    if (frame.direction !== 'down' || frame.opcode !== 1) continue
    if (frame.json === undefined) {
      // A frame too large to read might carry the workspace (a snapshot).
      if (
        frame.fields?.scopeType === 'environment' ||
        frame.fields?.name?.startsWith('workspace')
      ) {
        throw new Error('A frame that may carry the workspace was too large to inspect.')
      }
      continue
    }
    const message = frame.json as {
      type?: string
      name?: string
      payload?: Record<string, unknown>
    }
    const payload = message.payload ?? {}
    if (message.type === 'response') {
      if (Array.isArray(payload.workspaces)) replace(payload.workspaces)
      const state = (payload.snapshot as { state?: { workspaces?: unknown } } | undefined)?.state
      if (Array.isArray(state?.workspaces)) replace(state.workspaces)
      // The session.create answer: applySessionCreated touches with announcedAt.
      if (typeof payload.announcedAt === 'string' && payload.session) touch(payload.announcedAt)
      if (payload.mode === 'replay' && Array.isArray(payload.events)) {
        for (const record of payload.events as Array<{ event: Record<string, unknown> }>) {
          apply(record.event)
        }
      }
      continue
    }
    if (message.type === 'event' && message.name === 'subscription.event') {
      const record = payload.record as { event: Record<string, unknown> } | undefined
      if (record) apply(record.event)
    }
  }
  return value ?? null

  function apply(event: Record<string, unknown>) {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    switch (event.name) {
      case 'workspace.updated':
        replace([payload.workspace])
        return
      case 'session.created':
        if (
          (payload.session as { workspaceId?: string } | undefined)?.workspaceId === workspaceId
        ) {
          touch(event.timestamp)
        }
        return
      case 'turn.started':
      case 'turn.completed':
      case 'turn.interrupted':
      case 'turn.failed':
        // Every session in these fixtures belongs to the one workspace.
        touch(event.timestamp)
        return
      default:
        return
    }
  }
}

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
