import { describe, expect, it } from 'vitest'
import {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  ProofCommandSchema,
  ProofResponseSchemas,
  SESSION_LIST_EPOCH,
  SessionSummarySchema,
  pageSessionSummaries,
  pageThreadMessages,
  parseProofResult,
  resolvePageLimit,
  sessionListCursorOf,
} from '@openmanager/protocol'

const summary = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  title: 'Example',
  status: 'idle',
  providerId: 'opencode',
  updatedAt: '2026-09-14T04:00:00.000Z',
} as const

describe('session list and history pagination', () => {
  it('accepts an empty first page of summaries', () => {
    const command = ProofCommandSchema.parse({
      type: 'command',
      requestId: 'list-empty',
      name: 'session.list',
      payload: {},
    })
    expect(
      parseProofResult(command, {
        type: 'response',
        requestId: 'list-empty',
        payload: { sessions: [], nextCursor: null },
      }),
    ).toMatchObject({ payload: { sessions: [], nextCursor: null } })
  })

  it('accepts one page of summaries and rejects a transcript-shaped session', () => {
    expect(
      ProofCommandSchema.parse({
        type: 'command',
        requestId: 'list-one',
        name: 'session.list',
        payload: { workspaceId: 'workspace-1', limit: 50 },
      }).name,
    ).toBe('session.list')
    const page = parseProofResult(
      { name: 'session.list' as const, requestId: 'list-one' },
      {
        type: 'response',
        requestId: 'list-one',
        payload: { sessions: [summary], nextCursor: null },
      },
    )
    if (page.type !== 'response') throw new Error('expected a page')
    expect(page.payload.sessions).toEqual([SessionSummarySchema.parse(summary)])
    expect(
      ProofResponseSchemas['session.list'].safeParse({
        type: 'response',
        requestId: 'list-one',
        payload: {
          sessions: [{ sessionId: 'session-1', workspaceId: 'workspace-1', title: 'Example' }],
          nextCursor: null,
        },
      }).success,
    ).toBe(false)
  })

  it('accepts a multi-page cursor and rejects an oversized limit', () => {
    const command = ProofCommandSchema.parse({
      type: 'command',
      requestId: 'list-more',
      name: 'session.list',
      payload: {
        cursor: { updatedAt: summary.updatedAt, sessionId: summary.sessionId },
        limit: PAGE_LIMIT_MAX,
      },
    })
    expect(
      parseProofResult(command, {
        type: 'response',
        requestId: 'list-more',
        payload: {
          sessions: [{ ...summary, sessionId: 'session-0' }],
          nextCursor: { updatedAt: '2026-09-13T00:00:00.000Z', sessionId: 'session-0' },
        },
      }),
    ).toMatchObject({ payload: { nextCursor: { sessionId: 'session-0' } } })
    expect(
      ProofCommandSchema.safeParse({
        type: 'command',
        requestId: 'list-over',
        name: 'session.list',
        payload: { limit: PAGE_LIMIT_MAX + 1 },
      }).success,
    ).toBe(false)
  })

  it('keeps session.open free of messages and pages history separately', () => {
    expect(
      ProofResponseSchemas['session.open'].parse({
        type: 'response',
        requestId: 'open-1',
        payload: { session: summary, threads: [{ threadId: 'thread-1', sessionId: 'session-1' }] },
      }).payload,
    ).not.toHaveProperty('messages')
    const history = ProofCommandSchema.parse({
      type: 'command',
      requestId: 'history-1',
      name: 'session.history',
      payload: { sessionId: 'session-1', threadId: 'thread-1', cursor: { ordinal: 20 } },
    })
    expect(
      parseProofResult(history, {
        type: 'response',
        requestId: 'history-1',
        payload: { messages: [], turns: [], interactions: [], nextCursor: { ordinal: 0 } },
      }),
    ).toMatchObject({ payload: { nextCursor: { ordinal: 0 } } })
  })
})

describe('in-memory pagination helpers', () => {
  const summaries = [1, 2, 3].map((index) => ({
    ...summary,
    sessionId: `session-${index}`,
    title: `S${index}`,
    updatedAt: new Date(index * 1_000).toISOString(),
  }))

  it('defaults the limit and falls back to the epoch for undated sessions', () => {
    expect(resolvePageLimit(undefined)).toBe(PAGE_LIMIT_DEFAULT)
    expect(resolvePageLimit(7)).toBe(7)
    expect(sessionListCursorOf({ sessionId: 'session-x', workspaceId: 'workspace-1' })).toEqual({
      updatedAt: SESSION_LIST_EPOCH,
      sessionId: 'session-x',
    })
  })

  it('covers empty, one-page and multi-page in-memory lists', () => {
    expect(pageSessionSummaries([], { limit: 2 })).toEqual({ sessions: [], nextCursor: null })
    expect(pageSessionSummaries(summaries, { limit: 10 }).nextCursor).toBeNull()
    const first = pageSessionSummaries(summaries, { limit: 2 })
    expect(first.sessions.map((session) => session.sessionId)).toEqual(['session-3', 'session-2'])
    expect(first.nextCursor).toEqual({
      updatedAt: summaries[1]!.updatedAt,
      sessionId: 'session-2',
    })
    const rest = pageSessionSummaries(summaries, { cursor: first.nextCursor!, limit: 2 })
    expect(rest.sessions.map((session) => session.sessionId)).toEqual(['session-1'])
    expect(rest.nextCursor).toBeNull()
  })

  it('scopes to a workspace and breaks updatedAt ties by sessionId descending', () => {
    const tied = [
      { sessionId: 'session-a', workspaceId: 'workspace-1', updatedAt: summary.updatedAt },
      { sessionId: 'session-b', workspaceId: 'workspace-1', updatedAt: summary.updatedAt },
      { sessionId: 'session-c', workspaceId: 'workspace-2', updatedAt: summary.updatedAt },
    ]
    const page = pageSessionSummaries(tied, { workspaceId: 'workspace-1', limit: 1 })
    expect(page.sessions.map((session) => session.sessionId)).toEqual(['session-b'])
    expect(page.nextCursor).toEqual({ updatedAt: summary.updatedAt, sessionId: 'session-b' })
    const rest = pageSessionSummaries(tied, {
      workspaceId: 'workspace-1',
      cursor: page.nextCursor!,
      limit: 1,
    })
    expect(rest.sessions.map((session) => session.sessionId)).toEqual(['session-a'])
    expect(rest.nextCursor).toBeNull()
  })

  it('pages an in-memory transcript backwards', () => {
    const messages = [0, 1, 2, 3].map((ordinal) => ({
      messageId: `m-${ordinal}`,
      threadId: 'thread-1',
      turnId: 'turn-1',
      role: 'user' as const,
      content: [{ type: 'text' as const, text: String(ordinal) }],
    }))
    const newest = pageThreadMessages(messages, { limit: 2 })
    expect(newest.messages.map((message) => message.messageId)).toEqual(['m-2', 'm-3'])
    expect(newest.nextCursor).toEqual({ ordinal: 2 })
    const older = pageThreadMessages(messages, { cursor: newest.nextCursor!, limit: 2 })
    expect(older.messages.map((message) => message.messageId)).toEqual(['m-0', 'm-1'])
    expect(older.nextCursor).toBeNull()
    expect(pageThreadMessages(messages, { cursor: { ordinal: 99 }, limit: 10 })).toEqual({
      messages,
      nextCursor: null,
    })
  })
})
