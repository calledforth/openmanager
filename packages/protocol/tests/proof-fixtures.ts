import type {
  ProofCommand,
  ProofCommandName,
  ProofEvent,
  ProofResponse,
} from '@openmanager/protocol'

export const environmentScope = { type: 'environment', environmentId: 'env-1' } as const
export const sessionScope = {
  type: 'session',
  environmentId: 'env-1',
  sessionId: 'session-1',
} as const
export const threadScope = {
  type: 'thread',
  environmentId: 'env-1',
  sessionId: 'session-1',
  threadId: 'thread-1',
} as const
const session = { sessionId: 'session-1', workspaceId: 'workspace-1', title: 'Example' }
const thread = { threadId: 'thread-1', sessionId: 'session-1' }
const turn = { turnId: 'turn-1', threadId: 'thread-1', state: 'running' } as const
const userMessage = {
  messageId: 'message-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  role: 'user',
  content: [{ type: 'text', text: 'Hello' }],
} as const

export const proofCommands = [
  { type: 'command', requestId: 'r-1', name: 'environment.get', payload: null },
  { type: 'command', requestId: 'r-2', name: 'workspace.list', payload: null },
  {
    type: 'command',
    requestId: 'r-3',
    name: 'session.list',
    payload: { workspaceId: 'workspace-1' },
  },
  {
    type: 'command',
    requestId: 'r-4',
    name: 'session.create',
    payload: { workspaceId: 'workspace-1', title: 'Example' },
  },
  { type: 'command', requestId: 'r-5', name: 'session.open', payload: { sessionId: 'session-1' } },
  {
    type: 'command',
    requestId: 'r-6',
    name: 'turn.send',
    payload: { sessionId: 'session-1', threadId: 'thread-1', text: 'Hello' },
  },
  {
    type: 'command',
    requestId: 'r-7',
    name: 'turn.interrupt',
    payload: { sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1' },
  },
  {
    type: 'command',
    requestId: 'r-8',
    name: 'interaction.respond',
    payload: {
      sessionId: 'session-1',
      threadId: 'thread-1',
      response: {
        kind: 'permission',
        interactionId: 'interaction-1',
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    },
  },
  {
    type: 'command',
    requestId: 'r-9',
    name: 'subscription.subscribe',
    payload: { scope: threadScope },
  },
  {
    type: 'command',
    requestId: 'r-10',
    name: 'subscription.unsubscribe',
    payload: { subscriptionId: 'sub-1' },
  },
] satisfies ProofCommand[]

export const proofResponses = {
  'environment.get': {
    type: 'response',
    requestId: 'r-1',
    payload: { environment: { environmentId: 'env-1', name: 'Example' } },
  },
  'workspace.list': {
    type: 'response',
    requestId: 'r-2',
    payload: { workspaces: [{ workspaceId: 'workspace-1', name: 'Project' }] },
  },
  'session.list': { type: 'response', requestId: 'r-3', payload: { sessions: [session] } },
  'session.create': { type: 'response', requestId: 'r-4', payload: { session, thread } },
  'session.open': {
    type: 'response',
    requestId: 'r-5',
    payload: { session, threads: [thread], messages: [], turns: [turn], interactions: [] },
  },
  'turn.send': {
    type: 'response',
    requestId: 'r-6',
    payload: { turn, userMessage: { ...userMessage, content: [...userMessage.content] } },
  },
  'turn.interrupt': { type: 'response', requestId: 'r-7', payload: { turnId: 'turn-1' } },
  'interaction.respond': { type: 'response', requestId: 'r-8', payload: null },
  'subscription.subscribe': {
    type: 'response',
    requestId: 'r-9',
    payload: { subscriptionId: 'sub-1', scope: threadScope },
  },
  'subscription.unsubscribe': { type: 'response', requestId: 'r-10', payload: null },
} satisfies { [N in ProofCommandName]: ProofResponse<N> }

const base = { type: 'event', eventId: 'event-1', timestamp: '2026-09-06T05:00:00Z' } as const
export const proofEvents = [
  {
    ...base,
    name: 'workspace.updated',
    scope: environmentScope,
    payload: { workspace: { workspaceId: 'workspace-1', name: 'Project' } },
  },
  { ...base, name: 'session.created', scope: environmentScope, payload: { session } },
  {
    ...base,
    name: 'session.updated',
    scope: environmentScope,
    payload: { sessionId: 'session-1', title: 'Renamed' },
  },
  {
    ...base,
    name: 'session.deleted',
    scope: environmentScope,
    payload: { sessionId: 'session-1' },
  },
  { ...base, name: 'thread.created', scope: sessionScope, payload: { thread } },
  {
    ...base,
    name: 'turn.started',
    scope: threadScope,
    payload: { turn, userMessage: { ...userMessage, content: [...userMessage.content] } },
  },
  { ...base, name: 'turn.completed', scope: threadScope, payload: { turnId: 'turn-1' } },
  { ...base, name: 'turn.interrupted', scope: threadScope, payload: { turnId: 'turn-1' } },
  {
    ...base,
    name: 'turn.failed',
    scope: threadScope,
    payload: { turnId: 'turn-1', reason: 'provider_error', message: 'Failed' },
  },
  {
    ...base,
    name: 'turn.notice',
    scope: threadScope,
    payload: { turnId: 'turn-1', message: 'Retrying' },
  },
  {
    ...base,
    name: 'message.delta',
    scope: threadScope,
    payload: {
      turnId: 'turn-1',
      messageId: 'message-2',
      role: 'assistant',
      content: { type: 'text', text: 'Hello' },
    },
  },
  {
    ...base,
    name: 'message.reasoning',
    scope: threadScope,
    payload: { turnId: 'turn-1', messageId: 'message-2', phase: 'stop', tokens: 0 },
  },
  {
    ...base,
    name: 'tool.updated',
    scope: threadScope,
    payload: { turnId: 'turn-1', toolCallId: 'tool-1', status: 'completed' },
  },
  {
    ...base,
    name: 'interaction.requested',
    scope: threadScope,
    payload: {
      turnId: 'turn-1',
      interaction: {
        kind: 'question',
        interactionId: 'interaction-1',
        questions: [{ questionId: 'q-1', prompt: 'Continue?', options: [], allowFreeText: true }],
      },
    },
  },
  {
    ...base,
    name: 'interaction.resolved',
    scope: threadScope,
    payload: {
      turnId: 'turn-1',
      response: {
        kind: 'question',
        interactionId: 'interaction-1',
        outcome: { outcome: 'answered', answers: [{ questionId: 'q-1', text: 'Yes' }] },
      },
    },
  },
] satisfies ProofEvent[]
