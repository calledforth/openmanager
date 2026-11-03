import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofResponseSchemas,
  ScopeSnapshotSchema,
  type DurableEvent,
  type TransientEvent,
} from '@openmanager/protocol/node'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'
import { createPersistentEventService } from '../src/event-service.js'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createReplayReader } from '../src/db/replay.js'
import { readThreadState } from '../src/db/session-store.js'

const registered: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === '/workspace/project'
    ? { providerId: 'claude', cwd: '/workspace/project' }
    : undefined

const directories: string[] = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

/** A durable environment with one running turn the provider is driving. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-notices-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('/workspace/project', 'Project', '/workspace/project', 1, 1);
  `)
  const published: DurableEvent[] = []
  const transient: TransientEvent[] = []
  /** Everything in the order the one delivery queue takes it. */
  const timeline: string[] = []
  const events = createPersistentEventService(
    database,
    (record) => {
      published.push(record)
      timeline.push(record.event.name)
    },
    {
      deliverTransient: (event) => {
        transient.push(event)
        timeline.push(event.name)
      },
    },
  )
  const runtime = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
    prompt: vi.fn(() => new Promise<void>(() => undefined)),
    cancel: vi.fn(),
  }
  const service = createThreadService(
    runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
    { rejection: () => undefined },
    events.append,
    events.publishTransient,
    registered,
    { database, flush: events.flush, appendAtomic: events.appendAtomic },
  )
  service.setEnvironmentId('environment-1')
  const created = ProofResponseSchemas['session.create'].parse(
    service.dispatch({
      type: 'command',
      requestId: 'create',
      name: 'session.create',
      payload: {
        environmentId: 'environment-1',
        workspaceId: '/workspace/project',
        providerId: 'claude',
      },
    }),
  ).payload
  const target = { sessionId: created.session.sessionId, threadId: created.thread.threadId }
  const started = ProofResponseSchemas['turn.send'].parse(
    service.dispatch({
      type: 'command',
      requestId: 'send',
      name: 'turn.send',
      payload: { ...target, text: 'hello' },
    }),
  ).payload
  await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1))
  let seq = 0
  const base = () => ({
    id: `runtime-${++seq}`,
    seq,
    timestamp: '2026-10-09T10:00:00.000Z',
    providerId: 'claude' as const,
    threadId: target.threadId,
    workspaceId: '/workspace/project',
    sessionId: 'provider-session',
    messageId: 'assistant-1',
  })
  const emit = (event: Record<string, unknown>) =>
    service.onRuntimeEvent({ ...base(), ...event } as Parameters<typeof service.onRuntimeEvent>[0])
  emit({
    category: 'lifecycle',
    event: 'prompt_started',
    data: { prompt: 'hello', userMessageId: started.userMessage.messageId },
  })
  const text = (value: string) =>
    emit({
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: value } },
    })
  const notice = (data: Record<string, unknown>) =>
    emit({ category: 'session', event: 'provider_notice', data })
  const retrying = () =>
    emit({
      category: 'error',
      event: 'rpc_error',
      data: {
        source: 'claude/api',
        message: 'provider detail',
        recoverable: true,
        problem: { code: 'overloaded', retry: { attempt: 2, maxAttempts: 10, delayMs: 1000 } },
      },
    })
  const state = () => {
    events.flush()
    return readThreadState(database, target)!
  }
  return {
    database,
    events,
    published,
    transient,
    timeline,
    target,
    started,
    emit,
    text,
    notice,
    retrying,
    state,
  }
}

const liveNames = (h: Awaited<ReturnType<typeof setup>>) =>
  h.timeline.filter(
    (name) => !['session.created', 'session.updated', 'workspace.updated'].includes(name),
  )

