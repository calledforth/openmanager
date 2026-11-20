import { hostname, userInfo } from 'node:os'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import { describe, expect, it } from 'vitest'
import {
  CodexAppServerClient,
  CodexProcessExitedError,
  type ClientParams,
  type NotificationMethod,
  type NotificationParams,
} from '../CodexAppServerClient.js'
import { isWireRequest } from './FakeCodexAppServer.js'
import { CODEX_FIXTURES, readCodexFixture, type CodexFixture, type CodexFixtureName } from './fixture.js'
import { ReplayCodexAppServer } from './ReplayCodexAppServer.js'

/** Each committed fixture, recorded from the real codex 0.170, replayed to
 * the real client. The test drives the client the way the recorder drove
 * Codex, and the replay checks the client sent the same thing: every recorded
 * client message is matched (`unmatched` is empty), with the same params. */

const CLIENT_VERSION = '0.0.0-fixture'

// Notifications read back in assertions are poked at freely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Seen = { method: string; params: any }[]
const WORKSPACE = '/workspace'

async function replay(fixture: CodexFixtureName | CodexFixture) {
  const server = new ReplayCodexAppServer(fixture)
  const client = new CodexAppServerClient(server, {
    log: () => undefined,
    terminateGraceMs: 1_000,
    requestTimeoutMs: 5_000,
  })
  const seen: Seen = []
  client.onAny((message) => seen.push(message as (typeof seen)[number]))
  await client.initialize({ clientVersion: CLIENT_VERSION })
  return { server, client, seen }
}

/** The first notification of `method` (that `where` accepts) from now on. */
function next<M extends NotificationMethod>(
  client: CodexAppServerClient,
  method: M,
  where: (params: NotificationParams<M>) => boolean = () => true,
): Promise<NotificationParams<M>> {
  // `unknown` inside: TypeScript cannot relate the distributive params type
  // to itself through Promise's resolve.
  return new Promise<unknown>((resolve) => {
    const off = client.on(method, (params) => {
      if (!where(params)) return
      off()
      resolve(params)
    })
  }) as Promise<NotificationParams<M>>
}

/** The recording played to its end, and the client sent what Codex was
 * recorded receiving: the same messages, in the same order, with the same
 * answers and (these tests drive the client exactly as the recorder drove
 * Codex) the same params. */
async function expectPlayedAsRecorded(server: ReplayCodexAppServer) {
  await server.done
  server.assertPlayedAsRecorded({ params: true })
  expect(server.matched).toHaveLength(server.recordedClientMessages().length)
}

function text(input: string): ClientParams<'turn/start'>['input'] {
  return [{ type: 'text', text: input, text_elements: [] }]
}

const agentText = (seen: Seen, threadId: string) =>
  seen
    .filter((m) => m.method === 'item/agentMessage/delta' && m.params.threadId === threadId)
    .map((m) => m.params.delta as string)
    .join('')

const lowCost = { effort: 'low', summary: 'detailed', model: 'gpt-6-luna' } as const

