import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofEventSchemas,
  ProofResponseSchemas,
  TOOL_OUTPUT_MAX_BYTES,
  appendToolOutput,
  applyToolUpdate,
  boundToolOutput,
  toolOutputBytes,
  type EventEnvelope,
  type ProofEvent,
  type ToolCallState,
  type ToolCallUpdate,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventRepository, type DurableProofEvent } from '../src/db/event-repository.js'
import { readSchemaVersion } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { createReplayReader } from '../src/db/replay.js'
import {
  HISTORY_PAGE_BUDGET_BYTES,
  TOOL_PAYLOAD_BUDGET_BYTES,
  listSessionHistory,
} from '../src/db/session-store.js'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'

const directories: string[] = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      /* closed by the test */
    }
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const scope = {
  type: 'thread',
  environmentId: 'environment-1',
  sessionId: 'session-1',
  threadId: 'thread-1',
} as const
const T0 = Date.parse('2026-10-09T10:00:00.000Z')
const at = (second: number) => new Date(T0 + second * 1000).toISOString()
const encoded = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-tool-payloads-'))
  directories.push(directory)
  return directory
}

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
    VALUES ('session-1', 'workspace-1', 'claude', 'idle', 1, 1);
    INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
    VALUES ('thread-1', 'session-1', 'workspace-1', 1, 1);
  `)
}

async function createDatabase(): Promise<{ database: DatabaseSync; directory: string }> {
  const directory = await dataDir()
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  seed(database)
  return { database, directory }
}

let eventCount = 0
const started = (turnId = 'turn-1', second = 0): DurableProofEvent =>
  ProofEventSchemas['turn.started'].parse({
    type: 'event',
    name: 'turn.started',
    eventId: `started-${turnId}`,
    timestamp: at(second),
    scope,
    payload: {
      turn: { turnId, threadId: 'thread-1', state: 'running' },
      userMessage: {
        messageId: `prompt-${turnId}`,
        threadId: 'thread-1',
        turnId,
        role: 'user',
        content: [{ type: 'text', text: 'Do it' }],
      },
    },
  })
const tool = (
  patch: Omit<ToolCallUpdate, 'turnId' | 'toolCallId'> & { toolCallId?: string; turnId?: string },
  second = 1,
): DurableProofEvent =>
  ProofEventSchemas['tool.updated'].parse({
    type: 'event',
    name: 'tool.updated',
    eventId: `tool-${(eventCount += 1)}`,
    timestamp: at(second),
    scope,
    payload: { toolCallId: 'tool-1', turnId: 'turn-1', ...patch },
  })
const text = (value: string, messageId = 'reply-1', turnId = 'turn-1'): DurableProofEvent =>
  ProofEventSchemas['message.delta'].parse({
    type: 'event',
    name: 'message.delta',
    eventId: `text-${(eventCount += 1)}`,
    timestamp: at(2),
    scope,
    payload: { messageId, turnId, role: 'assistant', content: { type: 'text', text: value } },
  })
const finished = (
  name: 'turn.completed' | 'turn.interrupted' = 'turn.completed',
  turnId = 'turn-1',
): DurableProofEvent =>
  ProofEventSchemas[name].parse({
    type: 'event',
    name,
    eventId: `${name}-${turnId}`,
    timestamp: at(9),
    scope,
    payload: { turnId },
  })

/** What a client holds after folding these events. */
function fold(
  events: readonly ProofEvent[],
  from: ToolCallState[] = [],
): Map<string, ToolCallState> {
  const tools = new Map(from.map((item) => [item.toolCallId, item]))
  for (const event of events) {
    if (event.name !== 'tool.updated') continue
    tools.set(
      event.payload.toolCallId,
      applyToolUpdate(tools.get(event.payload.toolCallId), event.payload),
    )
  }
  return tools
}

const history = (database: DatabaseSync) =>
  listSessionHistory(database, { sessionId: 'session-1', threadId: 'thread-1' })!

describe('tool payloads in turn_activity', () => {
  it('stores what the events said and reads back what a client folded', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const events = [
      started(),
      tool({
        toolName: 'Bash',
        title: 'Bash',
        kind: 'execute',
        status: 'pending',
        input: { command: 'pnpm test' },
        startedAt: at(1),
      }),
      tool({ status: 'in_progress', output: { text: 'running\n' } }),
      tool({ outputDelta: 'ok 1\n' }),
      tool({ outputDelta: 'ok 2\n' }),
      tool({
        toolCallId: 'tool-2',
        toolName: 'Edit',
        kind: 'edit',
        status: 'completed',
        input: { file_path: '/workspace/a.ts' },
        locations: [{ path: '/workspace/a.ts' }],
        lineChanges: { added: 3, removed: 1 },
        startedAt: at(2),
        finishedAt: at(3),
      }),
      tool({ status: 'completed', finishedAt: at(4) }, 4),
      tool({ toolCallId: 'tool-3', toolName: 'Bash', status: 'declined', finishedAt: at(5) }, 5),
      tool({ toolCallId: 'tool-4', toolName: 'Bash', status: 'cancelled', finishedAt: at(6) }, 6),
      finished(),
    ]
    repository.appendEvents(scope, events)

    const page = history(database)
    expect(page.tools).toEqual([...fold(events).values()])
    expect(page.tools[0]).toEqual({
      toolCallId: 'tool-1',
      turnId: 'turn-1',
      toolName: 'Bash',
      title: 'Bash',
      kind: 'execute',
      status: 'completed',
      input: { command: 'pnpm test' },
      output: { text: 'running\nok 1\nok 2\n' },
      startedAt: at(1),
      finishedAt: at(4),
    })
    expect(page.tools.map((item) => item.status)).toEqual([
      'completed',
      'completed',
      'declined',
      'cancelled',
    ])
    // The payload sits beside the row's small state, and its size beside that.
    const row = database
      .prepare(
        "SELECT state_json, payload_json, payload_bytes FROM turn_activity WHERE activity_id = 'tool-1'",
      )
      .get() as { state_json: string; payload_json: string; payload_bytes: number }
    expect(JSON.parse(row.state_json)).not.toHaveProperty('output')
    expect(JSON.parse(row.payload_json)).toEqual({
      input: { command: 'pnpm test' },
      output: { text: 'running\nok 1\nok 2\n' },
    })
    expect(row.payload_bytes).toBe(Buffer.byteLength(row.payload_json))
    const declined = database
      .prepare("SELECT payload_json, payload_bytes FROM turn_activity WHERE activity_id = 'tool-3'")
      .get()
    expect(declined).toEqual({ payload_json: null, payload_bytes: 0 })
  })

  it('keeps a page and a snapshot inside the frame budget, newest payloads first', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const big = `start\n${'x'.repeat(60_000)}\nend`
    const events: DurableProofEvent[] = [started()]
    for (let index = 0; index < 40; index += 1) {
      events.push(
        tool({
          toolCallId: `call-${index}`,
          toolName: 'Bash',
          status: 'completed',
          input: { command: `run ${index} ${'y'.repeat(2_000)}` },
          output: boundToolOutput(`${index}:${big}`),
          locations: [{ path: `/workspace/file-${index}.ts` }],
        }),
      )
    }
    events.push(text('done'), finished())
    repository.appendEvents(scope, events)

    const page = history(database)
    expect(encoded(page)).toBeLessThan(HISTORY_PAGE_BUDGET_BYTES)
    const payloads = page.tools.reduce(
      (sum, item) =>
        sum +
        (item.input === undefined ? 0 : encoded(item.input)) +
        (item.output === undefined ? 0 : encoded(item.output)) +
        (item.locations === undefined ? 0 : encoded(item.locations)),
      0,
    )
    expect(payloads).toBeLessThanOrEqual(TOOL_PAYLOAD_BUDGET_BYTES + 40 * 64)
    // The newest calls come whole; the oldest say how much was left out.
    const newest = page.tools.at(-1)!
    expect(newest.output).toEqual(boundToolOutput(`39:${big}`))
    expect(newest.input).toBeDefined()
    const oldest = page.tools[0]!
    expect(oldest.input).toBeUndefined()
    expect(oldest.locations).toBeUndefined()
    expect(oldest.output).toMatchObject({ text: '' })
    expect(oldest.output!.omittedBytes).toBeGreaterThan(TOOL_OUTPUT_MAX_BYTES)
    // Each kept output still opens with its start and ends with its newest end.
    const partial = page.tools.find(
      (item) => item.output && item.output.text !== '' && toolOutputBytes(item.output) < 16_000,
    )
    expect(partial).toBeDefined()
    expect(partial!.output!.text.length).toBeGreaterThan(0)
    expect(partial!.output!.tail!.endsWith('\nend')).toBe(true)
    // Newest first: whole, then the one cut to fit, then markers only.
    const shape = page.tools.map((item) =>
      item.output!.text === '' ? 'marker' : item === partial ? 'partial' : 'whole',
    )
    const firstWhole = shape.indexOf('whole')
    expect(shape.slice(0, shape.indexOf('partial')).every((kind) => kind === 'marker')).toBe(true)
    expect(shape.indexOf('partial')).toBe(firstWhole - 1)
    expect(shape.slice(firstWhole).every((kind) => kind === 'whole')).toBe(true)
    expect(page.tools.map((item) => item.status).every((status) => status === 'completed')).toBe(
      true,
    )

    // A late joiner's snapshot is the same page, under the same budget.
    const reader = createReplayReader(database, {
      epoch: 'epoch-1',
      environment: () => ({ environmentId: 'environment-1', name: 'Local' }),
      workspaces: () => [],
    })
    const snapshot = reader.read(scope, null)
    expect(snapshot.mode).toBe('snapshot')
    if (snapshot.mode !== 'snapshot') return
    const state = snapshot.snapshot.state as { tools: ToolCallState[] }
    expect(state.tools).toEqual(page.tools)
    expect(encoded(snapshot)).toBeLessThan(1024 * 1024)
  })

  it('replays output deltas to exactly what a late joiner reads from the snapshot', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const reader = createReplayReader(database, {
      epoch: 'epoch-1',
      environment: () => ({ environmentId: 'environment-1', name: 'Local' }),
      workspaces: () => [],
    })
    repository.appendEvents(scope, [
      started(),
      tool({ toolName: 'Bash', status: 'in_progress', input: { command: 'make' } }),
    ])
    const early = reader.read(scope, null)
    if (early.mode !== 'snapshot') throw new Error('expected a snapshot')
    // Enough to pass the output cap, few enough for one replay frame.
    const chunks = Array.from({ length: 120 }, (_, index) => `line ${index} ${'.'.repeat(200)}\n`)
    repository.appendEvents(scope, [
      ...chunks.map((chunk) => tool({ outputDelta: chunk })),
      tool({ status: 'completed', finishedAt: at(8) }),
    ])

    // Client A watched from the early snapshot and catches up by replay.
    const replayed = reader.read(scope, early.snapshot.cursor)
    expect(replayed.mode).toBe('replay')
    if (replayed.mode !== 'replay') return
    const early_tools = (early.snapshot.state as { tools: ToolCallState[] }).tools
    const caughtUp = fold(
      replayed.events.map((record) => record.event),
      early_tools,
    )
    // Client B joins now.
    const late = reader.read(scope, null)
    if (late.mode !== 'snapshot') throw new Error('expected a snapshot')
    const lateTools = (late.snapshot.state as { tools: ToolCallState[] }).tools
    expect([...caughtUp.values()]).toEqual(lateTools)
    const output = lateTools[0]!.output!
    expect(output).toEqual(
      chunks.reduce<ReturnType<typeof boundToolOutput> | undefined>(appendToolOutput, undefined),
    )
    expect(output.tail!.endsWith(chunks.at(-1)!)).toBe(true)
    expect(toolOutputBytes(output)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
  })

  it('settles a call a dead process left open as cancelled when the environment restarts', async () => {
    const { database, directory } = await createDatabase()
    createEventRepository(database).appendEvents(scope, [
      started(),
      tool({ toolName: 'Bash', status: 'in_progress', input: { command: 'sleep 100' } }),
      tool({ toolCallId: 'tool-done', toolName: 'Read', status: 'completed', finishedAt: at(2) }),
    ])
    database.close()
    const reopened = openEnvironmentDatabase(directory)
    databases.push(reopened)
    const page = history(reopened)
    expect(page.turns[0]!.state).toBe('interrupted')
    expect(page.tools[0]).toMatchObject({
      toolCallId: 'tool-1',
      status: 'cancelled',
      input: { command: 'sleep 100' },
    })
    expect(page.tools[0]!.finishedAt).toBeDefined()
    expect(page.tools[1]).toMatchObject({ status: 'completed', finishedAt: at(2) })
  })

  it('upgrades a version 19 database without touching the tool calls it holds', async () => {
    const directory = await dataDir()
    const old = openEnvironmentDatabase(directory, MIGRATIONS.slice(0, 19))
    expect(readSchemaVersion(old)).toBe(19)
    seed(old)
    old.exec(`
      INSERT INTO turns (turn_id, thread_id, workspace_id, state, started_at, updated_at)
      VALUES ('turn-1', 'thread-1', 'workspace-1', 'completed', 1, 1)
    `)
    old
      .prepare(
        `INSERT INTO turn_activity (activity_id, workspace_id, thread_id, turn_id, kind, ordinal,
           state_json, created_at, updated_at)
         VALUES ('legacy-tool', 'workspace-1', 'thread-1', 'turn-1', 'tool', 5, ?, 1, 1)`,
      )
      .run(
        JSON.stringify({
          toolCallId: 'legacy-tool',
          turnId: 'turn-1',
          title: 'Read file',
          status: 'completed',
        }),
      )
    old.close()

    const upgraded = openEnvironmentDatabase(directory)
    databases.push(upgraded)
    expect(readSchemaVersion(upgraded)).toBe(20)
    const columns = (
      upgraded.prepare('PRAGMA table_info(turn_activity)').all() as { name: string }[]
    ).map((column) => column.name)
    expect(columns).toEqual(expect.arrayContaining(['payload_json', 'payload_bytes']))
    expect(history(upgraded).tools).toEqual([
      { toolCallId: 'legacy-tool', turnId: 'turn-1', title: 'Read file', status: 'completed' },
    ])
    // A reasoning row can never hold a payload.
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO turn_activity (activity_id, workspace_id, thread_id, turn_id, kind, ordinal,
             state_json, payload_json, created_at, updated_at)
           VALUES ('thought', 'workspace-1', 'thread-1', 'turn-1', 'reasoning', 6, '{}', '{}', 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/)
  })
})

describe('tool calls through the thread service', () => {
  const registered: WorkspaceRuntimeResolver = (workspaceId) =>
    workspaceId === '/workspace/project' ? { providerId: 'opencode', cwd: workspaceId } : undefined

  async function setup() {
    let finishPrompt: () => void = () => undefined
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishPrompt = resolve
          }),
      ),
      cancel: vi.fn().mockResolvedValue(undefined),
    }
    const events: EventEnvelope[] = []
    const service = createThreadService(
      runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
      { rejection: () => undefined },
      (event) => events.push(event),
      undefined,
      registered,
    )
    service.setEnvironmentId('environment-1')
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create',
        name: 'session.create',
        payload: {
          environmentId: 'environment-1',
          providerId: 'opencode',
          workspaceId: '/workspace/project',
        },
      }),
    ).payload
    const target = { sessionId: created.session.sessionId, threadId: created.thread.threadId }
    const sent = ProofResponseSchemas['turn.send'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'send',
        name: 'turn.send',
        payload: { ...target, text: 'go' },
      }),
    ).payload
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1))
    let seq = 0
    const emit = (event: Record<string, unknown>) =>
      service.onRuntimeEvent({
        id: `runtime-${(seq += 1)}`,
        seq,
        timestamp: at(seq),
        providerId: 'opencode',
        threadId: target.threadId,
        workspaceId: '/workspace/project',
        sessionId: 'provider-session',
        messageId: 'assistant-1',
        ...event,
      } as Parameters<typeof service.onRuntimeEvent>[0])
    emit({
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'go', userMessageId: sent.userMessage.messageId },
    })
    const tools = () =>
      events.filter((event) => event.name === 'tool.updated') as Extract<
        ProofEvent,
        { name: 'tool.updated' }
      >[]
    return { service, runtime, events, emit, tools, target, sent, finish: () => finishPrompt() }
  }

  it('reads a call whose permission the user refused as declined, and cancels what the turn leaves open', async () => {
    const h = await setup()
    h.emit({
      category: 'tool',
      event: 'tool_call',
      data: {
        toolCallId: 'p-rm',
        title: 'rm -rf build',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'rm -rf build' },
      },
    })
    h.emit({
      category: 'permission',
      event: 'permission_request',
      data: {
        requestId: 'provider-permission',
        sessionId: 'provider-session',
        toolCall: { toolCallId: 'p-rm', title: 'rm -rf build' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    })
    h.emit({
      category: 'permission',
      event: 'permission_resolved',
      data: {
        requestId: 'provider-permission',
        outcome: { outcome: 'selected', optionId: 'deny' },
      },
    })
    h.emit({
      category: 'tool',
      event: 'tool_call_update',
      data: { toolCallId: 'p-rm', status: 'failed' },
    })
    h.emit({
      category: 'tool',
      event: 'tool_call',
      data: { toolCallId: 'p-ls', title: 'ls', kind: 'execute', status: 'in_progress' },
    })
    h.emit({ category: 'lifecycle', event: 'prompt_completed', data: { stopReason: 'end_turn' } })

    const [rm, ls] = [...fold(h.tools()).values()]
    expect(rm).toMatchObject({ status: 'declined', input: { command: 'rm -rf build' } })
    expect(ls).toMatchObject({ status: 'cancelled' })
    expect(ls!.finishedAt).toBeDefined()
    // The settling update lands before the turn's end, which clients would
    // otherwise treat as final and ignore anything after.
    const names = h.events.map((event) => event.name)
    expect(names.lastIndexOf('tool.updated')).toBeLessThan(names.indexOf('turn.completed'))
  })

  it('cancels the calls a stopped turn leaves running', async () => {
    const h = await setup()
    h.emit({
      category: 'tool',
      event: 'tool_call',
      data: { toolCallId: 'p-sleep', title: 'sleep', kind: 'execute', status: 'in_progress' },
    })
    h.service.dispatch({
      type: 'command',
      requestId: 'stop',
      name: 'turn.interrupt',
      payload: { ...h.target, turnId: h.sent.turn.turnId },
    })
    // A provider reports the stopped tool as failed: it was cancelled.
    h.emit({
      category: 'tool',
      event: 'tool_call',
      data: { toolCallId: 'p-two', title: 'two', status: 'in_progress' },
    })
    h.emit({
      category: 'tool',
      event: 'tool_call_update',
      data: { toolCallId: 'p-two', status: 'failed' },
    })
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.name === 'turn.interrupted')).toBe(true),
    )
    const states = [...fold(h.tools()).values()]
    expect(states.map((item) => item.status)).toEqual(['cancelled', 'cancelled'])
    const names = h.events.map((event) => event.name)
    expect(names.lastIndexOf('tool.updated')).toBeLessThan(names.indexOf('turn.interrupted'))
  })
})
