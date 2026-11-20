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
  type Message,
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
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-phase-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('/workspace/project', 'Project', '/workspace/project', 1, 1);
  `)
  const published: DurableEvent[] = []
  const events = createPersistentEventService(database, (record) => published.push(record), {})
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
  const emit = (event: Record<string, unknown>) =>
    service.onRuntimeEvent({
      id: `runtime-${++seq}`,
      seq,
      timestamp: '2026-11-20T10:00:00.000Z',
      providerId: 'claude',
      threadId: target.threadId,
      workspaceId: '/workspace/project',
      sessionId: 'provider-session',
      messageId: 'assistant-1',
      ...event,
    } as Parameters<typeof service.onRuntimeEvent>[0])
  emit({
    category: 'lifecycle',
    event: 'prompt_started',
    data: { prompt: 'hello', userMessageId: started.userMessage.messageId },
  })
  const text = (value: string, phase?: string) =>
    emit({
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: value }, ...(phase ? { phase } : {}) },
    })
  const tool = (id: string) =>
    emit({
      category: 'tool',
      event: 'tool_call',
      data: { toolCallId: id, title: 'Read', kind: 'read', status: 'completed' },
    })
  const complete = () =>
    emit({ category: 'lifecycle', event: 'prompt_completed', data: { stopReason: 'end_turn' } })
  const state = () => {
    events.flush()
    return readThreadState(database, target)!
  }
  const reader = createReplayReader(database, {
    epoch: 'epoch-1',
    environment: () => ({ environmentId: 'environment-1', name: 'Test' }),
    workspaces: () => [],
  })
  const scope = { type: 'thread', environmentId: 'environment-1', ...target } as const
  return {
    directory,
    database,
    events,
    published,
    target,
    started,
    text,
    tool,
    complete,
    state,
    reader,
    scope,
  }
}

const assistant = (messages: readonly Message[]) =>
  messages
    .filter((message) => message.role === 'assistant')
    .map((message) => ({
      text: message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
      phase: message.phase,
    }))

describe('assistant message phases', () => {
  // A provider that marks only the first chunk of a message must not have it
  // broken in two mid-word, and the unmarked chunk is stored with its message.
  it('keeps an unmarked chunk in the message it continues', async () => {
    const h = await setup()
    h.text('The ans', 'final_answer')
    h.text('wer.')
    h.text('Checking.', 'commentary')
    h.text(' Still.')
    h.complete()
    expect(assistant(h.state().messages)).toEqual([
      { text: 'The answer.', phase: 'final_answer' },
      { text: 'Checking. Still.', phase: 'commentary' },
    ])
  })

  it('opens a new message where the phase changes and stores each one with its phase', async () => {
    const h = await setup()
    h.text('Looking ', 'commentary')
    h.text('around.', 'commentary')
    // Back to back, with nothing between: still two messages.
    h.text('Partly ', 'partial_answer')
    h.text('done.', 'final_answer')
    h.complete()

    expect(assistant(h.state().messages)).toEqual([
      { text: 'Looking around.', phase: 'commentary' },
      { text: 'Partly ', phase: 'partial_answer' },
      { text: 'done.', phase: 'final_answer' },
    ])
    const deltas = h.published.filter((record) => record.event.name === 'message.delta')
    expect(deltas.map((record) => (record.event.payload as { phase?: string }).phase)).toEqual([
      'commentary',
      'partial_answer',
      'final_answer',
    ])
  })

  it('stores no phase for a provider that marks none', async () => {
    const h = await setup()
    h.text('Plain ')
    h.text('reply.')
    h.complete()

    const messages = h.state().messages.filter((message) => message.role === 'assistant')
    expect(assistant(messages)).toEqual([{ text: 'Plain reply.', phase: undefined }])
    expect(messages[0]).not.toHaveProperty('phase')
    expect(h.database.prepare("SELECT phase FROM messages WHERE role = 'assistant'").all()).toEqual(
      [{ phase: null }],
    )
  })

  it('hands the phase to a client that joins mid-turn, and the rest of the turn after it', async () => {
    const h = await setup()
    h.text('Reading the code.', 'commentary')
    h.tool('tool-1')
    h.text('The ans', 'final_answer')
    h.events.flush()

    // A second client joins now: its snapshot holds the open answer with its phase.
    const joined = h.reader.read(h.scope, null)
    expect(joined.mode).toBe('snapshot')
    const snapshot = ScopeSnapshotSchema.parse(
      (joined as Extract<typeof joined, { mode: 'snapshot' }>).snapshot,
    )
    const held = snapshot.state as { messages: Message[] }
    expect(assistant(held.messages)).toEqual([
      { text: 'Reading the code.', phase: 'commentary' },
      { text: 'The ans', phase: 'final_answer' },
    ])

    // What follows its cursor continues that message, phase and all.
    h.text('wer.', 'final_answer')
    h.complete()
    h.events.flush()
    const after = h.published.filter(
      (record) =>
        record.event.scope.type === 'thread' &&
        record.cursor.sequence > snapshot.cursor.sequence &&
        record.event.name === 'message.delta',
    )
    expect(after.map((record) => record.event.payload)).toEqual([
      expect.objectContaining({
        messageId: held.messages.at(-1)!.messageId,
        content: { type: 'text', text: 'wer.' },
        phase: 'final_answer',
      }),
    ])
  })

  it('replays the phase from the log to a client that was away', async () => {
    const h = await setup()
    // Enough before it left that the few events since are cheaper than the whole chat.
    h.text('x'.repeat(20_000), 'commentary')
    h.tool('tool-0')
    h.events.flush()
    const away = h.published.filter((record) => record.event.scope.type === 'thread').at(-1)!
    h.text('Checking.', 'commentary')
    h.tool('tool-1')
    h.text('Done.', 'final_answer')
    h.complete()
    h.events.flush()

    const caught = h.reader.read(h.scope, away.cursor)
    expect(caught.mode).toBe('replay')
    const replayed = JSON.parse(
      `[${(caught as Extract<typeof caught, { mode: 'replay' }>).eventsJson}]`,
    ) as DurableEvent[]
    expect(
      replayed
        .filter((record) => record.event.name === 'message.delta')
        .map((record) => record.event.payload),
    ).toEqual([
      expect.objectContaining({
        content: { type: 'text', text: 'Checking.' },
        phase: 'commentary',
      }),
      expect.objectContaining({ content: { type: 'text', text: 'Done.' }, phase: 'final_answer' }),
    ])
  })

  it('keeps the phase across a history reload from a fresh connection', async () => {
    const h = await setup()
    h.text('Checking.', 'commentary')
    h.tool('tool-1')
    h.text('Done.', 'final_answer')
    h.complete()
    h.events.flush()

    const reopened = openEnvironmentDatabase(h.directory)
    databases.push(reopened)
    expect(assistant(readThreadState(reopened, h.target)!.messages)).toEqual([
      { text: 'Checking.', phase: 'commentary' },
      { text: 'Done.', phase: 'final_answer' },
    ])
  })
})
