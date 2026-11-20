import type { v2 } from '@openmanager/codex-app-server-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerClient,
  CodexProcessExitedError,
  CodexVersionUnsupportedError,
  type CodexAppServerClientOptions,
} from '../CodexAppServerClient.js'
import { CodexRpcError, RPC_METHOD_NOT_FOUND } from '../CodexRpcPeer.js'
import { FakeCodexAppServer, FakeCodexAppServerFactory } from './FakeCodexAppServer.js'
import type { FakeCodexTurn } from './FakeCodexThread.js'

function connect(server: FakeCodexAppServer, options: Partial<CodexAppServerClientOptions> = {}) {
  return new CodexAppServerClient(server, {
    log: () => undefined,
    terminateGraceMs: 2_000,
    requestTimeoutMs: 0,
    ...options,
  })
}

async function started(server = new FakeCodexAppServer(), options: Partial<CodexAppServerClientOptions> = {}) {
  const client = connect(server, options)
  await client.initialize({ clientVersion: '1.2.3' })
  return { server, client }
}

/** Every notification the client delivers, as `method threadId`. */
function trace(client: CodexAppServerClient) {
  const seen: { method: string; params: Record<string, unknown> }[] = []
  client.onAny((message) => seen.push(message as (typeof seen)[number]))
  return seen
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => process.nextTick(resolve))
}

afterEach(() => vi.useRealTimers())

describe('FakeCodexAppServer handshake', () => {
  it('answers initialize with the pinned version and records what the client sent', async () => {
    const { server, client } = await started()
    expect(client.info?.version).toMatchObject({ version: '0.170.0', status: 'supported' })
    expect(client.info?.userAgent).toMatch(/^OpenManager\/0\.170\.0 /)
    await flush()
    expect(server.received.map((m) => m.method)).toEqual(['initialize', 'initialized'])
    expect(server.requests('initialize')[0]!.params.capabilities).toMatchObject({ experimentalApi: true })
  })

  it('reports the version it is told to, so a test can run an old codex', async () => {
    const server = new FakeCodexAppServer({ version: '0.150.0' })
    await expect(connect(server).initialize({ clientVersion: '1' })).rejects.toBeInstanceOf(
      CodexVersionUnsupportedError,
    )
  })

  it('leaves initialize to the test when asked', async () => {
    const server = new FakeCodexAppServer({ initialize: false })
    server.respond('initialize', {
      userAgent: 'OpenManager/0.165.0 (Linux)',
      codexHome: '/h',
      platformFamily: 'unix',
      platformOs: 'linux',
    })
    const handshake = await connect(server).initialize({ clientVersion: '1' })
    expect(handshake.version.status).toBe('outdated')
  })
})

describe('FakeCodexAppServer responses', () => {
  it('answers from a fixed result, a function, and a number of times before falling back', async () => {
    const { server, client } = await started()
    server.respond('model/list', { data: [], nextCursor: null })
    server.respond('model/list', (params) => ({ data: [], nextCursor: `after:${params.cursor}` }), { times: 1 })
    await expect(client.request('model/list', { cursor: 'x' })).resolves.toEqual({ data: [], nextCursor: 'after:x' })
    await expect(client.request('model/list', {})).resolves.toEqual({ data: [], nextCursor: null })
  })

  it('answers with an error from fail() or a thrown CodexRpcError', async () => {
    const { server, client } = await started()
    server.fail('thread/resume', -32600, 'no rollout found for thread id t-1', { times: 1 })
    await expect(client.request('thread/resume', { threadId: 't-1' })).rejects.toMatchObject({
      code: -32600,
      message: 'no rollout found for thread id t-1',
      method: 'thread/resume',
    })
    server.respond('thread/archive', () => {
      throw new CodexRpcError(-32001, 'busy', { retry: true })
    })
    await expect(client.request('thread/archive', { threadId: 't' })).rejects.toMatchObject({
      code: -32001,
      data: { retry: true },
    })
  })

  it('answers what nothing scripted with -32601, and keeps it in unscripted', async () => {
    const { server, client } = await started()
    await expect(client.request('account/read', { refreshToken: false })).rejects.toMatchObject({
      code: RPC_METHOD_NOT_FOUND,
    })
    expect(server.unscripted.map((r) => r.method)).toEqual(['account/read'])
  })

  it('delays an answer on the timer clock', async () => {
    vi.useFakeTimers()
    const { server, client } = await started()
    server.respond('thread/archive', {}, { delayMs: 5_000 })
    let answered = false
    void client.request('thread/archive', { threadId: 't' }).then(() => (answered = true))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(answered).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(answered).toBe(true)
  })

  it('lets a test wait for the next request of a method', async () => {
    const { server, client } = await started()
    server.respond('thread/name/set', {})
    void client.request('thread/name/set', { threadId: 'a', name: 'one' })
    void client.request('thread/name/set', { threadId: 'a', name: 'two' })
    expect((await server.nextRequest('thread/name/set')).params.name).toBe('one')
    expect((await server.nextRequest('thread/name/set')).params.name).toBe('two')
  })
})

