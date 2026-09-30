import { isRecoverableError, type AgentEvent } from '@agentpack/contract'

/**
 * Decides which runtime events must not be persisted or notified about because
 * they begin or end a turn this host never recorded.
 *
 * A provider can start a turn by itself when a background task finishes. The
 * environment server files that turn in its transcript; this host's Convex
 * projection has no such turn, so the turn's output is already dropped for
 * want of one. Its ending is what would still get through: marking the session
 * done, or failed, and notifying "Turn finished" for work the transcript does
 * not hold. Everything else in such a turn is left alone, a permission request
 * in particular, which still has to reach the user or the provider hangs.
 */
export function createBackgroundTurnFilter(): (event: AgentEvent) => boolean {
  /** The message id each open background turn's events carry, by thread. */
  const open = new Map<string, string | undefined>()
  return (event) => {
    if (event.event === 'background_turn_started') {
      open.set(event.threadId, event.messageId)
      return true
    }
    if (!open.has(event.threadId)) return false
    // A prompt or an exit ends the background turn without being part of it.
    if (event.event === 'prompt_started' || event.event === 'process_exited') {
      open.delete(event.threadId)
      return false
    }
    if (event.messageId !== open.get(event.threadId)) return false
    const ends =
      event.event === 'prompt_completed' ||
      ((event.event === 'rpc_error' || event.event === 'runtime_error') &&
        !isRecoverableError(event))
    if (ends) open.delete(event.threadId)
    return ends
  }
}
