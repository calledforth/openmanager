import { createInitialState } from './state'
import { emptyOverlay } from './overlay'
import type { EnvironmentState } from './types'

/**
 * What a host's offline cache keeps of a state, and what a reload starts
 * from. Pure, so every host caches the same way and the convergence harness
 * can reload a client exactly as the web app does.
 */
export function cacheState(state: EnvironmentState): EnvironmentState {
  return {
    ...state,
    connection: createInitialState().connection,
    sessionOpenFailure: null,
    catchingUp: {},
    // The user's unconfirmed actions belong to the old transport's commands.
    pending: emptyOverlay(),
    // A send cut off by the reload has an outcome this page never learns, and
    // its edit holds the cleared composer, not what was sent. Dropped, so the
    // environment's copy stands: gone with the session if the send happened,
    // listed again if it did not.
    draftEdits: Object.fromEntries(
      Object.entries(state.draftEdits).filter(([, edit]) => !edit.launching),
    ),
    threads: Object.fromEntries(
      Object.entries(state.threads).map(([id, thread]) => [
        id,
        {
          ...thread,
          // Pending commands belong to the old transport and are never replayed.
          // A send that waited for a catch-up is the exception. Its text has
          // left the composer and may never have left the device, so it stays
          // and the next client sends it. Its command id makes that safe: one
          // that did get through is answered from the environment's log.
          outbox: thread.outbox.flatMap((entry) =>
            !entry.waited
              ? []
              : entry.status === 'pending'
                ? [{ ...entry, status: 'held' as const }]
                : [entry],
          ),
          // Which messages were echoes only matters to rows the old page drew.
          confirmedEchoes: undefined,
          // Never stored by the server, so a fresh load has none. The cursor
          // stays: durable state and cursor were written together.
          notices: [],
          hydration: thread.hydration === 'loading' ? 'idle' : thread.hydration,
        },
      ]),
    ),
  }
}

/**
 * A kept copy with nothing promised about what it holds: every scope asks for
 * a whole snapshot, which replaces the server-owned part. What only the copy
 * has, unsent drafts and held sends, stays, so a reload cannot lose it. For a
 * copy written under another event format, whose build may have ignored a
 * field and still moved its cursor past the event.
 */
export function forgetCursors(state: EnvironmentState): EnvironmentState {
  return {
    ...state,
    cursors: { environment: null, sessions: {} },
    threads: Object.fromEntries(
      Object.entries(state.threads).map(([id, { cursor: _cursor, ...thread }]) => [id, thread]),
    ),
  }
}
