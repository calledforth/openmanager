import { describe, expect, it } from 'vitest'
import {
  PAGE_LIMIT_MAX,
  ProofCommandSchema,
  ProofResponseSchemas,
  SessionSummarySchema,
  parseProofResult,
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