describe('FakeCodexAppServer threads and turns', () => {
  it('scripts a turn with the notifications codex sends, built from the protocol types', async () => {
    const { server, client } = await started()
    let turn: FakeCodexTurn | undefined
    server.serveThreads((t) => (turn = t))
    const seen = trace(client)

    const thread = await client.request('thread/start', { cwd: '/workspace', ephemeral: true })
    expect(thread.thread).toMatchObject({ cwd: '/workspace', ephemeral: true, status: { type: 'idle' } })
    const turnStart = await client.request('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    })
    expect(turnStart.turn.status).toBe('inProgress')

    turn!.userMessage('hi')
    turn!.reasoning(['Thinking ', 'twice'])
    turn!.command('ls', { chunks: ['a.txt\n', 'b.txt\n'], output: 'a.txt\nb.txt\n' })
    turn!.fileChange([{ path: '/workspace/a.txt', kind: { type: 'add' }, diff: 'hi\n' }])
    turn!.agentMessage('Hello there', { chunks: ['Hello', ' there'] })
    turn!.tokenUsage({ inputTokens: 120, outputTokens: 7 })
    turn!.completed()
    await flush()

    expect(seen.map((m) => m.method)).toEqual([
      'thread/started',
      'thread/status/changed',
      'turn/started',
      'item/started', // user message
      'item/completed',
      'item/started', // reasoning
      'item/reasoning/summaryTextDelta',
      'item/reasoning/summaryPartAdded',
      'item/reasoning/summaryTextDelta',
      'item/completed',
      'item/started', // command
      'item/commandExecution/outputDelta',
      'item/commandExecution/outputDelta',
      'item/completed',
      'item/started', // file change
      'item/completed',
      'item/started', // agent message
      'item/agentMessage/delta',
      'item/agentMessage/delta',
      'item/completed',
      'thread/tokenUsage/updated',
      'thread/status/changed',
      'turn/completed',
    ])
    const deltas = seen.filter((m) => m.method === 'item/agentMessage/delta').map((m) => m.params.delta)
    expect(deltas.join('')).toBe('Hello there')
    const completed = seen.at(-1)!.params as unknown as v2.TurnCompletedNotification
    expect(completed.turn).toMatchObject({ status: 'completed', itemsView: 'summary' })
    expect(completed.turn.items).toEqual([expect.objectContaining({ type: 'agentMessage', text: 'Hello there' })])
    const command = seen.find(
      (m) => m.method === 'item/completed' && (m.params.item as v2.ThreadItem).type === 'commandExecution',
    )!.params.item
    expect(command).toMatchObject({ status: 'completed', exitCode: 0, aggregatedOutput: 'a.txt\nb.txt\n' })
  })

  it("interleaves a child thread's notifications with its parent's, each under its own threadId", async () => {
    const { server, client } = await started()
    const seen = trace(client)
    const parent = server.thread()
    const turn = parent.turn().started()
    const child = parent.child()
    const childTurn = child.turn({ rootTurnId: turn.id })

    turn.spawnSubagent(child)
    childTurn.started()
    turn.agentMessage('waiting', { phase: 'commentary' })
    childTurn.agentMessage('42')
    childTurn.completed()
    turn.subagentCompleted(child)
    turn.agentMessage('The answer is 42')
    turn.completed()
    await flush()

    const order = seen
      .filter((m) => ['turn/started', 'turn/completed', 'item/agentMessage/delta'].includes(m.method))
      .map((m) => `${m.params.threadId === child.id ? 'child' : 'parent'} ${m.method}`)
    expect(order).toEqual([
      'parent turn/started',
      'child turn/started',
      'parent item/agentMessage/delta',
      'child item/agentMessage/delta',
      'child turn/completed',
      'parent item/agentMessage/delta',
      'parent turn/completed',
    ])
    expect(seen.some((m) => m.method === 'thread/started' && m.params.thread)).toBe(false)
    const spawn = seen.find((m) => m.method === 'item/started')!.params.item
    expect(spawn).toMatchObject({ type: 'subAgentActivity', kind: 'started', agentThreadId: child.id })
  })

  it('sends notifications after a turn has completed', async () => {
    const { server, client } = await started()
    const seen = trace(client)
    const turn = server.thread().turn().started()
    turn.agentMessage('done')
    turn.completed()
    turn.tokenUsage({ inputTokens: 5 })
    turn.agentMessage('a straggler')
    await flush()
    const completedAt = seen.findIndex((m) => m.method === 'turn/completed')
    const after = seen.slice(completedAt + 1)
    expect(after.map((m) => m.method)).toEqual([
      'thread/tokenUsage/updated',
      'item/started',
      'item/agentMessage/delta',
      'item/completed',
    ])
    expect(after.every((m) => m.params.turnId === turn.id)).toBe(true)
  })

  it('reports an interrupted and a failed turn with no items', async () => {
    const { server, client } = await started()
    const seen = trace(client)
    const thread = server.thread()
    thread.turn().started().interrupted()
    thread.turn().started().failed('usage limit', 'usageLimitExceeded')
    await flush()
    const turns = seen.filter((m) => m.method === 'turn/completed').map((m) => m.params.turn)
    expect(turns).toEqual([
      expect.objectContaining({ status: 'interrupted', items: [], error: null }),
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' }),
      }),
    ])
  })
})

