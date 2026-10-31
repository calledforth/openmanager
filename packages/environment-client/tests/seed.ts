import type {
  ActivityRef,
  Interaction,
  Message,
  ReasoningBlock,
  ScopeSnapshot,
  SessionSummary,
  Thread,
  ToolCallState,
  Turn,
} from '@openmanager/protocol'
import { applySnapshot, withSessionUpserted } from '../src/state'
import type { EnvironmentState } from '../src/types'

/** Sessions as the environment states them (a snapshot, an open), filed one by one. */
export function applySessionList(
  state: EnvironmentState,
  sessions: readonly SessionSummary[],
): EnvironmentState {
  return sessions.reduce((next, session) => withSessionUpserted(next, session), state)
}

/**
 * A whole thread as its snapshot states it. Pending requests without a turn
 * belong to the open turn (or the last one); the order defaults to the
 * messages' own.
 */
export function loadThread(
  state: EnvironmentState,
  thread: Thread,
  page: {
    turns: Turn[]
    messages: Message[]
    interactions?: Array<{ turnId?: string; interaction: Interaction }>
    reasoning?: ReasoningBlock[]
    tools?: ToolCallState[]
    order?: ActivityRef[]
  },
): EnvironmentState {
  const open = page.turns.find((turn) => turn.state === 'running' || turn.state === 'waiting')
  const fallback = open?.turnId ?? page.turns.at(-1)?.turnId ?? ''
  const snapshot = {
    cursor: {
      scope: {
        type: 'thread',
        environmentId: state.environment?.environmentId ?? 'environment-1',
        sessionId: thread.sessionId,
        threadId: thread.threadId,
      },
      epoch: 'test',
      sequence: 1,
    },
    state: {
      thread,
      turns: page.turns,
      messages: page.messages,
      reasoning: page.reasoning ?? [],
      tools: page.tools ?? [],
      order:
        page.order ??
        page.messages.map((message) => ({
          kind: 'message' as const,
          id: message.messageId,
          turnId: message.turnId,
        })),
      listing: {},
      interactions: (page.interactions ?? []).map((item) => ({
        turnId: item.turnId ?? fallback,
        interaction: item.interaction,
      })),
    },
  } as ScopeSnapshot
  return applySnapshot(state, snapshot)
}
