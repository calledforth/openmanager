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
const workspace = {
  workspaceId: 'workspace-1',
  name: 'Project',
  path: '/home/user/project',
  lastUsedAt: '2026-09-06T04:00:00Z',
  lastActivityAt: '2026-09-06T04:00:00Z',
  capabilities: { git: false, providers: [] },
  exists: true,
}
const session = { sessionId: 'session-1', workspaceId: 'workspace-1', title: 'Example' }
const sessionSummary = {
  ...session,
  status: 'idle' as const,
  providerId: 'opencode',
  updatedAt: '2026-09-06T05:00:00Z',
}
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
  {
    type: 'command',
    requestId: 'rename',
    name: 'session.rename',
    payload: { sessionId: 'session-1', title: 'Example' },
  },
  {
    type: 'command',
    requestId: 'delete',
    name: 'session.delete',
    payload: { sessionId: 'session-1' },
  },
  { type: 'command', requestId: 'r-1', name: 'environment.get', payload: null },
  { type: 'command', requestId: 'r-2', name: 'workspace.list', payload: null },
  {
    type: 'command',
    requestId: 'r-11',
    name: 'workspace.add',
    payload: { path: '/home/user/project', name: 'Project' },
  },
  {
    type: 'command',
    requestId: 'r-12',
    name: 'workspace.remove',
    payload: { workspaceId: 'workspace-1' },
  },
  {
    type: 'command',
    requestId: 'r-14',
    name: 'workspace.icon',
    payload: { workspaceId: 'workspace-1' },
  },
  {
    type: 'command',
    requestId: 'r-3',
    name: 'session.list',
    payload: { workspaceId: 'workspace-1', limit: 50 },
  },
  {
    type: 'command',
    requestId: 'r-4',
    name: 'session.create',
    payload: {
      environmentId: 'environment-1',
      workspaceId: 'workspace-1',
      providerId: 'opencode',
      title: 'Example',
    },
  },
  { type: 'command', requestId: 'r-5', name: 'session.open', payload: { sessionId: 'session-1' } },
  {
    type: 'command',
    requestId: 'r-13',
    name: 'session.history',
    payload: { sessionId: 'session-1', threadId: 'thread-1', limit: 50 },
  },
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
  'session.rename': { type: 'response', requestId: 'rename', payload: { session } },
  'session.delete': { type: 'response', requestId: 'delete', payload: null },
  'environment.get': {
    type: 'response',
    requestId: 'r-1',
    payload: { environment: { environmentId: 'env-1', name: 'Example' } },
  },
  'workspace.list': {
    type: 'response',
    requestId: 'r-2',
    payload: {
      workspaces: [
        {
          workspaceId: 'workspace-1',
          name: 'Project',
          path: 'workspace-1',
          lastUsedAt: null,
          lastActivityAt: null,
          capabilities: { git: false, providers: [] },
          exists: true,
        },
      ],
    },
  },
  'workspace.add': { type: 'response', requestId: 'r-11', payload: { workspace } },
  'workspace.remove': { type: 'response', requestId: 'r-12', payload: null },
  'workspace.icon': {
    type: 'response',
    requestId: 'r-14',
    payload: { iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
  },
  'session.list': {
    type: 'response',
    requestId: 'r-3',
    payload: { sessions: [sessionSummary], nextCursor: null },
  },
  'session.create': { type: 'response', requestId: 'r-4', payload: { session, thread } },
  'session.open': {
    type: 'response',
    requestId: 'r-5',
    payload: { session: sessionSummary, threads: [thread] },
  },
  'session.history': {
    type: 'response',
    requestId: 'r-13',
    payload: { messages: [], turns: [turn], interactions: [], nextCursor: null },
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
    payload: {
      workspace: {
        workspaceId: 'workspace-1',
        name: 'Project',
        path: 'workspace-1',
        lastUsedAt: null,
        lastActivityAt: null,
        capabilities: { git: false, providers: [] },
        exists: true,
      },
    },
  },
  {
    ...base,
    name: 'workspace.removed',
    scope: environmentScope,
    payload: { workspaceId: 'workspace-1' },
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
  {
    ...base,
    name: 'session.composer.updated',
    scope: environmentScope,
    payload: {
      sessionId: 'session-1',
      composer: {
        modelId: 'claude-opus',
        modeId: 'plan',
        configValues: { effort: 'high', fast: true },
        configOptions: [
          {
            type: 'select',
            id: 'effort',
            name: 'Effort',
            category: 'thought_level',
            currentValue: 'high',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          },
          { type: 'boolean', id: 'fast', name: 'Fast mode', currentValue: true },
        ],
      },
    },
  },
  {
    ...base,
    name: 'composer.preferences.updated',
    scope: environmentScope,
    payload: {
      workspaceId: 'workspace-1',
      providerId: 'claude-code',
      preference: { modelId: 'claude-opus', configValues: { effort: 'high' } },
    },
  },
  {
    ...base,
    name: 'provider.catalog.updated',
    scope: environmentScope,
    payload: {
      profile: {
        providerId: 'claude-code',
        availableModels: [{ modelId: 'claude-opus', name: 'Opus', effortLevels: ['low', 'high'] }],
        availableModes: [{ id: 'plan', name: 'Plan' }],
        defaultModelId: 'claude-opus',
        updatedAt: 1,
      },
    },
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
  {
    ...base,
    name: 'interaction.expired',
    scope: threadScope,
    payload: {
      turnId: 'turn-1',
      response: {
        kind: 'question',
        interactionId: 'interaction-1',
        outcome: { outcome: 'cancelled', reason: 'timeout' },
      },
    },
  },
] satisfies ProofEvent[]
