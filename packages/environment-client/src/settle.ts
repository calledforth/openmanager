import type { ProofEvent } from '@openmanager/protocol'
import { applySessionSettled } from './state'
import type { EnvironmentStore } from './store'

interface InFlight {
  /** The click that owns what the session shows. */
  latest: number
  /** What the environment last said, for putting the session back. */
  confirmed: string | null
}

/**
 * Settling answers the click, not the environment. The session moves in the
 * store as soon as it is asked to, so the list animates on one render instead
 * of waiting a round trip and then rendering again for the answer and for its
 * echo. The environment's own time replaces the stand-in when the latest
 * request lands; a refused or failed one puts back what the environment last
 * confirmed.
 */
export function createSettleTracker(
  store: EnvironmentStore,
  now: () => string = () => new Date().toISOString(),
) {
  const inFlight = new Map<string, InFlight>()
  let tickets = 0

  const show = (sessionId: string, settledAt: string | null) =>
    store.update((state) => applySessionSettled(state, sessionId, settledAt))

  return {
    /** `send` asks the environment and resolves with the `settledAt` it kept. */
    async settle(
      sessionId: string,
      settled: boolean,
      send: () => Promise<string | null>,
    ): Promise<void> {
      const ticket = ++tickets
      let entry = inFlight.get(sessionId)
      if (!entry) {
        entry = {
          latest: ticket,
          confirmed: store.getState().sessions[sessionId]?.settledAt ?? null,
        }
        inFlight.set(sessionId, entry)
      }
      entry.latest = ticket
      show(sessionId, settled ? now() : null)
      const finish = (settledAt: string | null) => {
        inFlight.delete(sessionId)
        show(sessionId, settledAt)
      }
      let settledAt: string | null
      try {
        settledAt = await send()
      } catch (error) {
        // A later click owns the session now; its answer decides.
        if (entry.latest === ticket && inFlight.get(sessionId) === entry) finish(entry.confirmed)
        throw error
      }
      if (entry.latest === ticket && inFlight.get(sessionId) === entry) finish(settledAt)
      else entry.confirmed = settledAt
    },

    /**
     * While a request is in flight, the environment's announcements of
     * settling (this request's echo, or an earlier click's) would move the
     * session back and forth under the pointer. They are noted as what the
     * environment confirmed and left out of the event.
     */
    mask(event: ProofEvent): ProofEvent {
      if (event.name !== 'session.updated' || event.payload.settledAt === undefined) return event
      const entry = inFlight.get(event.payload.sessionId)
      if (!entry) return event
      entry.confirmed = event.payload.settledAt
      const payload = { ...event.payload }
      delete payload.settledAt
      return { ...event, payload }
    },
  }
}
