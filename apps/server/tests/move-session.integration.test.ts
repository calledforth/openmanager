import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofResponseSchemas,
  type CommandEnvelope,
  type EventEnvelope,
} from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  startProtocolHost,
  subscribe,
  threadState,
  type ProtocolHost,
} from './helpers/protocol-client.js'
import { promptSessionId } from './helpers/proof-slice.js'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { readThreadState } from '../src/db/session-store.js'
import { createPersistentEventService } from '../src/event-service.js'
import {
  createThreadService,
  movedPrompt,
  type WorkspaceRuntimeResolver,
} from '../src/thread-service.js'

afterEach(async () => {
  await cleanupProtocolHosts()
})

type ToolAnswer = { content: { text: string }[]; isError?: boolean }

/** What the fake agent does on one prompt. */
type Step = {
  /** Call `move_session` with this path first. */
  move?: string
  /** After moving, wait for the test's `release()` or a cancel. */
  hold?: boolean
  /** End the prompt with an error. */
  fail?: boolean
}

/**
 * An ACP agent that calls the environment's `move_session` over the MCP
 * endpoint it was given when its script says so (by default on its first
 * prompt only), and records the folder every session it opens or loads runs
 * in, and every prompt it reads with the folder it read it in.
 */
function movingAgent(
  target: () => string,
  answers: ToolAnswer[],
  script: (prompt: number) => Step = (prompt) => (prompt === 1 ? { move: target() } : {}),
) {
  let endpoint: { url: string; headers: Record<string, string> } | undefined
  const opened: { method: 'new' | 'load'; cwd: string; sessionId?: string }[] = []
  const prompts: { text: string; cwd: string }[] = []
  let release: (() => void) | undefined
  let reached: () => void = () => {}
  const held = new Promise<void>((resolve) => (reached = resolve))
  let cancelled = false
  const remember = (params: unknown) => {
    const servers = (
      params as { mcpServers: { url: string; headers: { name: string; value: string }[] }[] }
    ).mcpServers
    const server = servers[0]!
    endpoint = {
      url: server.url,
      headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
    }
  }
  const callMove = async (path: string) => {
    const post = async (body: unknown) =>
      (await (
        await fetch(endpoint!.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...endpoint!.headers,
          },
          body: JSON.stringify(body),
        })
      ).json()) as { result: ToolAnswer }
    await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    })
    const called = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'move_session', arguments: { path } },
    })
    answers.push(called.result)
  }
  const connections: FakeConnectionFactory = new FakeConnectionFactory({
    initialize: async () => ({
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
    }),
    newSession: async (params) => {
      remember(params)
      opened.push({ method: 'new', cwd: (params as { cwd: string }).cwd })
      return { sessionId: 'stub-session' }
    },
    loadSession: async (params) => {
      remember(params)
      const { cwd, sessionId } = params as { cwd: string; sessionId: string }
      opened.push({ method: 'load', cwd, sessionId })
      return {}
    },
    prompt: async (params) => {
      const blocks = (params as { prompt: { type: string; text?: string }[] }).prompt
      const text = blocks.filter((block) => block.type === 'text').at(-1)?.text ?? ''
      prompts.push({ text, cwd: opened.at(-1)!.cwd })
      const step = script(prompts.length)
      if (step.move !== undefined) await callMove(step.move)
      if (step.hold) {
        await new Promise<void>((resolve) => {
          release = resolve
          reached()
        })
      }
      if (cancelled) {
        cancelled = false
        return { stopReason: 'cancelled' }
      }
      if (step.fail) throw new Error('the provider fell over')
      await connections.last.sessionUpdate({
        sessionId: promptSessionId(params),
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      })
      return { stopReason: 'end_turn' }
    },
    cancel: async () => {
      cancelled = true
      release?.()
      return {}
    },
  })
  return { connections, opened, prompts, held, release: () => release?.() }
}

async function startHost(connections: FakeConnectionFactory, movable = true) {
  return startProtocolHost({
    runtimeOptions: {
      connections,
      claudeSdk: new FakeClaudeSdk(),
      health: { schedule: () => ({ cancel() {} }) },
    },
    ...(movable ? { movableProviders: ['opencode'] } : {}),
  })
}

type Records = Awaited<ReturnType<typeof collectThreadRecords>>

const ended = (records: Records) =>
  records.filter((record) =>
    ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(record.event.name),
  ).length

