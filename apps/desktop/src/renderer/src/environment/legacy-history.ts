import {
  applySnapshot,
  withSessionUpserted,
  type EnvironmentState,
} from '@openmanager/environment-client'
import type {
  Interaction,
  Message,
  ScopeSnapshot,
  SessionSummary,
  Thread,
  Turn,
} from '@openmanager/protocol'

/**
 * Desktop's own copy of the read model the environment protocol dropped in
 * v20 (docs/sync-foundations.md §3.5): the Convex adapter still loads a whole
 * session in one call and files it as the thread's state. TEMPORARY, deleted
 * with Convex retirement, like the rest of this adapter.
 */

/** A whole transcript, as the Convex adapter assembles it. */
export interface LegacyHistory {
  messages: Message[]
  turns: Turn[]
  interactions: Array<{ threadId: string; interaction: Interaction }>
}

/** A session with no time sorts as the oldest, as the environment lists it. */
export const LEGACY_LIST_EPOCH = '1970-01-01T00:00:00.000Z'

/**
 * File a whole transcript as the thread's state. Convex keeps no reasoning,
 * tool calls or order, so the order is the messages' own, and a pending
 * request belongs to the open turn (or the last one).
 */
export function applyLegacyHistory(
  state: EnvironmentState,
  thread: Thread,
  history: LegacyHistory,
): EnvironmentState {
  const open = history.turns.find((turn) => turn.state === 'running' || turn.state === 'waiting')
  const turnId = open?.turnId ?? history.turns.at(-1)?.turnId ?? ''
  const snapshot = {
    cursor: {
      scope: {
        type: 'thread',
        environmentId: state.environment?.environmentId ?? 'desktop',
        sessionId: thread.sessionId,
        threadId: thread.threadId,
      },
      epoch: 'convex',
      sequence: 0,
    },
    state: {
      thread,
      turns: history.turns,
      messages: history.messages,
      reasoning: [],
      tools: [],
      order: history.messages.map((message) => ({
        kind: 'message' as const,
        id: message.messageId,
        turnId: message.turnId,
      })),
      interactions: history.interactions
        .filter((item) => item.threadId === thread.threadId)
        .map((item) => ({ turnId, interaction: item.interaction })),
    },
  } as ScopeSnapshot
  return applySnapshot(state, snapshot)
}

/** File listed sessions, each as stated. */
export function applyLegacySessionList(
  state: EnvironmentState,
  sessions: readonly SessionSummary[],
): EnvironmentState {
  return sessions.reduce((next, session) => withSessionUpserted(next, session), state)
}
