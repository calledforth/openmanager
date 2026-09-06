import type {
  Cursor,
  DurableEvent,
  ReplayCommand,
  ReplayResponse,
  ScopeSnapshot,
  SubscriptionEvent,
} from '@openmanager/protocol'
import { environmentScope, sessionScope, threadScope, proofEvents } from './proof-fixtures.js'

export const replayCursor = { scope: threadScope, epoch: 'epoch-1', sequence: 3 } satisfies Cursor
export const replayCommand: ReplayCommand = {
  type: 'command',
  name: 'subscription.replay',
  requestId: 'replay-1',
  payload: { scope: threadScope, cursor: replayCursor },
}
export const replayRecords: DurableEvent[] = [
  {
    cursor: { ...replayCursor, sequence: 4 },
    event: { ...proofEvents.find((e) => e.name === 'message.delta')!, eventId: 'event-4' },
  },
  {
    cursor: { ...replayCursor, sequence: 5 },
    event: { ...proofEvents.find((e) => e.name === 'turn.completed')!, eventId: 'event-5' },
  },
]
export const replayResponse: ReplayResponse = {
  type: 'response',
  requestId: 'replay-1',
  payload: {
    mode: 'replay',
    subscriptionId: 'sub-1',
    from: replayCursor,
    to: { ...replayCursor, sequence: 5 },
    events: replayRecords,
  },
}
export const scopeSnapshots: ScopeSnapshot[] = [
  {
    cursor: { scope: environmentScope, epoch: 'epoch-env', sequence: 1 },
    state: {
      environment: { environmentId: 'env-1', name: 'Example' },
      workspaces: [{ workspaceId: 'workspace-1', name: 'Example' }],
      sessions: [{ sessionId: 'session-1', workspaceId: 'workspace-1', title: 'Example' }],
    },
  },
  {
    cursor: { scope: sessionScope, epoch: 'epoch-session', sequence: 1 },
    state: {
      session: { sessionId: 'session-1', workspaceId: 'workspace-1', title: 'Example' },
      threads: [{ threadId: 'thread-1', sessionId: 'session-1' }],
    },
  },
  {
    cursor: { ...replayCursor, sequence: 5 },
    state: {
      thread: { threadId: 'thread-1', sessionId: 'session-1' },
      turns: [{ turnId: 'turn-1', threadId: 'thread-1', state: 'completed' }],
      messages: [
        {
          messageId: 'message-2',
          turnId: 'turn-1',
          threadId: 'thread-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
      reasoning: [
        { messageId: 'message-2', turnId: 'turn-1', phase: 'stop', content: [], tokens: 0 },
      ],
      tools: [{ toolCallId: 'tool-1', turnId: 'turn-1', status: 'completed' }],
      interactions: [],
    },
  },
]
export const snapshotResponse: ReplayResponse = {
  type: 'response',
  requestId: 'replay-1',
  payload: {
    mode: 'snapshot',
    subscriptionId: 'sub-2',
    reason: 'gap_expired',
    snapshot: scopeSnapshots[2],
  },
}
export const subscriptionEvent: SubscriptionEvent = {
  type: 'event',
  name: 'subscription.event',
  payload: { subscriptionId: 'sub-1', record: replayRecords[0] },
}