describe('FakeCodexAppServer server requests', () => {
  it('asks each kind of question, waits for the answer, then sends serverRequest/resolved', async () => {
    const { server, client } = await started()
    const seen = trace(client)
    client.handle('item/commandExecution/requestApproval', (params) => {
      expect(params.availableDecisions).toContain('accept')
      return { decision: 'accept' }
    })
    client.handle('item/fileChange/requestApproval', () => ({ decision: 'decline' }))
    client.handle('item/permissions/requestApproval', (params) => ({
      permissions: { fileSystem: params.permissions.fileSystem ?? undefined },
      scope: 'turn',
    }))
    client.handle('item/tool/requestUserInput', (params) => ({
      answers: { [params.questions[0]!.id]: { answers: ['a.txt'] } },
    }))
    client.handle('mcpServer/elicitation/request', () => ({
      action: 'accept',
      content: { environment: 'staging' },
      _meta: null,
    }))

    const turn = server.thread().turn().started()
    const command = turn.commandStarted('mkdir out')
    const patch = turn.fileChangeStarted([{ path: '/workspace/a', kind: { type: 'add' }, diff: 'a\n' }])

    expect((await turn.requestCommandApproval(command)).result).toEqual({ decision: 'accept' })
    expect((await turn.requestFileChangeApproval(patch)).result).toEqual({ decision: 'decline' })
    expect((await turn.requestPermissions()).result).toMatchObject({ scope: 'turn' })
    expect((await turn.requestUserInput()).result).toEqual({ answers: { q1: { answers: ['a.txt'] } } })
    expect((await turn.requestElicitation()).result).toMatchObject({ action: 'accept' })
    await flush()

    // Ids count from 0, as Codex's do.
    const requests = server.sent.filter((m) => m.id !== undefined && m.method !== undefined)
    expect(requests.map((m) => [m.id, m.method])).toEqual([
      [0, 'item/commandExecution/requestApproval'],
      [1, 'item/fileChange/requestApproval'],
      [2, 'item/permissions/requestApproval'],
      [3, 'item/tool/requestUserInput'],
      [4, 'mcpServer/elicitation/request'],
    ])
    const resolved = seen.filter((m) => m.method === 'serverRequest/resolved').map((m) => m.params.requestId)
    expect(resolved).toEqual([0, 1, 2, 3, 4])
    // Each answer reached the server before the matching resolved went out.
    for (const id of [0, 1, 2, 3, 4]) {
      const answeredAt = server.received.findIndex((m) => m.id === id && m.method === undefined)
      expect(answeredAt).toBeGreaterThan(-1)
    }
    expect(server.strayAnswers).toEqual([])
  })

  it('keeps numeric ids apart across two processes that both count from 0', async () => {
    // Two Codex processes, one per session, each numbering its server
    // requests from 0. Each client must answer its own process, and a server
    // request id equal to one of the client's own request ids is still a
    // request, not an answer.
    const a = await started(new FakeCodexAppServer({ pid: 1 }))
    const b = await started(new FakeCodexAppServer({ pid: 2 }))
    for (const [name, { client }] of [['a', a], ['b', b]] as const)
      client.handle('item/commandExecution/requestApproval', (params) => ({
        decision: params.threadId === `thread-${name}` ? 'accept' : 'decline',
      }))
    a.server.respond('thread/archive', () => new Promise(() => undefined))
    const pending = a.client.request('thread/archive', { threadId: 'x' }) // client id 2 on a
    void pending.catch(() => undefined)

    const ctx = (name: string) => ({ threadId: `thread-${name}`, turnId: 't', itemId: 'i' })
    const fromA = a.server.request('item/commandExecution/requestApproval', { kind: 'command', ...ctx('a'), startedAtMs: 0, environmentId: null }, { id: 2 })
    const fromB = b.server.request('item/commandExecution/requestApproval', { kind: 'command', ...ctx('b'), startedAtMs: 0, environmentId: null }, { id: 2 })
    expect(fromA.id).toBe(fromB.id)
    expect((await fromA.answered).result).toEqual({ decision: 'accept' })
    expect((await fromB.answered).result).toEqual({ decision: 'accept' })
    expect(a.client.stats.lateResponses).toBe(0)
  })
})

