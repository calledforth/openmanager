import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import { ProofResponseSchemas } from '@openmanager/protocol/node'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  startProtocolHost,
  subscribe,
  type ProtocolHost,
} from './helpers/protocol-client.js'
import { promptSessionId } from './helpers/proof-slice.js'

afterEach(async () => {
  await cleanupProtocolHosts()
})

type ToolAnswer = { content: { text: string }[]; isError?: boolean }

/**
 * An ACP agent that, on its first prompt, calls the environment's
 * `move_session` over the MCP endpoint it was given, and records the folder
 * every session it opens or loads runs in.
 */
function movingAgent(target: () => string, answers: ToolAnswer[]) {
  let endpoint: { url: string; headers: Record<string, string> } | undefined
  const opened: { method: 'new' | 'load'; cwd: string; sessionId?: string }[] = []
  let prompts = 0
  const remember = (params: unknown) => {
    const servers = (params as { mcpServers: { url: string; headers: { name: string; value: string }[] }[] })
      .mcpServers
    const server = servers[0]!
    endpoint = {
      url: server.url,
      headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
    }
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
      prompts += 1
      if (prompts === 1) {
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
          params: { name: 'move_session', arguments: { path: target() } },
        })
        answers.push(called.result)
      }
      await connections.last.sessionUpdate({
        sessionId: promptSessionId(params),
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      })
      return { stopReason: 'end_turn' }
    },
  })
  return { connections, opened }
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
  const send = async (text: string) => {
    const sendId = client.command('turn.send', {
      sessionId: session.sessionId,
      threadId: thread.threadId,
      text,
    })
    await nextResponse(client, sendId)
    return collectThreadRecords(client, subscriptionId, (seen) =>
      seen.some((record) => record.event.name === 'turn.completed'),
    )
  }
  return { sessionId: session.sessionId, threadId: thread.threadId, send }
}

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
  it('moves the session to a new project when its turn completes and resumes it there', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections, opened } = movingAgent(() => project, answers)
    const host = await startHost(connections)
    project = join(host.dataDir, 'my-app')
    await mkdir(project)
    const canonical = await realpath(project)
    const { sessionId, send } = await openSession(host)

    await send('make me an app')
    expect(answers[0]?.isError).toBeFalsy()
    expect(answers[0]?.content[0]?.text).toContain(canonical)

    // The folder is a project now, and the session lists under it.
    const added = host.server.workspaces.list().find((workspace) => workspace.path === canonical)
    expect(added).toBeDefined()
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([added!.workspaceId]))

    // The next turn runs in the new folder, on the same provider session.
    await send('carry on')
    expect(opened.at(-1)).toEqual({ method: 'load', cwd: canonical, sessionId: 'stub-session' })
    expect(opened[0]).toMatchObject({ method: 'new', cwd: host.workspaceRoot })
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
    await send('make me an app')
    const records = await collectThreadRecords(watcher, environmentSubscription, (seen) =>
      seen.some(
        (record) =>
          record.event.name === 'session.updated' &&
          (record.event.payload as { workspaceId?: string }).workspaceId !== undefined,
      ),
    )
    const moved = records.find(
      (record) =>
        record.event.name === 'session.updated' &&
        (record.event.payload as { workspaceId?: string }).workspaceId !== undefined,
    )!
    const added = host.server.workspaces
      .list()
      .find((workspace) => workspace.workspaceId !== host.workspaceId && workspace.kind !== 'scratch')
    expect(moved.event.payload).toEqual({ sessionId, workspaceId: added!.workspaceId })
  })

  it('refuses a folder that does not exist, and moves nothing', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections, opened } = movingAgent(() => project, answers)
    const host = await startHost(connections)
    project = join(host.dataDir, 'not-there')
    const { sessionId, send } = await openSession(host)

    await send('make me an app')
    expect(answers[0]).toMatchObject({ isError: true })
    expect(answers[0]?.content[0]?.text).toMatch(/No folder exists/)
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([host.workspaceId]))
    await send('carry on')
    expect(opened).toHaveLength(1)
  })

  it('refuses to move a session whose provider cannot resume it elsewhere', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections } = movingAgent(() => project, answers)
    const host = await startHost(connections, false)
    project = join(host.dataDir, 'my-app')
    await mkdir(project)
    const { sessionId, send } = await openSession(host)

    await send('make me an app')
    expect(answers[0]).toMatchObject({ isError: true })
    expect(answers[0]?.content[0]?.text).toMatch(/not supported for opencode/)
    expect(rowWorkspaces(host, sessionId)).toEqual(new Set([host.workspaceId]))
  })

  it('refuses the folder the session already works in', async () => {
    const answers: ToolAnswer[] = []
    let project = ''
    const { connections } = movingAgent(() => project, answers)
    const host = await startHost(connections)
    project = host.workspaceRoot
    const { send } = await openSession(host)

    await send('make me an app')
    expect(answers[0]).toMatchObject({ isError: true })
    expect(answers[0]?.content[0]?.text).toMatch(/already works in/)
  })
})