describe('live notices', () => {
  it('delivers output the batcher held before a retry notice that followed it', async () => {
    const h = await setup()
    h.text('Partial answer')
    h.retrying()
    expect(liveNames(h)).toEqual(['thread.created', 'turn.started', 'message.delta', 'turn.notice'])
  })

  it('publishes retries and compaction progress live, and stores neither', async () => {
    const h = await setup()
    h.retrying()
    h.notice({ kind: 'compacting', message: 'Compacting the conversation' })
    h.events.flush()

    expect(
      h.transient.map((event) => [event.name, (event.payload as { kind: string }).kind]),
    ).toEqual([
      ['turn.notice', 'retrying'],
      ['turn.notice', 'compacting'],
    ])
    expect(h.transient[0]?.payload).toMatchObject({
      turnId: h.started.turn.turnId,
      retry: { attempt: 2, maxAttempts: 10, cause: 'overloaded' },
    })
    expect(JSON.stringify(h.transient)).not.toContain('provider detail')
    expect(h.published.map((record) => record.event.name)).not.toContain('turn.notice')
    expect(h.database.prepare('SELECT COUNT(*) AS count FROM turn_notices').get()).toEqual({
      count: 0,
    })
    expect(h.state().turns.at(-1)?.state).toBe('running')
  })

  it('says a live notice is over once the provider moves on, and only then', async () => {
    const h = await setup()
    h.retrying()
    h.retrying()
    expect(h.transient.map((event) => event.name)).toEqual(['turn.notice', 'turn.notice'])
    h.text('Back')
    expect(liveNames(h).slice(-3)).toEqual(['turn.notice', 'message.delta', 'turn.notice.cleared'])
    // Nothing was out any more, so nothing more is said.
    h.text(' again')
    expect(h.transient.filter((event) => event.name === 'turn.notice.cleared')).toHaveLength(1)
  })

  it('says a live notice is over when the turn ends with it still out', async () => {
    const h = await setup()
    h.notice({ kind: 'compacting', message: 'Compacting the conversation' })
    h.emit({ category: 'lifecycle', event: 'prompt_completed', data: { stopReason: 'end_turn' } })
    h.events.flush()
    expect(liveNames(h).slice(-3)).toEqual(['turn.notice', 'turn.completed', 'turn.notice.cleared'])
  })

  it('ends a compaction notice with the compaction it announced', async () => {
    const h = await setup()
    h.notice({ kind: 'compacting', message: 'Compacting the conversation' })
    h.notice({ kind: 'compacted', message: 'Conversation compacted' })
    expect(liveNames(h).slice(-3)).toEqual([
      'turn.notice',
      'turn.notice.recorded',
      'turn.notice.cleared',
    ])
  })
})

