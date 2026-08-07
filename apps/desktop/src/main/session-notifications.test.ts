import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentpack/contract'
import { describeSessionEvent } from './session-notifications'

function event(overrides: Partial<AgentEvent> & Pick<AgentEvent, 'category' | 'event' | 'data'>) {
  return {
    id: 'evt-1',
    timestamp: new Date().toISOString(),
    seq: 1,
    providerId: 'cursor',
    threadId: 'thread-1',
    workspaceId: '/home/dev/openmanager',
    sessionId: 'session-1',
    ...overrides,
  } as AgentEvent
}

const permissionRequest = event({
  category: 'permission',
  event: 'permission_request',
  data: {
    requestId: 'req-1',
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1', title: 'Run `pnpm test`' },
    options: [],
  },
})

describe('describeSessionEvent', () => {
  it('names the workspace and leads with the tool the agent wants to run', () => {
    expect(describeSessionEvent(permissionRequest, 'Add desktop notifications')).toEqual({
      title: 'Permission needed · openmanager',
      body: 'Run `pnpm test`\nAdd desktop notifications',
    })
  })

  it('falls back to the provider when nothing describes the session yet', () => {
    const bare = event({
      category: 'permission',
      event: 'permission_request',
      data: {
        requestId: 'req-1',
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1', title: '' },
        options: [],
      },
      workspaceId: undefined,
    })
    expect(describeSessionEvent(bare)).toEqual({ title: 'Permission needed', body: 'Cursor' })
  })

  it('does not print the same line twice when the label repeats the detail', () => {
    const content = describeSessionEvent(permissionRequest, 'Run `pnpm test`')
    expect(content?.body).toBe('Run `pnpm test`')
  })

  it('uses the first question when a question request carries no title', () => {
    const question = event({
      category: 'session',
      event: 'question_request',
      data: {
        requestId: 'req-2',
        sessionId: 'session-1',
        questions: [{ questionId: 'q1', prompt: 'Which database should I use?', options: [] }],
      },
    })
    expect(describeSessionEvent(question)).toEqual({
      title: 'Question for you · openmanager',
      body: 'Which database should I use?',
    })
  })

  it('announces a finished turn', () => {
    const completed = event({
      category: 'lifecycle',
      event: 'prompt_completed',
      data: { stopReason: 'end_turn' },
    })
    expect(describeSessionEvent(completed, 'Add desktop notifications')).toEqual({
      title: 'Turn finished · openmanager',
      body: 'Add desktop notifications',
    })
  })

  it('stays quiet for a turn the user cancelled themselves', () => {
    const cancelled = event({
      category: 'lifecycle',
      event: 'prompt_completed',
      data: { stopReason: 'cancelled' },
    })
    expect(describeSessionEvent(cancelled, 'Add desktop notifications')).toBeNull()
  })

  it('stays quiet for events with nothing for the user to do', () => {
    const chunk = event({
      category: 'stream',
      event: 'agent_message_chunk',
      data: { messageId: 'm1', content: { type: 'text' as const, text: 'hi' } },
    })
    expect(describeSessionEvent(chunk)).toBeNull()
  })

  it('ignores the desktop bookkeeping threads', () => {
    const probe = event({
      category: 'lifecycle',
      event: 'prompt_completed',
      data: { stopReason: 'end_turn' },
      threadId: 'desktop-bootstrap:cursor',
    })
    expect(describeSessionEvent(probe)).toBeNull()
  })

  it('truncates a long prompt rather than letting the platform cut it', () => {
    const content = describeSessionEvent(permissionRequest, 'a'.repeat(200))
    expect(content?.body.split('\n')[1]).toBe(`${'a'.repeat(59)}…`)
  })
})
