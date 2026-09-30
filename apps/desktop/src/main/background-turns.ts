import { isRecoverableError, type AgentEvent } from '@agentpack/contract'

/** What an event means for a turn this host never recorded.
 *
 * - `started` / `ended`: the turn's own bookends. Neither is persisted or
 *   announced, because there is no turn here to start, finish or point at.
 * - `ended_waiting`: it ended after asking the user something. The request
 *   itself was recorded (it has to reach the user), and left the session at
 *   waiting, so the session has to be put back at rest. */
export type UnrecordedTurnEvent = 'started' | 'ended' | 'ended_waiting'

/**
 * Recognises the bookends of a turn the provider began by itself.
 *
 * A provider can start a turn when a background task finishes. The environment
 * server files that turn in its transcript; this host's Convex projection has
 * no such turn, so the turn's output is dropped for want of one. Its ending is
 * what would still get through: marking the session done, or failed, and
 * notifying "Turn finished" for work the transcript does not hold.
 *
 * Everything inside such a turn is left alone and answers `undefined`, a
 * permission request in particular, which still has to reach the user or the
 * provider hangs.
 */
export function createBackgroundTurnFilter(): (
  event: AgentEvent,
) => UnrecordedTurnEvent | undefined {
  /** Each open background turn, by thread: the message id its events carry,
   * and whether it has asked the user anything. */
  const open = new Map<string, { messageId: string | undefined; asked: boolean }>()
  return (event) => {
    if (event.event === 'background_turn_started') {
      open.set(event.threadId, { messageId: event.messageId, asked: false })
      return 'started'
    }
    const turn = open.get(event.threadId)
    if (!turn) return undefined
    // A prompt or an exit ends the background turn without being part of it.
    if (event.event === 'prompt_started' || event.event === 'process_exited') {
      open.delete(event.threadId)
      return undefined
    }
    if (event.messageId !== turn.messageId) return undefined
    if (
      event.event === 'permission_request' ||
      event.event === 'question_request' ||
      event.event === 'plan_review_request'
    ) {
      turn.asked = true
      return undefined
    }
    const ends =
      event.event === 'prompt_completed' ||
      ((event.event === 'rpc_error' || event.event === 'runtime_error') &&
        !isRecoverableError(event))
    if (!ends) return undefined
    open.delete(event.threadId)
    return turn.asked ? 'ended_waiting' : 'ended'
  }
}