describe('durable notices', () => {
  it('stores a durable notice where it happened in the turn and replays it', async () => {
    const h = await setup()
    h.text('Before')
    h.notice({
      kind: 'compacted',
      message: 'Conversation compacted automatically',
      compaction: { trigger: 'auto', tokensBefore: 180_000, tokensAfter: 40_000 },
    })
    h.text('After')
    h.emit({ category: 'lifecycle', event: 'prompt_completed', data: { stopReason: 'end_turn' } })

    const state = h.state()
    expect(state.order.map((ref) => ref.kind)).toEqual(['message', 'message', 'notice', 'message'])
    expect(state.notices).toEqual([
      expect.objectContaining({
        kind: 'compacted',
        turnId: h.started.turn.turnId,
        compaction: { trigger: 'auto', tokensBefore: 180_000, tokensAfter: 40_000 },
      }),
    ])
    // The notice ended the text run: the reply reads as two runs around it.
    expect(state.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
    const recorded = h.published.find((record) => record.event.name === 'turn.notice.recorded')
    expect(recorded?.cursor.sequence).toBeGreaterThan(0)
  })

  it('keeps every notice, however many and however long', async () => {
    const h = await setup()
    for (let index = 0; index < 120; index += 1) {
      h.notice({ kind: 'warning', message: `${index}:${'w'.repeat(4_000)}` })
    }
    const state = h.state()
    expect(state.notices).toHaveLength(120)
    expect(state.notices.at(-1)?.message.startsWith('119:')).toBe(true)
    expect(state.notices.at(-1)?.message).toHaveLength(4_004)
    expect(state.order.filter((ref) => ref.kind === 'notice').map((ref) => ref.id)).toEqual(
      state.notices.map((notice) => notice.noticeId),
    )
  })

  it('refuses a notice for a turn that has ended', async () => {
    const h = await setup()
    h.emit({ category: 'lifecycle', event: 'prompt_completed', data: { stopReason: 'end_turn' } })
    h.events.flush()
    expect(() =>
      h.events.repository.appendEvents(
        { type: 'thread', environmentId: 'environment-1', ...h.target },
        [
          {
            type: 'event',
            name: 'turn.notice.recorded',
            eventId: 'late-notice',
            timestamp: '2026-10-09T10:00:01.000Z',
            scope: { type: 'thread', environmentId: 'environment-1', ...h.target },
            payload: {
              noticeId: 'late-notice',
              turnId: h.started.turn.turnId,
              kind: 'info',
              message: 'Late',
            },
          },
        ],
      ),
    ).toThrow(/finished turn/)
  })
})

describe('typed failures', () => {
  it('types a failure, keeps it with the turn, and hands it to a late joiner', async () => {
    const h = await setup()
    h.notice({ kind: 'usage_warning', message: 'Approaching your 5-hour usage limit' })
    h.emit({
      category: 'error',
      event: 'runtime_error',
      data: {
        kind: 'provider',
        message: "You've hit your limit",
        problem: { code: 'usage_limit', resetsAt: '2026-10-09T15:00:00.000Z' },
      },
    })
    h.events.flush()

    const failed = h.published.find((record) => record.event.name === 'turn.failed')
    const failure = {
      reason: 'usage_limit',
      message: "You've reached your usage limit.",
      resetsAt: '2026-10-09T15:00:00.000Z',
    }
    expect(failed?.event.payload).toEqual({ turnId: h.started.turn.turnId, ...failure })
    expect(JSON.stringify(failed)).not.toContain('hit your limit')
    expect(h.state().turns.at(-1)).toMatchObject({ state: 'failed', failure })

    // A client that joins now gets the notice and the failure in its snapshot.
    const reader = createReplayReader(h.database, {
      epoch: 'epoch-1',
      environment: () => ({ environmentId: 'environment-1', name: 'Test' }),
      workspaces: () => [],
    })
    const scope = { type: 'thread', environmentId: 'environment-1', ...h.target } as const
    const joined = reader.read(scope, null)
    expect(joined.mode).toBe('snapshot')
    const snapshot = ScopeSnapshotSchema.parse(
      (joined as Extract<typeof joined, { mode: 'snapshot' }>).snapshot,
    )
    const state = snapshot.state as {
      notices: { kind: string }[]
      order: { kind: string }[]
      turns: { failure?: { reason: string } }[]
    }
    expect(state.notices.map((notice) => notice.kind)).toEqual(['usage_warning'])
    expect(state.order.map((ref) => ref.kind)).toContain('notice')
    expect(state.turns.at(-1)?.failure?.reason).toBe('usage_limit')
  })

  it("keeps the provider's explanation with the failure, whole, across a read", async () => {
    const h = await setup()
    const detail = `Run /model to pick a different model. ${'x'.repeat(5_000)}`
    h.emit({
      category: 'error',
      event: 'runtime_error',
      data: { kind: 'provider', message: 'API Error', problem: { code: 'unknown', detail } },
    })
    expect(h.state().turns.at(-1)?.failure).toEqual({
      reason: 'provider_error',
      message: 'The provider failed to complete the turn.',
      detail,
    })
  })

  it('offers sign-in for an unauthorized provider and compaction when Claude says so', async () => {
    const first = await setup()
    first.emit({ category: 'error', event: 'auth_required', data: { message: 'Log in' } })
    first.events.flush()
    expect(
      first.published.find((record) => record.event.name === 'turn.failed')?.event.payload,
    ).toMatchObject({ reason: 'authentication_required', action: 'sign_in' })

    const second = await setup()
    second.emit({
      category: 'error',
      event: 'runtime_error',
      data: {
        kind: 'provider',
        message: 'Prompt is too long',
        problem: { code: 'context_window_exceeded', action: 'compact' },
      },
    })
    expect(second.state().turns.at(-1)?.failure).toEqual({
      reason: 'context_window_exceeded',
      message: "The conversation is too long for the model's context window.",
      action: 'compact',
    })
  })
})
