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
  type EventEnvelope,
} from '@openmanager/protocol/node'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'
import { createPersistentEventService } from '../src/event-service.js'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createReplayReader } from '../src/db/replay.js'
import { listSessionHistory } from '../src/db/session-store.js'

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
  const transient: EventEnvelope[] = []
  const events = createPersistentEventService(database, (record) => published.push(record), {
    sessionProviderId: () => 'claude',
  })
  const runtime = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
    prompt: vi.fn(() => new Promise<void>(() => undefined)),
    cancel: vi.fn(),
  }
  const service = createThreadService(
    runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
    { rejection: () => undefined },
    events.append,
    (event) => transient.push(event),
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
  const history = () => {
    events.flush()
    return listSessionHistory(database, target)!
  }
  return {
    database,
    service,
    events,
    published,
    transient,
    target,
    started,
    emit,
    text,
    notice,
    history,
  }
}

describe('turn notices', () => {
  it('publishes retries and compaction progress live, and stores neither', async () => {
    const h = await setup()
    h.emit({
      category: 'error',
      event: 'rpc_error',
      data: {
        source: 'claude/api',
        message: 'provider detail',
        recoverable: true,
        problem: { code: 'overloaded', retry: { attempt: 2, maxAttempts: 10, delayMs: 1000 } },
      },
    })
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
    // The turn lives on.
    expect(h.history().turns.at(-1)?.state).toBe('running')
  })

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

    const page = h.history()
    expect(page.order.map((ref) => ref.kind)).toEqual(['message', 'message', 'notice', 'message'])
    expect(page.notices).toEqual([
      expect.objectContaining({
        kind: 'compacted',
        turnId: h.started.turn.turnId,
        compaction: { trigger: 'auto', tokensBefore: 180_000, tokensAfter: 40_000 },
      }),
    ])
    // The notice ended the text run: the reply reads as two runs around it.
    expect(page.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
    const recorded = h.published.find((record) => record.event.name === 'turn.notice.recorded')
    expect(recorded?.cursor.sequence).toBeGreaterThan(0)
  })

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
    expect(failed?.event.payload).toEqual({
      turnId: h.started.turn.turnId,
      reason: 'usage_limit',
      message: "You've reached your usage limit.",
      resetsAt: '2026-10-09T15:00:00.000Z',
    })
    expect(JSON.stringify(failed)).not.toContain('hit your limit')
    const turn = h.history().turns.at(-1)
    expect(turn).toMatchObject({
      state: 'failed',
      failure: {
        reason: 'usage_limit',
        message: "You've reached your usage limit.",
        resetsAt: '2026-10-09T15:00:00.000Z',
      },
    })

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
      notices?: { kind: string }[]
      order?: { kind: string }[]
      turns: { failure?: { reason: string } }[]
    }
    expect(state.notices?.map((notice) => notice.kind)).toEqual(['usage_warning'])
    expect(state.order?.map((ref) => ref.kind)).toContain('notice')
    expect(state.turns.at(-1)?.failure?.reason).toBe('usage_limit')

    // A client that was here before the notice replays it in order.
    const first = h.published.find((record) => record.cursor.scope.type === 'thread')!
    const replayed = reader.read(scope, first.cursor)
    expect(replayed.mode).toBe('replay')
    expect(
      (replayed as Extract<typeof replayed, { mode: 'replay' }>).events.map(
        (record) => record.event.name,
      ),
    ).toEqual(expect.arrayContaining(['turn.notice.recorded', 'turn.failed']))
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
    expect(second.history().turns.at(-1)?.failure).toEqual({
      reason: 'context_window_exceeded',
      message: "The conversation is too long for the model's context window.",
      action: 'compact',
    })
  })
})