async function openSession(host: ProtocolHost) {
  const client = await connectProtocol(host)
  await handshake(client)
  const createId = client.command('session.create', {
    environmentId: host.server.identity.environmentId,
    providerId: 'opencode',
    workspaceId: host.workspaceId,
  })
  const { session, thread } = ProofResponseSchemas['session.create'].parse(
    await nextResponse(client, createId),
  ).payload
  const subscriptionId = await subscribe(client, {
    type: 'thread',
    environmentId: host.server.identity.environmentId,
    sessionId: session.sessionId,
    threadId: thread.threadId,
  })
  const target = { sessionId: session.sessionId, threadId: thread.threadId }
  /** Every thread record until `turns` turns have ended. */
  const until = (turns: number) =>
    collectThreadRecords(client, subscriptionId, (seen) => ended(seen) >= turns)
  /** Send a message and answer the turn it started. */
  const start = async (text: string) => {
    const sendId = client.command('turn.send', { ...target, text })
    return ProofResponseSchemas['turn.send'].parse(await nextResponse(client, sendId)).payload
  }
  /** Send a message and collect until `turns` turns have ended (its own, and any after it). */
  const send = async (text: string, turns = 1) => {
    await start(text)
    return until(turns)
  }
  const command = async (name: string, payload: Record<string, unknown>) =>
    nextResponse(client, client.command(name as never, { ...target, ...payload } as never))
  return { sessionId: session.sessionId, threadId: thread.threadId, send, start, until, command }
}