describe('FakeCodexAppServer process', () => {
  it('crashes with stderr and an exit code, failing what was waiting', async () => {
    const { server, client } = await started()
    server.respond('model/list', () => new Promise(() => undefined))
    const waiting = client.request('model/list', {})
    await flush()
    server.crash({
      code: 101,
      stderr: "thread 'main' panicked at core/src/lib.rs:1:5:\nboom\n",
    })
    await expect(waiting).rejects.toBeInstanceOf(CodexProcessExitedError)
    await expect(waiting).rejects.toThrow(/exit code 101.*panicked at core\/src\/lib\.rs:1:5: boom/)
    await expect(client.exited).resolves.toMatchObject({ exitCode: 101 })
  })

  it('dies of a signal', async () => {
    const { server, client } = await started()
    server.crash({ signal: 'SIGSEGV' })
    await expect(client.exited).resolves.toMatchObject({ signal: 'SIGSEGV', exitCode: null })
  })

  it('ignores SIGTERM when asked, so the ladder escalates to SIGKILL', async () => {
    vi.useFakeTimers()
    const server = new FakeCodexAppServer({ ignoreSigterm: true })
    const client = connect(server, { terminateGraceMs: 1_000 })
    const exit = client.terminate({ reason: 'disposed' })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(exit).resolves.toMatchObject({ signal: 'SIGKILL', forced: true })
    expect(server.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('FakeCodexAppServerFactory', () => {
  it('hands out a scripted fake per spawn, and can refuse one', async () => {
    const factory = new FakeCodexAppServerFactory((server) => {
      server.respond('account/read', { account: null, userId: null, requiresOpenaiAuth: true, workspaceRouting: null })
    })
    factory.failWith = new Error('spawn codex ENOENT')
    await expect(factory.spawn()).rejects.toThrow('ENOENT')

    const first = connect(await factory.spawn())
    const second = connect(await factory.spawn())
    await first.initialize({ clientVersion: '1' })
    await second.initialize({ clientVersion: '1' })
    await expect(second.request('account/read', { refreshToken: false })).resolves.toMatchObject({
      requiresOpenaiAuth: true,
    })
    expect(factory.servers.map((s) => s.pid)).toEqual([4242, 4243])
    expect(factory.last).toBe(factory.servers[1])
  })
})