describe('codex replay fixtures', () => {
  it('are all recorded from the pinned codex, sanitised, and end with the recorder shutting codex down', () => {
    const machine = hostname().toLowerCase()
    const user = userInfo().username.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const name of CODEX_FIXTURES) {
      const fixture = readCodexFixture(name)
      expect(fixture.header).toMatchObject({ scenario: name, codexVersion: '0.170.0' })
      const text = JSON.stringify(fixture)
      expect(text).not.toMatch(/\/home\/(?!user\b)[a-z]/)
      expect(text).not.toMatch(/\/Users\//)
      expect(text).not.toMatch(/\/mnt\/[a-z]\/Users\//i)
      // `C:\Users`, however many times its backslash is escaped.
      expect(text).not.toMatch(/[A-Z]:(\\)+Users/i)
      // No email at all: the recorder's placeholder is not committed either.
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      // This machine's name and user, which is whoever recorded last.
      if (machine.length >= 4) expect(text.toLowerCase()).not.toContain(machine)
      if (user.length >= 3 && user !== 'user') expect(text.toLowerCase()).not.toMatch(new RegExp(`[\\\\/]${user}\\b`))
      expect(fixture.entries.at(-1)).toMatchObject({ exit: { cause: 'client' } })
    }
  })
})

describe('ReplayCodexAppServer with the real client', () => {
  it('simple-turn: one turn answered with text', async () => {
    const { server, client, seen } = await replay('simple-turn')
    const { thread } = await client.request('thread/start', {
      cwd: WORKSPACE,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    expect(thread).toMatchObject({ ephemeral: true, cwd: WORKSPACE, originator: 'OpenManager' })
    const completed = next(client, 'turn/completed', (p) => p.threadId === thread.id)
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: text('Reply with exactly the word: pong'),
      ...lowCost,
    })
    expect(turn.status).toBe('inProgress')

    const done = await completed
    expect(done.turn).toMatchObject({ id: turn.id, status: 'completed' })
    expect(done.turn.items).toEqual([expect.objectContaining({ type: 'agentMessage', text: 'pong' })])
    expect(agentText(seen, thread.id)).toBe('pong')
    await expectPlayedAsRecorded(server)
    expect(client.stats.decodeErrors).toBe(0)
    expect(client.stats.unknownNotifications.size).toBe(0)
  })

  it('command-approval: the client approves a command and Codex resolves the request', async () => {
    const { server, client, seen } = await replay('command-approval')
    const asked: v2.CommandExecutionRequestApprovalParams[] = []
    client.handle('item/commandExecution/requestApproval', (params) => {
      asked.push(params)
      return { decision: 'accept' }
    })
    const { thread } = await client.request('thread/start', {
      cwd: WORKSPACE,
      ephemeral: true,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    const completed = next(client, 'turn/completed', (p) => p.threadId === thread.id)
    await client.request('turn/start', {
      threadId: thread.id,
      input: text('Use the shell to run exactly: mkdir made-by-codex\nThen reply "done". Do nothing else.'),
      ...lowCost,
      approvalPolicy: 'untrusted',
    })
    await completed

    expect(asked).toEqual([
      expect.objectContaining({
        kind: 'command',
        threadId: thread.id,
        command: "/bin/bash -lc 'mkdir made-by-codex'",
        availableDecisions: ['accept', expect.objectContaining({ acceptWithExecpolicyAmendment: expect.anything() }), 'cancel'],
      }),
    ])
    expect(seen.find((m) => m.method === 'serverRequest/resolved')?.params).toEqual({
      threadId: thread.id,
      requestId: 0,
    })
    const command = seen.find((m) => m.method === 'item/completed' && m.params.item.type === 'commandExecution')
    expect(command?.params.item).toMatchObject({ status: 'completed', exitCode: 0 })
    expect(agentText(seen, thread.id)).toBe('done')
    await expectPlayedAsRecorded(server)
  })

  it('file-change-approval: the client approves a patch', async () => {
    const { server, client, seen } = await replay('file-change-approval')
    client.handle('item/commandExecution/requestApproval', () => ({ decision: 'accept' }))
    const asked: v2.FileChangeRequestApprovalParams[] = []
    client.handle('item/fileChange/requestApproval', (params) => {
      asked.push(params)
      return { decision: 'accept' }
    })
    const { thread } = await client.request('thread/start', {
      cwd: WORKSPACE,
      ephemeral: true,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    const completed = next(client, 'turn/completed', (p) => p.threadId === thread.id)
    await client.request('turn/start', {
      threadId: thread.id,
      input: text(
        'Create the file hello.txt containing the single line "hi" using apply_patch. Then reply "done". Do nothing else.',
      ),
      ...lowCost,
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    await completed

    const patch = seen.find((m) => m.method === 'item/completed' && m.params.item.type === 'fileChange')
    expect(patch?.params.item).toMatchObject({
      status: 'completed',
      changes: [{ path: `${WORKSPACE}/hello.txt`, kind: { type: 'add' }, diff: 'hi\n' }],
    })
    expect(asked).toEqual([expect.objectContaining({ threadId: thread.id, itemId: patch?.params.item.id })])
    expect(seen.filter((m) => m.method === 'serverRequest/resolved')).toHaveLength(1)
    await expectPlayedAsRecorded(server)
  })

  it('permissions-approval: the client grants what request_permissions asked for', async () => {
    const { server, client, seen } = await replay('permissions-approval')
    client.handle('item/permissions/requestApproval', (params) => ({
      permissions: params.permissions as v2.GrantedPermissionProfile,
      scope: 'turn',
    }))
    const { thread } = await client.request('thread/start', {
      cwd: WORKSPACE,
      ephemeral: true,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    const completed = next(client, 'turn/completed', (p) => p.threadId === thread.id)
    await client.request('turn/start', {
      threadId: thread.id,
      input: text(
        'Before anything else, call the request_permissions tool to ask for write access to the current directory. After it answers, reply "done". Do nothing else.',
      ),
      ...lowCost,
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    await completed
    expect(seen.find((m) => m.method === 'serverRequest/resolved')?.params.requestId).toBe(0)
    // The answer is in `matched`, compared with the recorded one there.
    await expectPlayedAsRecorded(server)
    expect(server.matched.at(-1)?.actual.result).toMatchObject({
      scope: 'turn',
      permissions: { fileSystem: { write: [WORKSPACE] } },
    })
  })

  it("subagent: the child thread's notifications interleave with the parent's", async () => {
    const { server, client, seen } = await replay('subagent')
    const { thread } = await client.request('thread/start', {
      cwd: WORKSPACE,
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    const completed = next(client, 'turn/completed', (p) => p.threadId === thread.id)
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: text(
        'Spawn exactly one subagent with the prompt "Reply with exactly: 42". Wait for it to finish, then reply with its answer and nothing else.',
      ),
      ...lowCost,
      approvalPolicy: 'never',
    })
    await completed

    const spawned = seen.find((m) => m.method === 'item/started' && m.params.item.type === 'subAgentActivity')
    const childId: string = spawned!.params.item.agentThreadId
    expect(childId).not.toBe(thread.id)
    // Codex 0.170 announces no child thread with thread/started.
    expect(seen.filter((m) => m.method === 'thread/started').map((m) => m.params.thread.id)).toEqual([thread.id])

    const turns = seen
      .filter((m) => m.method === 'turn/started' || m.method === 'turn/completed')
      .map((m) => `${m.params.threadId === childId ? 'child' : 'parent'} ${m.method}`)
    expect(turns).toEqual(['parent turn/started', 'child turn/started', 'child turn/completed', 'parent turn/completed'])
    // The child's turn is attributed to the parent's turn.
    const childTurn = seen.find((m) => m.method === 'turn/started' && m.params.threadId === childId)!
    expect(childTurn.params.turn.rootTurnId).toBe(turn.id)
    expect(agentText(seen, thread.id)).toBe('42')
    await expectPlayedAsRecorded(server)
  })

  it('interrupt-with-child: interrupting the parent leaves the child running until it is interrupted too', async () => {
    const { server, client, seen } = await replay('interrupt-with-child')
    const { thread } = await client.request('thread/start', {
      cwd: WORKSPACE,
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    const childTurnStarted = next(client, 'turn/started', (p) => p.threadId !== thread.id)
    const childCommand = next(
      client,
      'item/started',
      (p) => p.threadId !== thread.id && p.item.type === 'commandExecution',
    )
    const parentDone = next(client, 'turn/completed', (p) => p.threadId === thread.id)
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: text(
        'Spawn exactly one subagent with the prompt "Use the shell to run: sleep 30. Then reply done." and wait for it.',
      ),
      ...lowCost,
      approvalPolicy: 'never',
    })
    const child = await childTurnStarted
    await childCommand

    await expect(client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })).resolves.toEqual({})
    expect((await parentDone).turn).toMatchObject({ id: turn.id, status: 'interrupted', items: [] })
    // The child is still running after its parent's turn has ended.
    expect(seen.some((m) => m.method === 'turn/completed' && m.params.threadId === child.threadId)).toBe(false)

    const childDone = next(client, 'turn/completed', (p) => p.threadId === child.threadId)
    await client.request('turn/interrupt', { threadId: child.threadId, turnId: child.turn.id })
    expect((await childDone).turn).toMatchObject({ status: 'interrupted', rootTurnId: turn.id })
    await expectPlayedAsRecorded(server)
  })

  it('steer: input added to a running turn finishes in the same turn', async () => {
    const { server, client, seen } = await replay('steer')
    const { thread } = await client.request('thread/start', {
      cwd: WORKSPACE,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    const running = next(client, 'item/started', (p) => p.item.type === 'commandExecution')
    const completed = next(client, 'turn/completed', (p) => p.threadId === thread.id)
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: text('Use the shell to run exactly: sleep 4\nThen reply "first".'),
      ...lowCost,
      approvalPolicy: 'never',
    })
    await running
    await expect(
      client.request('turn/steer', {
        threadId: thread.id,
        expectedTurnId: turn.id,
        input: text('Also add the word "second" to your reply.'),
      }),
    ).resolves.toEqual({ turnId: turn.id })
    expect((await completed).turn).toMatchObject({ id: turn.id, status: 'completed' })

    // The steer shows up as a second user message in the same turn.
    const prompts = seen
      .filter((m) => m.method === 'item/completed' && m.params.item.type === 'userMessage')
      .map((m) => [m.params.turnId, m.params.item.content[0].text])
    expect(prompts).toEqual([
      [turn.id, 'Use the shell to run exactly: sleep 4\nThen reply "first".'],
      [turn.id, 'Also add the word "second" to your reply.'],
    ])
    expect(seen.filter((m) => m.method === 'turn/completed')).toHaveLength(1)
    expect(agentText(seen, thread.id)).toBe('first second')
    await expectPlayedAsRecorded(server)
  })
})

describe('ReplayCodexAppServer', () => {
  /** A recording cut down to the handshake and one request. */
  function small(extra: CodexFixture['entries'] = []): CodexFixture {
    const recorded = readCodexFixture('simple-turn')
    const handshake = recorded.entries.filter(
      (entry) =>
        'message' in entry &&
        (entry.message.method === 'initialize' ||
          entry.message.method === 'initialized' ||
          (entry.from === 'server' && entry.message.id === 1)),
    )
    return { header: recorded.header, entries: [...handshake, ...extra] }
  }

  it('answers under the id the client used, not the recorded one', async () => {
    // Recorded as request 7; the client will send it as request 2.
    const fixture = small([
      { atMs: 1, from: 'client', message: { id: 7, method: 'model/list', params: {} } },
      { atMs: 2, from: 'server', message: { id: 7, result: { data: [], nextCursor: null } } },
    ])
    const { server, client } = await replay(fixture)
    await expect(client.request('model/list', {})).resolves.toEqual({ data: [], nextCursor: null })
    expect(server.matched.at(-1)).toMatchObject({ recorded: { id: 7 }, actual: { id: 2 } })
    await expectPlayedAsRecorded(server)
  })

  it('refuses a request the recording has no place for, and reports it', async () => {
    const { server, client } = await replay(small())
    await server.done
    await expect(client.request('account/read', { refreshToken: false })).rejects.toThrow(/not in the recording/)
    expect(server.unmatched.filter(isWireRequest).map((m) => m.method)).toEqual(['account/read'])
  })

  it('says what it is waiting for when the client has not sent it', async () => {
    const fixture = small([
      { atMs: 1, from: 'client', message: { id: 2, method: 'thread/start', params: {} } },
      { atMs: 2, from: 'server', message: { id: 2, result: {} } },
    ])
    const { server } = await replay(fixture)
    expect(server.finished).toBe(false)
    expect(server.waitingFor).toMatchObject({ method: 'thread/start' })
  })

  it('plays a recorded crash: stderr, then the exit', async () => {
    const fixture = small([
      { atMs: 1, from: 'client', message: { id: 2, method: 'model/list', params: {} } },
      { atMs: 2, from: 'server', stderr: "thread 'main' panicked at src/x.rs:1:2:" },
      { atMs: 2, from: 'server', stderr: 'boom' },
      { atMs: 3, from: 'server', exit: { code: 101, signal: null } },
    ])
    const { server, client } = await replay(fixture)
    const waiting = client.request('model/list', {})
    await expect(waiting).rejects.toBeInstanceOf(CodexProcessExitedError)
    await expect(waiting).rejects.toThrow(/exit code 101\): thread 'main' panicked at src\/x\.rs:1:2: boom/)
    await server.done
    expect(server.exitCode).toBe(101)
  })

  /** Raw lines into the replay, as a client that gets the protocol wrong
   * would write them. */
  function write(server: ReplayCodexAppServer, ...messages: unknown[]) {
    for (const message of messages) server.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => process.nextTick(resolve))
  }

  it('refuses a request sent before the message the recording has next', async () => {
    const server = new ReplayCodexAppServer(
      small([
        { atMs: 1, from: 'client', message: { id: 2, method: 'model/list', params: {} } },
        { atMs: 2, from: 'server', message: { id: 2, result: { data: [], nextCursor: null } } },
      ]),
    )
    const initialize = readCodexFixture('simple-turn').entries.find(
      (entry) => entry.from === 'client' && 'message' in entry && entry.message.method === 'initialize',
    )!
    // A request before `initialized`, which the recording has next.
    write(server, (initialize as { message: unknown }).message, { id: 2, method: 'model/list', params: {} })
    await flush()
    expect(server.sent.find((m) => m.id === 2)).toMatchObject({
      error: { code: -32600, message: 'replay: expected notification initialized next, not request model/list' },
    })
    expect(server.mismatches).toEqual([
      { kind: 'order', expected: { method: 'initialized' }, actual: { id: 2, method: 'model/list', params: {} } },
    ])
    expect(server.waitingFor).toMatchObject({ method: 'initialized' })
    expect(() => server.assertPlayedAsRecorded()).toThrow(/expected notification initialized, the client sent/)
  })

  it('reports an answer to a server request unlike the recorded one', async () => {
    const { server, client } = await replay('command-approval')
    client.handle('item/commandExecution/requestApproval', () => ({ decision: 'decline' }))
    const { thread } = await client.request('thread/start', {
      cwd: WORKSPACE,
      ephemeral: true,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: { notify: [] },
      model: 'gpt-6-luna',
    })
    await client.request('turn/start', {
      threadId: thread.id,
      input: text('Use the shell to run exactly: mkdir made-by-codex\nThen reply "done". Do nothing else.'),
      ...lowCost,
      approvalPolicy: 'untrusted',
    })
    await server.done
    expect(server.unmatched).toEqual([])
    expect(server.mismatches).toEqual([
      {
        kind: 'answer',
        recorded: { id: 0, result: { decision: 'accept' } },
        actual: { id: 0, result: { decision: 'decline' } },
      },
    ])
    expect(() => server.assertPlayedAsRecorded()).toThrow(/answer to server request 0/)
  })

  it('compares params only when asked to', async () => {
    const fixture = small([
      { atMs: 1, from: 'client', message: { id: 2, method: 'model/list', params: { limit: 5 } } },
      { atMs: 2, from: 'server', message: { id: 2, result: { data: [], nextCursor: null } } },
    ])
    const { server, client } = await replay(fixture)
    await client.request('model/list', { limit: 6 })
    await server.done
    expect(() => server.assertPlayedAsRecorded()).not.toThrow()
    expect(() => server.assertPlayedAsRecorded({ params: true })).toThrow(/request model\/list had params \{"limit":6\}/)
  })

  it('answers a request the test scripted itself outside the recording', async () => {
    const { server, client } = await replay(small())
    server.respond('account/read', { account: null, userId: null, requiresOpenaiAuth: true, workspaceRouting: null })
    await expect(client.request('account/read', { refreshToken: false })).resolves.toMatchObject({
      requiresOpenaiAuth: true,
    })
    await server.done
    server.assertPlayedAsRecorded()
  })

  it('stops a paced replay when the process exits', async () => {
    const fixture = small([{ atMs: 60_000, from: 'server', stderr: 'a minute later' }])
    fixture.entries.forEach((entry, index) => {
      if (index < 3) entry.atMs = 0
    })
    const server = new ReplayCodexAppServer(fixture, { pace: 'recorded' })
    const client = new CodexAppServerClient(server, { log: () => undefined, terminateGraceMs: 1, requestTimeoutMs: 0 })
    await client.initialize({ clientVersion: CLIENT_VERSION })
    await client.terminate({ reason: 'disposed' })
    // `done` settles on exit instead of a minute later; nothing was played.
    await server.done
    expect(server.finished).toBe(false)
    expect(client.stderrTail).not.toContain('a minute later')
    expect(() => server.assertPlayedAsRecorded()).toThrow(/stopped at entry 4 of 4/)
  })

  it('keeps the recorded gaps when asked to', async () => {
    const fixture = small([
      { atMs: 400, from: 'client', message: { id: 2, method: 'model/list', params: {} } },
      { atMs: 450, from: 'server', message: { id: 2, result: { data: [], nextCursor: null } } },
    ])
    fixture.entries.forEach((entry, index) => {
      if (index < 3) entry.atMs = 0
    })
    const server = new ReplayCodexAppServer(fixture, { pace: 'recorded', speed: 1 })
    const client = new CodexAppServerClient(server, { log: () => undefined, terminateGraceMs: 1, requestTimeoutMs: 0 })
    await client.initialize({ clientVersion: CLIENT_VERSION })
    const startedAt = Date.now()
    await client.request('model/list', {})
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40)
  })
})