/** The turns the records started, in order, with what was recorded in each. */
function turnsOf(records: Records) {
  const turns: {
    turn: { turnId: string; origin?: string; commandId?: string }
    userMessage?: { content: { type: string; text?: string }[] }
    notices: { kind: string; message: string; move?: unknown }[]
    userDeltas: number
    end?: string
  }[] = []
  for (const { event } of records) {
    const payload = event.payload as Record<string, unknown>
    if (event.name === 'turn.started') {
      turns.push({
        ...(payload as Pick<(typeof turns)[number], 'turn' | 'userMessage'>),
        notices: [],
        userDeltas: 0,
      })
      continue
    }
    const turn = turns.find((item) => item.turn.turnId === payload.turnId)
    if (!turn) continue
    if (event.name === 'turn.notice.recorded') turn.notices.push(payload as never)
    if (event.name === 'message.delta' && payload.role === 'user') turn.userDeltas += 1
    if (['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.name)) {
      turn.end = event.name
    }
  }
  return turns
}

/** Long enough for anything a settled turn would start to have started. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

/**
 * The workspace every row of the session names: each table a composite key
 * ties to the session's workspace, attachments by their session or by their
 * message.
 */
function workspacesOf(database: DatabaseSync, sessionId: string) {
  const threads = 'SELECT thread_id FROM threads WHERE session_id = ?1'
  const one = (sql: string) =>
    (database.prepare(sql).all(sessionId) as { workspace_id: string }[]).map(
      (row) => row.workspace_id,
    )
  return new Set([
    ...one('SELECT workspace_id FROM sessions WHERE session_id = ?1'),
    ...one('SELECT workspace_id FROM threads WHERE session_id = ?1'),
    ...['turns', 'messages', 'turn_activity', 'turn_notices'].flatMap((table) =>
      one(`SELECT workspace_id FROM ${table} WHERE thread_id IN (${threads})`),
    ),
    ...one(
      `SELECT workspace_id FROM attachments WHERE session_id = ?1
         OR message_id IN (SELECT message_id FROM messages WHERE thread_id IN (${threads}))`,
    ),
  ])
}

/** `workspacesOf`, read straight from the host's database. */
function rowWorkspaces(host: ProtocolHost, sessionId: string) {
  const database = new DatabaseSync(join(host.dataDir, 'openmanager.sqlite'), { readOnly: true })
  try {
    return workspacesOf(database, sessionId)
  } finally {
    database.close()
  }
}

describe('move_session', () => {
  it('moves the session when its turn completes and resumes it there by itself', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections, opened, prompts } = movingAgent(() => project, answers)
    const host = await startHost(connections)
    project = join(host.dataDir, 'my-app')
    await mkdir(project)
    const canonical = await realpath(project)
    const { sessionId, threadId, send } = await openSession(host)

    // The asking turn, then the one the environment starts in the new folder.
    const records = await send('make me an app', 2)
    expect(answers[0]?.isError).toBeFalsy()
    expect(answers[0]?.content[0]?.text).toContain(canonical)

    // The folder is a project now, and the session lists under it.
    const added = host.server.workspaces.list().find((workspace) => workspace.path === canonical)
    expect(added).toBeDefined()
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([added!.workspaceId]))

    // The resume turn: nobody sent it, and it opens with the move's marker.
    const [asking, resumed] = turnsOf(records)
    expect(asking).toMatchObject({ end: 'turn.completed' })
    expect(asking!.userMessage).toBeDefined()
    expect(resumed!.turn.origin).toBe('background')
    expect(resumed!.turn.commandId).toBeUndefined()
    expect(resumed!.userMessage).toBeUndefined()
    expect(resumed!.userDeltas).toBe(0)
    expect(resumed!.end).toBe('turn.completed')
    expect(resumed!.notices).toEqual([
      expect.objectContaining({
        kind: 'info',
        message: `Moved to my-app (${canonical}) and resumed there`,
        move: { workspaceId: added!.workspaceId, name: 'my-app', path: canonical },
      }),
    ])
    // Written with the turn's start, so the marker comes before anything the agent says.
    const resumeStart = records.findIndex(
      (record) =>
        record.event.name === 'turn.started' &&
        (record.event.payload as { turn: { turnId: string } }).turn.turnId === resumed!.turn.turnId,
    )
    expect(records[resumeStart + 1]?.event.name).toBe('turn.notice.recorded')
    expect(records[resumeStart + 1]?.cursor.sequence).toBe(
      records[resumeStart]!.cursor.sequence + 1,
    )

    // It ran in the new folder, on the same provider session, with the
    // environment's prompt, which only the provider read.
    expect(opened[0]).toMatchObject({ method: 'new', cwd: await realpath(host.workspaceRoot) })
    expect(opened.at(-1)).toEqual({ method: 'load', cwd: canonical, sessionId: 'stub-session' })
    expect(prompts.map((prompt) => prompt.cwd)).toEqual([
      await realpath(host.workspaceRoot),
      canonical,
    ])
    expect(prompts[1]!.text).toBe(movedPrompt('my-app', canonical))
    expect(JSON.stringify(records)).not.toContain('OpenManager moved this session')

    // A client loading the chat afresh reads the same: the marker heads the
    // resume turn, which has no user message.
    const reader = await connectProtocol(host)
    await handshake(reader)
    const state = await threadState(reader, host.server.identity.environmentId, {
      sessionId,
      threadId,
    })
    const resumeId = resumed!.turn.turnId
    expect(state.turns.find((turn) => turn.turnId === resumeId)?.origin).toBe('background')
    expect(
      state.messages.filter((message) => message.turnId === resumeId).map((m) => m.role),
    ).toEqual(['assistant'])
    expect(state.notices.find((notice) => notice.turnId === resumeId)?.move).toEqual({
      workspaceId: added!.workspaceId,
      name: 'my-app',
      path: canonical,
    })
    expect(state.order.find((ref) => ref.turnId === resumeId)?.kind).toBe('notice')

    // The user's next message runs there too.
    await send('carry on')
    expect(prompts.at(-1)).toEqual({ text: 'carry on', cwd: canonical })
    expect(opened).toHaveLength(2)
  })

  it('moves nothing and starts nothing when the asking turn fails', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections, opened, prompts } = movingAgent(
      () => project,
      answers,
      (prompt) => (prompt === 1 ? { move: project, fail: true } : {}),
    )
    const host = await startHost(connections)
    project = join(host.dataDir, 'my-app')
    await mkdir(project)
    const { sessionId, send } = await openSession(host)

    const records = await send('make me an app')
    expect(answers[0]?.isError).toBeFalsy()
    expect(turnsOf(records)[0]?.end).toBe('turn.failed')
    await settle()
    expect(prompts).toHaveLength(1)
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([host.workspaceId]))

    const next = await send('carry on')
    expect(turnsOf(next).map((turn) => turn.turn.origin)).toEqual([undefined])
    expect(prompts.map((prompt) => prompt.cwd)).toEqual(
      Array(2).fill(await realpath(host.workspaceRoot)),
    )
    expect(opened).toHaveLength(1)
  })

  it('moves nothing and starts nothing when the asking turn is stopped', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const agent = movingAgent(
      () => project,
      answers,
      (prompt) => (prompt === 1 ? { move: project, hold: true } : {}),
    )
    const host = await startHost(agent.connections)
    project = join(host.dataDir, 'my-app')
    await mkdir(project)
    const { sessionId, start, until, command, send } = await openSession(host)

    const { turn } = await start('make me an app')
    await agent.held
    expect(answers[0]?.isError).toBeFalsy()
    await command('turn.interrupt', { turnId: turn.turnId })
    const records = await until(1)
    expect(turnsOf(records)[0]?.end).toBe('turn.interrupted')
    await settle()
    expect(agent.prompts).toHaveLength(1)
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([host.workspaceId]))

    await send('carry on')
    expect(agent.prompts.at(-1)).toEqual({
      text: 'carry on',
      cwd: await realpath(host.workspaceRoot),
    })
    expect(agent.opened).toHaveLength(1)
  })

  it('runs a message queued during the asking turn after the resume turn, in the new folder', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const agent = movingAgent(
      () => project,
      answers,
      (prompt) => (prompt === 1 ? { move: project, hold: true } : {}),
    )
    const host = await startHost(agent.connections)
    project = join(host.dataDir, 'my-app')
    await mkdir(project)
    const canonical = await realpath(project)
    const { start, until, command } = await openSession(host)

    await start('make me an app')
    await agent.held
    await command('queue.add', { text: 'and add tests', commandId: randomUUID() })
    agent.release()

    const turns = turnsOf(await until(3))
    expect(turns.map((turn) => turn.turn.origin)).toEqual([undefined, 'background', undefined])
    expect(turns.map((turn) => turn.end)).toEqual([
      'turn.completed',
      'turn.completed',
      'turn.completed',
    ])
    expect(turns[1]!.notices).toHaveLength(1)
    expect(turns[2]!.userMessage?.content).toEqual([{ type: 'text', text: 'and add tests' }])
    expect(agent.prompts).toEqual([
      { text: 'make me an app', cwd: await realpath(host.workspaceRoot) },
      { text: movedPrompt('my-app', canonical), cwd: canonical },
      { text: 'and add tests', cwd: canonical },
    ])
  })

  it('lets the resumed turn move on to another folder, and refuses the one it is in', async () => {
    const answers: ToolAnswer[] = []
    let first = ''
    let second = ''
    const agent = movingAgent(
      () => first,
      answers,
      (prompt) => ({ move: prompt === 1 ? first : second }),
    )
    const host = await startHost(agent.connections)
    first = join(host.dataDir, 'first')
    second = join(host.dataDir, 'second')
    await mkdir(first)
    await mkdir(second)
    const [firstPath, secondPath] = [await realpath(first), await realpath(second)]
    const { sessionId, send } = await openSession(host)

    // Asking turn, resume in `first` (moves on), resume in `second` (refused).
    const turns = turnsOf(await send('make me an app', 3))
    expect(answers.map((answer) => !!answer.isError)).toEqual([false, false, true])
    expect(answers[2]?.content[0]?.text).toMatch(/already works in/)
    expect(turns.map((turn) => turn.turn.origin)).toEqual([undefined, 'background', 'background'])
    expect(
      turns.map((turn) => (turn.notices[0]?.move as { path: string } | undefined)?.path),
    ).toEqual([undefined, firstPath, secondPath])
    expect(agent.prompts.map((prompt) => prompt.cwd)).toEqual([
      await realpath(host.workspaceRoot),
      firstPath,
      secondPath,
    ])
    // The refused move filed nothing: no further turn starts.
    await settle()
    expect(agent.prompts).toHaveLength(3)
    const added = host.server.workspaces.list().find((workspace) => workspace.path === secondPath)
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([added!.workspaceId]))
  })

  it('announces the move to clients watching the environment', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections } = movingAgent(() => project, answers)
    const host = await startHost(connections)
    project = join(host.dataDir, 'announced')
    await mkdir(project)
    const watcher = await connectProtocol(host)
    await handshake(watcher)
    const environmentSubscription = await subscribe(watcher, {
      type: 'environment',
      environmentId: host.server.identity.environmentId,
    })
    const { sessionId, send } = await openSession(host)
    await send('make me an app', 2)
    const moveOf = (seen: Records) =>
      seen.find(
        (record) =>
          record.event.name === 'session.updated' &&
          (record.event.payload as { workspaceId?: string }).workspaceId !== undefined,
      )
    // Both projects are announced with their new recency in the same write:
    // the one it left first, under the repository's `:recency` id, and the
    // one it joined second, under `:recency-to`, so a retried write finds
    // both again.
    const recencyOf = (seen: Records, workspaceId: string | undefined) => {
      const moved = moveOf(seen)
      return seen.find(
        (record) =>
          moved !== undefined &&
          record.event.name === 'workspace.updated' &&
          (record.event.payload as { workspace: { workspaceId: string } }).workspace.workspaceId ===
            workspaceId &&
          record.event.eventId.startsWith(`${moved.event.eventId}:`),
      )
    }
    const joinedId = (seen: Records) =>
      (moveOf(seen)?.event.payload as { workspaceId?: string } | undefined)?.workspaceId
    const records = await collectThreadRecords(
      watcher,
      environmentSubscription,
      (seen) =>
        Boolean(recencyOf(seen, host.workspaceId)) && Boolean(recencyOf(seen, joinedId(seen))),
    )
    const moved = moveOf(records)!
    const added = host.server.workspaces
      .list()
      .find(
        (workspace) => workspace.workspaceId !== host.workspaceId && workspace.kind !== 'scratch',
      )
    expect(moved.event.payload).toEqual({ sessionId, workspaceId: added!.workspaceId })
    expect(recencyOf(records, host.workspaceId)?.event.eventId).toBe(
      `${moved.event.eventId}:recency`,
    )
    expect(recencyOf(records, added!.workspaceId)?.event.eventId).toBe(
      `${moved.event.eventId}:recency-to`,
    )
  })

  it('refuses a folder that does not exist, and moves nothing', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections, opened, prompts } = movingAgent(() => project, answers)
    const host = await startHost(connections)
    project = join(host.dataDir, 'not-there')
    const { sessionId, send } = await openSession(host)

    await send('make me an app')
    expect(answers[0]).toMatchObject({ isError: true })
    expect(answers[0]?.content[0]?.text).toMatch(/No folder exists/)
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([host.workspaceId]))
    await send('carry on')
    expect(opened).toHaveLength(1)
    expect(prompts.map((prompt) => prompt.text)).toEqual(['make me an app', 'carry on'])
  })

  it('refuses to move a session whose provider cannot resume it elsewhere', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections, prompts } = movingAgent(() => project, answers)
    const host = await startHost(connections, false)
    project = join(host.dataDir, 'my-app')
    await mkdir(project)
    const { sessionId, send } = await openSession(host)

    await send('make me an app')
    expect(answers[0]).toMatchObject({ isError: true })
    expect(answers[0]?.content[0]?.text).toMatch(/not supported for opencode/)
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([host.workspaceId]))
    // Refused before the folder was looked at: it is not added as a project.
    expect(host.server.workspaces.list().map((workspace) => workspace.path)).not.toContain(
      await realpath(project),
    )
    await settle()
    expect(prompts).toHaveLength(1)
  })

  it('resolves a relative path against the folder the agent works in', async () => {
    const answers: ToolAnswer[] = []
    const { connections, opened, prompts } = movingAgent(() => '../sibling/./app', answers)
    const host = await startHost(connections)
    await mkdir(join(host.dataDir, 'sibling', 'app'), { recursive: true })
    const { send } = await openSession(host)

    await send('make me an app', 2)
    const canonical = await realpath(join(host.dataDir, 'sibling', 'app'))
    expect(answers[0]?.isError).toBeFalsy()
    expect(answers[0]?.content[0]?.text).toContain(canonical)
    expect(opened.at(-1)).toMatchObject({ method: 'load', cwd: canonical })
    expect(prompts[1]).toEqual({ text: movedPrompt('app', canonical), cwd: canonical })
  })

  it('refuses the folder the session already works in', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections, prompts } = movingAgent(() => project, answers)
    const host = await startHost(connections)
    project = host.workspaceRoot
    const { send } = await openSession(host)

    await send('make me an app')
    expect(answers[0]).toMatchObject({ isError: true })
    expect(answers[0]?.content[0]?.text).toMatch(/already works in/)
    await settle()
    expect(prompts).toHaveLength(1)
  })
})

