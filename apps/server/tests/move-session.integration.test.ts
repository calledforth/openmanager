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

/** The workspace every row of the session names, read straight from the database. */
function rowWorkspaces(host: ProtocolHost, sessionId: string) {
  const database = new DatabaseSync(join(host.dataDir, 'openmanager.sqlite'), { readOnly: true })
  try {
    const one = (sql: string) =>
      (database.prepare(sql).all(sessionId) as { workspace_id: string }[]).map(
        (row) => row.workspace_id,
      )
    return new Set([
      ...one('SELECT workspace_id FROM sessions WHERE session_id = ?'),
      ...one('SELECT workspace_id FROM threads WHERE session_id = ?'),
      ...one(
        'SELECT workspace_id FROM turns WHERE thread_id IN (SELECT thread_id FROM threads WHERE session_id = ?)',
      ),
      ...one(
        'SELECT workspace_id FROM messages WHERE thread_id IN (SELECT thread_id FROM threads WHERE session_id = ?)',
      ),
    ])
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
    expect(opened[0]).toMatchObject({ method: 'new', cwd: host.workspaceRoot })
    expect(opened.at(-1)).toEqual({ method: 'load', cwd: canonical, sessionId: 'stub-session' })
    expect(prompts.map((prompt) => prompt.cwd)).toEqual([host.workspaceRoot, canonical])
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
    expect(prompts.map((prompt) => prompt.cwd)).toEqual([host.workspaceRoot, host.workspaceRoot])
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
    expect(agent.prompts.at(-1)).toEqual({ text: 'carry on', cwd: host.workspaceRoot })
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
      { text: 'make me an app', cwd: host.workspaceRoot },
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
      host.workspaceRoot,
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
    // The project it joined is announced with its new recency in the same
    // write, under an id the repository can find again on a retried write.
    const joinedOf = (seen: Records) => {
      const moved = moveOf(seen)
      const workspaceId = (moved?.event.payload as { workspaceId?: string } | undefined)
        ?.workspaceId
      return seen.find(
        (record) =>
          record.event.name === 'workspace.updated' &&
          (record.event.payload as { workspace: { workspaceId: string } }).workspace.workspaceId ===
            workspaceId &&
          record.event.eventId.startsWith(`${moved!.event.eventId}:`),
      )
    }
    const records = await collectThreadRecords(watcher, environmentSubscription, (seen) =>
      Boolean(joinedOf(seen)),
    )
    const moved = moveOf(records)!
    const added = host.server.workspaces
      .list()
      .find(
        (workspace) => workspace.workspaceId !== host.workspaceId && workspace.kind !== 'scratch',
      )
    expect(moved.event.payload).toEqual({ sessionId, workspaceId: added!.workspaceId })
    const joined = joinedOf(records)
    expect(joined?.event.eventId).toMatch(/:recency(-to)?$/)
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
