import type { Interaction, ProofEvent } from '@openmanager/protocol'

export const ENV = 'env-1'
export const WORKSPACE = { workspaceId: 'C:/repo', name: 'repo' }
export const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: null }
export const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

export const environmentScope = { type: 'environment', environmentId: ENV } as const
export const sessionScope = {
  type: 'session',
  environmentId: ENV,
  sessionId: SESSION.sessionId,
} as const
export const threadScope = {
  type: 'thread',
  environmentId: ENV,
  sessionId: SESSION.sessionId,
  threadId: THREAD.threadId,
} as const

let counter = 0
export const event = <E extends ProofEvent>(
  partial: Omit<E, 'type' | 'eventId' | 'timestamp'> & { eventId?: string },
): E =>
  ({
    type: 'event',
    eventId: partial.eventId ?? `event-${++counter}`,
    timestamp: '2026-09-10T00:00:00.000Z',
    ...partial,
  }) as E

export const turnStarted = (turnId = 'turn-1', text = 'hello') =>
  event({
    name: 'turn.started',
    scope: threadScope,
    payload: {
      turn: { turnId, threadId: THREAD.threadId, state: 'running' },
      userMessage: {
        messageId: `${turnId}-user`,
        threadId: THREAD.threadId,
        turnId,
        role: 'user',
        content: [{ type: 'text', text }],
      },
    },
  })

export const delta = (turnId: string, messageId: string, text: string) =>
  event({
    name: 'message.delta',
    scope: threadScope,
    payload: { messageId, turnId, role: 'assistant', content: { type: 'text', text } },
  })

export const completed = (turnId = 'turn-1') =>
  event({ name: 'turn.completed', scope: threadScope, payload: { turnId } })

export const permission: Interaction = {
  kind: 'permission',
  interactionId: 'interaction-1',
  toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ],
}