describe('move_session on the rows, its provider driven by hand', () => {
  type RuntimeEvent = Parameters<ReturnType<typeof createThreadService>['onRuntimeEvent']>[0]
  type PromptArgs = { cwd: string; prompt: { text: string }; userMessageId: string }
  const closers: (() => void)[] = []
  afterEach(() => {
    for (const close of closers.splice(0)) close()
  })

  /** A Claude chat in `/workspace/project` on an in-memory database, `/workspace/other` beside it. */
  async function setup() {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
    runMigrations(database, MIGRATIONS)
    for (const id of ['/workspace/project', '/workspace/other']) {
      database
        .prepare(
          'INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
        )
        .run(id, id.slice('/workspace/'.length), id)
    }
    const published: EventEnvelope[] = []
    const events = createPersistentEventService(
      database,
      (record) => published.push(record.event),
      {},
    )
    closers.push(() => {
      events.close()
      database.close()
    })
    const problems: string[] = []
    const persistence: unknown[] = []
    let seq = 0
    let threadId = ''
    const emit = (
      event: Pick<RuntimeEvent, 'category' | 'event'> & { data: unknown },
      messageId?: string,
    ) =>
      service.onRuntimeEvent({
        providerId: 'claude',
        threadId,
        workspaceId: '/workspace/project',
        sessionId: 'provider-session',
        id: `event-${++seq}`,
        seq,
        timestamp: new Date(Date.now() + seq).toISOString(),
        ...(messageId ? { messageId } : {}),
        ...event,
      } as RuntimeEvent)
    // Each prompt settles when the test ends its turn (`completed`).
    const finish: (() => void)[] = []
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(
        (_args: PromptArgs) => new Promise<void>((resolve) => finish.push(() => resolve())),
      ),
      cancel: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn().mockResolvedValue(undefined),
      withdrawSteer: vi.fn().mockResolvedValue(false),
      respondPlan: vi.fn((args: { requestId: string; outcome: unknown }) => {
        emit(
          {
            category: 'session',
            event: 'plan_review_resolved',
            data: { requestId: args.requestId, outcome: args.outcome },
          },
          'assistant-0',
        )
        return true
      }),
    }
    const resolver: WorkspaceRuntimeResolver = (workspaceId) =>
      workspaceId === '/workspace/project' || workspaceId === '/workspace/other'
        ? { providerId: 'claude', cwd: workspaceId }
        : undefined
    const service = createThreadService(
      runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
      { rejection: () => undefined },
      (event) => events.append(event),
      undefined,
      resolver,
      {
        database,
        flush: events.flush,
        appendAtomic: (batch, options) => events.appendAtomic(batch, options),
        onMoveProblem: (message) => problems.push(message),
        onPersistenceError: (error) => persistence.push(error),
      },
    )
    service.setEnvironmentId('environment-1')
    const dispatch = (name: string, payload: CommandEnvelope['payload']) =>
      service.dispatch({ type: 'command', requestId: `r-${++seq}`, name, payload })
    const created = ProofResponseSchemas['session.create'].parse(
      dispatch('session.create', {
        environmentId: 'environment-1',
        workspaceId: '/workspace/project',
        providerId: 'claude',
      }),
    ).payload
    const thread = created.thread
    threadId = thread.threadId
    await service.resolveRuntimeSession(created.session.sessionId)

    /** The provider picks up the `n`th prompt the service handed it. */
    const started = async (n: number) => {
      await vi.waitFor(() => expect(runtime.prompt.mock.calls.length).toBeGreaterThan(n))
      const args = runtime.prompt.mock.calls[n]![0]
      emit(
        {
          category: 'lifecycle',
          event: 'prompt_started',
          data: { prompt: args.prompt.text, userMessageId: args.userMessageId },
        },
        `assistant-${n}`,
      )
      return args
    }
    /** The provider ends the turn its output goes under `messageId`. */
    const completed = async (messageId: string) => {
      emit({ category: 'lifecycle', event: 'prompt_completed', data: {} }, messageId)
      const n = /^assistant-(\d+)$/.exec(messageId)?.[1]
      if (n !== undefined) finish[Number(n)]?.()
      // The move and the queue follow the turn's end a microtask later.
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    }
    const send = (text: string) =>
      ProofResponseSchemas['turn.send'].parse(
        dispatch('turn.send', { ...thread, text, commandId: `send-${++seq}` }),
      ).payload
    const steer = (turnId: string, text: string, commandId: string) =>
      dispatch('turn.steer', { ...thread, turnId, text, commandId })
    const move = () => service.requestMove(thread.threadId, '/workspace/other', 'other')
    const workspaces = (sessionId = created.session.sessionId) => {
      events.flush()
      return workspacesOf(database, sessionId)
    }
    const state = () => {
      events.flush()
      return readThreadState(database, thread)!
    }
    return {
      database,
      events,
      published,
      runtime,
      service,
      problems,
      persistence,
      thread,
      sessionId: created.session.sessionId,
      emit,
      dispatch,
      started,
      completed,
      send,
      steer,
      move,
      workspaces,
      state,
    }
  }

  it('moves an attachment only its message ties to the session', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    expect(chat.move()).toMatchObject({ ok: true })
    // What migration 9 leaves when it cannot match an attachment to a
    // session: its message, and no session.
    chat.events.flush()
    chat.database
      .prepare(
        `INSERT INTO attachments (attachment_id, workspace_id, message_id, storage_key, name,
           mime_type, size_bytes, created_at, session_id)
         VALUES ('legacy', '/workspace/project', ?, 'legacy-key', 'a.png', 'image/png', 1, 1, NULL)`,
      )
      .run(sent.userMessage.messageId)

    await chat.completed('assistant-0')
    expect(chat.persistence).toEqual([])
    expect(chat.workspaces()).toEqual(new Set(['/workspace/other']))
    expect(
      chat.database
        .prepare("SELECT workspace_id FROM attachments WHERE attachment_id = 'legacy'")
        .get(),
    ).toEqual({ workspace_id: '/workspace/other' })
    expect((await chat.started(1)).cwd).toBe('/workspace/other')
  })

  it('moves a sub-agent session, and every row under it, with its parent', async () => {
    const chat = await setup()
    chat.send('Delegate')
    await chat.started(0)
    chat.emit(
      {
        category: 'session',
        event: 'subtask_update',
        data: { taskId: 'task-1', title: 'Explore', childSessionId: 'provider-child' },
      },
      'assistant-0',
    )
    chat.events.flush()
    const child = chat.database
      .prepare(
        `SELECT s.session_id, t.thread_id FROM sessions s JOIN threads t USING (session_id)
         WHERE s.parent_session_id = ?`,
      )
      .get(chat.sessionId) as { session_id: string; thread_id: string }
    expect(child).toBeDefined()
    // A turn and a message of the child's own, so its keys reach past its thread.
    chat.database.exec(`
      INSERT INTO turns (turn_id, thread_id, workspace_id, state, started_at, updated_at)
        VALUES ('child-turn', '${child.thread_id}', '/workspace/project', 'completed', 1, 1);
      INSERT INTO messages (message_id, workspace_id, thread_id, turn_id, role, ordinal, created_at, updated_at)
        VALUES ('child-message', '/workspace/project', '${child.thread_id}', 'child-turn', 'assistant', 0, 1, 1);
    `)
    expect(chat.move()).toMatchObject({ ok: true })

    await chat.completed('assistant-0')
    expect(chat.persistence).toEqual([])
    expect(chat.workspaces()).toEqual(new Set(['/workspace/other']))
    expect(chat.workspaces(child.session_id)).toEqual(new Set(['/workspace/other']))
  })

  it('carries the move to the turn a held steer becomes, and applies it when that turn completes', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    expect(chat.move()).toMatchObject({ ok: true })
    expect(chat.steer(sent.turn.turnId, 'Also lint', 's-1')).toMatchObject({
      payload: { outcome: 'steering' },
    })
    await chat.completed('assistant-0')
    expect(chat.workspaces()).toEqual(new Set(['/workspace/project']))

    chat.emit(
      { category: 'lifecycle', event: 'steer_turn_started', data: { steerId: 's-1' } },
      'assistant-late',
    )
    // Still where it was while the steer's own turn runs.
    expect(chat.workspaces()).toEqual(new Set(['/workspace/project']))
    await chat.completed('assistant-late')
    expect(chat.workspaces()).toEqual(new Set(['/workspace/other']))
    const resumed = await chat.started(1)
    expect(resumed).toMatchObject({
      cwd: '/workspace/other',
      prompt: { text: movedPrompt('other', '/workspace/other') },
    })
    expect(chat.problems).toEqual([])
  })

  it('drops the move when the held steer reaches the agent after its turn, never applying it later', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    expect(chat.move()).toMatchObject({ ok: true })
    chat.steer(sent.turn.turnId, 'Also lint', 's-1')
    await chat.completed('assistant-0')
    // Delivered with no turn left to show it in: it becomes no turn.
    chat.emit({ category: 'lifecycle', event: 'steer_delivered', data: { steerId: 's-1' } })
    expect(chat.problems).toEqual([expect.stringMatching(/move was dropped/)])

    // A later, unrelated turn completes: the session stays where it is.
    chat.send('Something else')
    expect((await chat.started(1)).cwd).toBe('/workspace/project')
    await chat.completed('assistant-1')
    await settle()
    expect(chat.workspaces()).toEqual(new Set(['/workspace/project']))
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(2)
  })

  it('applies the move when the held steer is given back, then runs it in the new folder', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    expect(chat.move()).toMatchObject({ ok: true })
    chat.steer(sent.turn.turnId, 'Also lint', 's-1')
    await chat.completed('assistant-0')
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(1)

    chat.emit({ category: 'lifecycle', event: 'steer_withdrawn', data: { steerId: 's-1' } })
    expect(chat.workspaces()).toEqual(new Set(['/workspace/other']))
    expect(await chat.started(1)).toMatchObject({
      cwd: '/workspace/other',
      prompt: { text: movedPrompt('other', '/workspace/other') },
    })
    await chat.completed('assistant-1')
    expect(await chat.started(2)).toMatchObject({
      cwd: '/workspace/other',
      prompt: { text: 'Also lint' },
    })
    expect(chat.problems).toEqual([])
  })

  it('runs an approved plan build in the new folder in place of the resume turn, with the marker', async () => {
    const chat = await setup()
    chat.send('Plan it')
    await chat.started(0)
    expect(chat.move()).toMatchObject({ ok: true })
    chat.emit(
      {
        category: 'session',
        event: 'plan_review_request',
        data: {
          sessionId: 'provider-session',
          requestId: 'provider-plan',
          markdown: '# Plan',
          todos: [],
          continuation: 'follow_up_turn',
        },
      },
      'assistant-0',
    )
    chat.events.flush()
    const plan = (
      chat.published.filter((event) => event.name === 'interaction.requested').at(-1)!.payload as {
        interaction: { interactionId: string }
      }
    ).interaction
    const answered = chat.dispatch('interaction.respond', {
      ...chat.thread,
      response: {
        kind: 'plan',
        interactionId: plan.interactionId,
        outcome: { outcome: 'accepted' },
      } as never,
      commandId: 'build-1',
      build: { text: 'Implement the approved plan' },
    })
    await chat.completed('assistant-0')
    expect(await answered).toMatchObject({ type: 'response' })

    // One turn follows, the build, in the new folder: told where it is, and
    // opening with the move's marker. No resume turn competes with it.
    const build = await chat.started(1)
    expect(build).toMatchObject({
      cwd: '/workspace/other',
      prompt: {
        text: `${movedPrompt('other', '/workspace/other').split(' Carry on')[0]}\n\nImplement the approved plan`,
      },
    })
    const state = chat.state()
    const buildTurn = state.turns.at(-1)!
    expect(state.turns).toHaveLength(2)
    // Sent on the user's behalf, not a background turn of the environment's.
    expect(buildTurn.origin).toBeUndefined()
    expect(state.notices.filter((notice) => notice.turnId === buildTurn.turnId)).toEqual([
      expect.objectContaining({
        move: { workspaceId: '/workspace/other', name: 'other', path: '/workspace/other' },
      }),
    ])
    // The user's message reads as they sent it.
    expect(state.messages.find((message) => message.turnId === buildTurn.turnId)?.content).toEqual([
      { type: 'text', text: 'Implement the approved plan' },
    ])
    expect(chat.problems).toEqual([])
    await chat.completed('assistant-1')
    await settle()
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(2)
  })
})

