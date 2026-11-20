import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import { ProofResponseSchemas, type DurableEvent } from '@openmanager/protocol/node'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'
import { createPersistentEventService } from '../src/event-service.js'
import { openEnvironmentDatabase } from '../src/db/database.js'

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

/** A durable environment; `open` starts a session with one running turn. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-provider-ids-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('/workspace/project', 'Project', '/workspace/project', 1, 1);
  `)
  const published: DurableEvent[] = []
  let providerSessions = 0
  const events = createPersistentEventService(database, (record) => published.push(record), {})
  const runtime = {
    ensureSession: vi.fn(async () => ({
      sessionId: `provider-session-${++providerSessions}`,
      state: 'created',
    })),
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

  let seq = 0
  let opened = 0
  const open = async () => {
    const n = ++opened
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: `create-${n}`,
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
        requestId: `send-${n}`,
        name: 'turn.send',
        payload: { ...target, text: 'hello' },
      }),
    ).payload
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(n))
    const emit = (event: Record<string, unknown>) =>
      service.onRuntimeEvent({
        id: `runtime-${++seq}`,
        seq,
        timestamp: '2026-11-20T10:00:00.000Z',
        providerId: 'claude',
        threadId: target.threadId,
        workspaceId: '/workspace/project',
        sessionId: `provider-session-${n}`,
        messageId: `assistant-${n}`,
        ...event,
      } as Parameters<typeof service.onRuntimeEvent>[0])
    emit({
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'hello', userMessageId: started.userMessage.messageId },
    })
    return {
      target,
      turnId: started.turn.turnId,
      identify: (providerTurnId: string) =>
        emit({ category: 'lifecycle', event: 'turn_identified', data: { providerTurnId } }),
      text: (text: string, item?: string, phase?: string) =>
        emit({
          category: 'stream',
          event: 'agent_message_chunk',
          data: {
            content: { type: 'text', text },
            ...(item ? { messageId: item } : {}),
            ...(phase ? { phase } : {}),
          },
        }),
      thought: (phase: 'start' | 'delta' | 'stop', item?: string, text?: string) =>
        emit({
          category: 'stream',
          event: 'agent_thought_chunk',
          data: {
            phase,
            ...(item ? { messageId: item } : {}),
            ...(text ? { content: { type: 'text', text } } : {}),
          },
        }),
      tool: (toolCallId: string, status = 'completed') =>
        emit({
          category: 'tool',
          event: 'tool_call',
          data: { toolCallId, title: 'Read', kind: 'read', status },
        }),
      complete: () =>
        emit({
          category: 'lifecycle',
          event: 'prompt_completed',
          data: { stopReason: 'end_turn' },
        }),
    }
  }
  const rows = (threadId: string) => {
    events.flush()
    return {
      turns: database
        .prepare('SELECT turn_id, provider_turn_id FROM turns WHERE thread_id = ?')
        .all(threadId),
      messages: database
        .prepare(
          `SELECT m.external_id, group_concat(json_extract(p.content_json, '$.text'), '') AS text
           FROM messages m JOIN message_parts p ON p.message_id = m.message_id
           WHERE m.thread_id = ? AND m.role = 'assistant'
           GROUP BY m.message_id ORDER BY m.ordinal`,
        )
        .all(threadId),
      activity: database
        .prepare('SELECT kind, external_id FROM turn_activity WHERE thread_id = ? ORDER BY ordinal')
        .all(threadId),
    }
  }
  return { database, events, published, open, rows }
}

describe('provider ids', () => {
  it('keeps the provider’s turn and item ids beside the rows, and off the wire', async () => {
    const h = await setup()
    const chat = await h.open()
    chat.identify('turn-native-1')
    chat.thought('start', 'rs_1')
    chat.thought('delta', 'rs_1', 'Planning.')
    chat.thought('stop', 'rs_1')
    chat.text('Looking ', 'msg_1', 'commentary')
    chat.text('around.', 'msg_1', 'commentary')
    chat.tool('call_1')
    chat.text('Done.', 'msg_2', 'final_answer')
    chat.complete()

    const rows = h.rows(chat.target.threadId)
    expect(rows.turns).toEqual([{ turn_id: chat.turnId, provider_turn_id: 'turn-native-1' }])
    expect(rows.messages).toEqual([
      { external_id: 'msg_1', text: 'Looking around.' },
      { external_id: 'msg_2', text: 'Done.' },
    ])
    expect(rows.activity).toEqual([
      { kind: 'reasoning', external_id: 'rs_1' },
      { kind: 'tool', external_id: 'call_1' },
    ])
    // Host storage only: no provider id reaches a client.
    const wire = JSON.stringify(h.published)
    for (const id of ['turn-native-1', 'rs_1', 'msg_1', 'msg_2', 'call_1'])
      expect(wire).not.toContain(id)
  })

  it('stores NULL for a provider that names nothing, and files its output as before', async () => {
    const h = await setup()
    const chat = await h.open()
    chat.thought('delta', undefined, 'Hmm.')
    chat.text('Plain ')
    chat.text('reply.')
    chat.complete()

    const rows = h.rows(chat.target.threadId)
    expect(rows.turns).toEqual([{ turn_id: chat.turnId, provider_turn_id: null }])
    expect(rows.messages).toEqual([{ external_id: null, text: 'Plain reply.' }])
    expect(rows.activity).toEqual([{ kind: 'reasoning', external_id: null }])
  })

  // Codex's `thread/fork` reuses the source's turn ids: they are only unique
  // within a thread, and so is what the host keeps.
  it('keeps the same provider turn and item ids in two threads apart', async () => {
    const h = await setup()
    const first = await h.open()
    first.identify('turn-1')
    first.text('One.', 'msg_1', 'final_answer')
    first.complete()
    const second = await h.open()
    second.identify('turn-1')
    second.text('Two.', 'msg_1', 'final_answer')
    second.complete()

    expect(h.rows(first.target.threadId)).toMatchObject({
      turns: [{ turn_id: first.turnId, provider_turn_id: 'turn-1' }],
      messages: [{ external_id: 'msg_1', text: 'One.' }],
    })
    expect(h.rows(second.target.threadId)).toMatchObject({
      turns: [{ turn_id: second.turnId, provider_turn_id: 'turn-1' }],
      messages: [{ external_id: 'msg_1', text: 'Two.' }],
    })
  })

  it('opens a message per provider item, and keeps an item split in two on its first', async () => {
    const h = await setup()
    const chat = await h.open()
    // Two narrations back to back, nothing between: two messages.
    chat.text('Reading.', 'msg_1', 'commentary')
    chat.text('Writing.', 'msg_2', 'commentary')
    // One item a thought interrupts: two host messages, one id.
    chat.text('Half ', 'msg_3', 'final_answer')
    chat.thought('delta', 'rs_1', 'Wait.')
    chat.text('done.', 'msg_3', 'final_answer')
    // A chunk naming no phase never splits a run, whatever its item.
    chat.text(' Really.', 'msg_4')
    chat.complete()

    expect(h.rows(chat.target.threadId).messages).toEqual([
      { external_id: 'msg_1', text: 'Reading.' },
      { external_id: 'msg_2', text: 'Writing.' },
      { external_id: 'msg_3', text: 'Half ' },
      { external_id: null, text: 'done. Really.' },
    ])
  })

  it('takes a turn id once, and none from a turn that already ended', async () => {
    const h = await setup()
    const chat = await h.open()
    chat.identify('turn-a')
    chat.identify('turn-b')
    chat.complete()
    chat.identify('turn-late')

    expect(h.rows(chat.target.threadId).turns).toEqual([
      { turn_id: chat.turnId, provider_turn_id: 'turn-a' },
    ])
  })
})