describe('move_session without a database', () => {
  type RuntimeEvent = Parameters<ReturnType<typeof createThreadService>['onRuntimeEvent']>[0]

  it('announces the resume turn itself and never shows its prompt as the user', async () => {
    const resolve: WorkspaceRuntimeResolver = (workspaceId) =>
      workspaceId === '/workspace/project' || workspaceId === '/workspace/other'
        ? { providerId: 'claude', cwd: workspaceId }
        : undefined
    const published: EventEnvelope[] = []
    let service!: ReturnType<typeof createThreadService>
    let seq = 0
    const emit = (
      event: Pick<RuntimeEvent, 'category' | 'event'> & { data: unknown },
      messageId: string,
    ) =>
      service.onRuntimeEvent({
        providerId: 'claude',
        threadId: created.thread.threadId,
        workspaceId: '/workspace/project',
        sessionId: 'provider-session',
        id: `event-${++seq}`,
        seq,
        timestamp: new Date(Date.UTC(2026, 10, 19, 10, 0, seq)).toISOString(),
        messageId,
        ...event,
      } as RuntimeEvent)
    const prompts: { text: string; cwd: string }[] = []
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(
        async (args: { cwd: string; prompt: { text: string }; userMessageId: string }) => {
          prompts.push({ text: args.prompt.text, cwd: args.cwd })
          const messageId = `assistant-${prompts.length}`
          emit(
            {
              category: 'lifecycle',
              event: 'prompt_started',
              data: { prompt: args.prompt.text, userMessageId: args.userMessageId },
            },
            messageId,
          )
          // A provider that echoes the prompt back.
          emit(
            {
              category: 'stream',
              event: 'user_message_chunk',
              data: { content: { type: 'text', text: args.prompt.text } },
            },
            messageId,
          )
          if (prompts.length === 1) {
            expect(
              service.requestMove(created.thread.threadId, '/workspace/other', 'other'),
            ).toMatchObject({
              ok: true,
            })
          }
          emit(
            {
              category: 'stream',
              event: 'agent_message_chunk',
              data: { content: { type: 'text', text: 'Done.' } },
            },
            messageId,
          )
        },
      ),
      cancel: vi.fn().mockResolvedValue(undefined),
      closeThread: vi.fn().mockResolvedValue(undefined),
    }
    service = createThreadService(
      runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
      { rejection: () => undefined },
      (event) => published.push(event),
      undefined,
      resolve,
      {},
    )
    service.setEnvironmentId('environment-1')
    const dispatch = (name: string, payload: CommandEnvelope['payload']) =>
      service.dispatch({ type: 'command', requestId: name.replaceAll('.', '-'), name, payload })
    const created = ProofResponseSchemas['session.create'].parse(
      dispatch('session.create', {
        environmentId: 'environment-1',
        workspaceId: '/workspace/project',
        providerId: 'claude',
      }),
    ).payload
    await service.resolveRuntimeSession(created.session.sessionId)

    dispatch('turn.send', { ...created.thread, text: 'Build it' })
    await vi.waitFor(() =>
      expect(published.filter((event) => event.name === 'turn.completed')).toHaveLength(2),
    )
    expect(prompts).toEqual([
      { text: 'Build it', cwd: '/workspace/project' },
      { text: movedPrompt('other', '/workspace/other'), cwd: '/workspace/other' },
    ])
    const started = published.filter((event) => event.name === 'turn.started')
    expect(
      started.map((event) => (event.payload as { turn: { origin?: string } }).turn.origin),
    ).toEqual([undefined, 'background'])
    expect((started[1]!.payload as { userMessage?: unknown }).userMessage).toBeUndefined()
    const resumeId = (started[1]!.payload as { turn: { turnId: string } }).turn.turnId
    const resumeEvents = published.filter(
      (event) => (event.payload as { turnId?: string }).turnId === resumeId,
    )
    expect(resumeEvents[0]).toMatchObject({
      name: 'turn.notice.recorded',
      payload: {
        kind: 'info',
        move: { workspaceId: '/workspace/other', name: 'other', path: '/workspace/other' },
      },
    })
    expect(
      resumeEvents.some(
        (event) =>
          event.name === 'message.delta' && (event.payload as { role: string }).role === 'user',
      ),
    ).toBe(false)
  })
})
