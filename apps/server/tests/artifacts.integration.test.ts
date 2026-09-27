import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  ProofResponseSchemas,
  UploadResponseSchemas,
  UploadResultSchema,
} from '@openmanager/protocol/node'
import { DATABASE_FILENAME, openEnvironmentDatabase } from '../src/db/database.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { startServer } from '../src/server.js'
import {
  cleanupProtocolHosts,
  collectThreadRecords,
  connectProtocol,
  handshake,
  nextResponse,
  subscribe,
  type ProtocolClient,
  type ProtocolHost,
} from './helpers/protocol-client.js'
import { promptSessionId, startStubHost } from './helpers/proof-slice.js'

const directories: string[] = []

afterEach(async () => {
  await cleanupProtocolHosts()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const BYTES = Buffer.from('not really a png, but bytes all the same')
const GENERATED = Buffer.from('a generated image, as far as the environment can tell')

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
  return { client, sessionId: session.sessionId, threadId: thread.threadId, subscriptionId }
}

async function upload(
  host: ProtocolHost,
  client: ProtocolClient,
  scope: string | { workspaceId: string },
) {
  const requestId = client.command('upload.ticket.create', {
    ...(typeof scope === 'string' ? { sessionId: scope } : scope),
    name: 'screenshot.png',
    mimeType: 'image/png',
    sizeBytes: BYTES.byteLength,
  })
  const ticket = UploadResponseSchemas['upload.ticket.create'].parse(
    await nextResponse(client, requestId),
  ).payload
  const response = await fetch(`${host.server.url}${ticket.uploadPath}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${host.token}` },
    body: BYTES,
  })
  expect(response.status).toBe(201)
  return UploadResultSchema.parse(await response.json())
}

const get = (url: string, path: string, token?: string) =>
  fetch(`${url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })

function attachmentRows(dataDir: string) {
  const database = openEnvironmentDatabase(dataDir)
  try {
    return database
      .prepare('SELECT attachment_id, session_id, source, mime_type, size_bytes FROM attachments')
      .all() as Record<string, unknown>[]
  } finally {
    database.close()
  }
}

function restart(host: ProtocolHost, connections: FakeConnectionFactory) {
  return startServer({
    port: 0,
    dataDir: host.dataDir,
    logLevel: 'silent',
    workspaces: [host.workspaceRoot],
    runtimeOptions: {
      connections,
      claudeSdk: new FakeClaudeSdk(),
      health: { schedule: () => ({ cancel() {} }) },
    },
  })
}

describe('artifact metadata', () => {
  it('promotes the session and source of existing rows to columns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-artifact-migrate-'))
    directories.push(directory)
    const before = openEnvironmentDatabase(
      directory,
      MIGRATIONS.filter((migration) => migration.version < 9),
    )
    before.exec(`
      INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
        VALUES ('workspace-1', 'one', '/one', 1, 1), ('workspace-2', 'two', '/two', 1, 1);
      INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
        VALUES ('session-1', 'workspace-1', 'opencode', 'idle', 1, 1);
      INSERT INTO attachments (
        attachment_id, workspace_id, storage_key, name, mime_type, size_bytes, metadata_json, created_at
      ) VALUES
        ('bound', 'workspace-1', 'uploads/bound', 'a.png', 'image/png', 1,
          '{"sessionId":"session-1","source":"prompt"}', 1),
        ('foreign', 'workspace-2', 'uploads/foreign', 'b.png', 'image/png', 1,
          '{"sessionId":"session-1","source":"prompt"}', 1),
        ('orphan', 'workspace-1', 'uploads/orphan', 'c.png', 'image/png', 1,
          '{"sessionId":"session-gone","source":"generated"}', 1);
    `)
    before.close()

    const database = openEnvironmentDatabase(directory)
    try {
      expect(
        database
          .prepare('SELECT attachment_id, session_id, source FROM attachments ORDER BY attachment_id')
          .all(),
      ).toEqual([
        { attachment_id: 'bound', session_id: 'session-1', source: 'prompt' },
        // A session in another workspace, or one that is gone, binds nothing.
        { attachment_id: 'foreign', session_id: null, source: 'prompt' },
        { attachment_id: 'orphan', session_id: null, source: 'generated' },
      ])
      database.prepare('DELETE FROM sessions WHERE session_id = ?').run('session-1')
      expect(
        database.prepare('SELECT attachment_id FROM attachments ORDER BY attachment_id').all(),
      ).toEqual([{ attachment_id: 'foreign' }, { attachment_id: 'orphan' }])
    } finally {
      database.close()
    }
    // The raw file keeps the version this server now expects.
    const raw = new DatabaseSync(join(directory, DATABASE_FILENAME))
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 14 })
    raw.close()
  })

  it('sends an uploaded image by id and still serves it after a restart', async () => {
    const prompts: unknown[] = []
    const connections = new FakeConnectionFactory({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
      newSession: async () => ({ sessionId: 'stub-session' }),
      prompt: async (params) => {
        prompts.push(params)
        return { stopReason: 'end_turn' }
      },
    })
    const host = await startStubHost(connections)
    const { client, sessionId, threadId, subscriptionId } = await openSession(host)
    const artifact = await upload(host, client, sessionId)
    const reference = {
      type: 'artifact',
      artifactId: artifact.artifactId,
      mimeType: 'image/png',
      name: 'screenshot.png',
      sizeBytes: BYTES.byteLength,
    }

    const sendId = client.command('turn.send', {
      sessionId,
      threadId,
      text: 'what is this?',
      // A repeated id is one attachment, not two.
      artifactIds: [artifact.artifactId, artifact.artifactId],
    })
    const sent = ProofResponseSchemas['turn.send'].parse(await nextResponse(client, sendId))
    expect(sent.payload.userMessage.content).toEqual([
      { type: 'text', text: 'what is this?' },
      reference,
    ])
    await collectThreadRecords(client, subscriptionId, (records) =>
      records.some((record) => record.event.name === 'turn.completed'),
    )
    // The provider gets the bytes; the durable message only names them.
    expect(prompts).toHaveLength(1)
    expect((prompts[0] as { prompt: unknown[] }).prompt).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', mimeType: 'image/png', data: BYTES.toString('base64') },
    ])
    expect(attachmentRows(host.dataDir)).toEqual([
      {
        attachment_id: artifact.artifactId,
        session_id: sessionId,
        source: 'prompt',
        mime_type: 'image/png',
        size_bytes: BYTES.byteLength,
      },
    ])

    await host.server.close()
    const restarted = await restart(host, connections)
    try {
      expect(
        restarted.threadService.dispatch({
          type: 'command',
          requestId: 'history-after-restart',
          name: 'session.history',
          payload: { sessionId, threadId },
        }),
      ).toMatchObject({
        payload: {
          messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, reference] }],
        },
      })
      const path = `/artifacts/${sessionId}/${artifact.artifactId}`
      const bytes = await get(restarted.url, path, host.token)
      expect(bytes.status).toBe(200)
      expect(bytes.headers.get('content-type')).toBe('image/png')
      expect(bytes.headers.get('x-content-type-options')).toBe('nosniff')
      // Every read presents a credential; nothing answers from a browser cache.
      expect(bytes.headers.get('cache-control')).toBe('no-store')
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(BYTES)
      const metadata = await get(restarted.url, `${path}/metadata`, host.token)
      expect(metadata.headers.get('cache-control')).toBe('no-store')
      expect(await metadata.json()).toMatchObject({
        artifactId: artifact.artifactId,
        sessionId,
        mimeType: 'image/png',
        sizeBytes: BYTES.byteLength,
        source: 'prompt',
      })
    } finally {
      await restarted.close()
    }
  })

  it('starts a turn from an image alone, with no empty text beside it', async () => {
    const prompts: unknown[] = []
    const connections = new FakeConnectionFactory({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
      newSession: async () => ({ sessionId: 'stub-session' }),
      prompt: async (params) => {
        prompts.push(params)
        return { stopReason: 'end_turn' }
      },
    })
    const host = await startStubHost(connections)
    const { client, sessionId, threadId, subscriptionId } = await openSession(host)
    const artifact = await upload(host, client, sessionId)

    // Nothing at all is refused before the environment looks anything up.
    const emptyId = client.command('turn.send', { sessionId, threadId, text: '' })
    expect(await nextResponse(client, emptyId)).toMatchObject({
      type: 'error',
      error: { code: 'validation' },
    })

    const sendId = client.command('turn.send', {
      sessionId,
      threadId,
      text: '',
      artifactIds: [artifact.artifactId],
    })
    const sent = ProofResponseSchemas['turn.send'].parse(await nextResponse(client, sendId))
    expect(sent.payload.userMessage.content).toEqual([
      expect.objectContaining({ type: 'artifact', artifactId: artifact.artifactId }),
    ])
    await collectThreadRecords(client, subscriptionId, (records) =>
      records.some((record) => record.event.name === 'turn.completed'),
    )
    expect((prompts[0] as { prompt: unknown[] }).prompt).toEqual([
      { type: 'image', mimeType: 'image/png', data: BYTES.toString('base64') },
    ])
    await host.server.close()
  })

  it('launches a draft with the images it uploaded for its workspace', async () => {
    const prompts: unknown[] = []
    const connections = new FakeConnectionFactory({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
      newSession: async () => ({ sessionId: 'stub-session' }),
      prompt: async (params) => {
        prompts.push(params)
        return { stopReason: 'end_turn' }
      },
    })
    const host = await startStubHost(connections)
    const client = await connectProtocol(host)
    await handshake(client)

    // A ticket for a workspace this environment does not know is refused.
    const unknownId = client.command('upload.ticket.create', {
      workspaceId: 'workspace-unknown',
      name: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: BYTES.byteLength,
    })
    expect(await nextResponse(client, unknownId)).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })

    // No session yet: the image is held for the workspace.
    const artifact = await upload(host, client, { workspaceId: host.workspaceId })
    expect(artifact).not.toHaveProperty('sessionId')
    expect(artifact.workspaceId).toBe(host.workspaceId)
    expect(attachmentRows(host.dataDir)).toEqual([
      expect.objectContaining({ attachment_id: artifact.artifactId, session_id: null }),
    ])

    const createId = client.command('session.create', {
      environmentId: host.server.identity.environmentId,
      providerId: 'opencode',
      workspaceId: host.workspaceId,
      firstMessage: '',
      artifactIds: [artifact.artifactId],
    })
    const created = ProofResponseSchemas['session.create'].parse(
      await nextResponse(client, createId),
    ).payload
    expect(created.firstTurn?.userMessage.content).toEqual([
      expect.objectContaining({ type: 'artifact', artifactId: artifact.artifactId }),
    ])
    expect(attachmentRows(host.dataDir)).toEqual([
      expect.objectContaining({
        attachment_id: artifact.artifactId,
        session_id: created.session.sessionId,
      }),
    ])
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    expect((prompts[0] as { prompt: unknown[] }).prompt).toEqual([
      { type: 'image', mimeType: 'image/png', data: BYTES.toString('base64') },
    ])
    // Now the session's own artifact, read back through its route.
    const bytes = await get(
      host.server.url,
      `/artifacts/${created.session.sessionId}/${artifact.artifactId}`,
      host.token,
    )
    expect(bytes.status).toBe(200)

    // Claimed once: launching again with it is refused and leaves no session.
    const againId = client.command('session.create', {
      environmentId: host.server.identity.environmentId,
      providerId: 'opencode',
      workspaceId: host.workspaceId,
      firstMessage: 'again',
      artifactIds: [artifact.artifactId],
    })
    expect(await nextResponse(client, againId)).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    const listId = client.command('session.list', {})
    expect(
      ProofResponseSchemas['session.list'].parse(await nextResponse(client, listId)).payload
        .sessions,
    ).toHaveLength(1)
    await host.server.close()
  })

  it('stores a generated image like an upload and keeps its bytes out of the event log', async () => {
    const data = GENERATED.toString('base64')
    const connections: FakeConnectionFactory = new FakeConnectionFactory({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
      newSession: async () => ({ sessionId: 'stub-session' }),
      prompt: async (params) => {
        await connections.last.sessionUpdate({
          sessionId: promptSessionId(params),
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', mimeType: 'image/png', data },
          },
        })
        return { stopReason: 'end_turn' }
      },
    })
    const host = await startStubHost(connections)
    const { client, sessionId, threadId, subscriptionId } = await openSession(host)
    const sendId = client.command('turn.send', { sessionId, threadId, text: 'draw something' })
    await nextResponse(client, sendId)
    const records = await collectThreadRecords(client, subscriptionId, (seen) =>
      seen.some((record) => record.event.name === 'turn.completed'),
    )

    const [row] = attachmentRows(host.dataDir)
    expect(row).toMatchObject({
      session_id: sessionId,
      source: 'generated',
      mime_type: 'image/png',
      size_bytes: GENERATED.byteLength,
    })
    const artifactId = row!.attachment_id as string
    const delta = records.find((record) => record.event.name === 'message.delta')
    expect(delta?.event.payload).toMatchObject({
      role: 'assistant',
      content: { type: 'artifact', artifactId, mimeType: 'image/png' },
    })
    expect(JSON.stringify(records)).not.toContain(data)
    expect(await readFile(join(host.dataDir, 'uploads', artifactId))).toEqual(GENERATED)

    await host.server.close()
    const restarted = await restart(host, connections)
    try {
      expect(
        restarted.threadService.dispatch({
          type: 'command',
          requestId: 'history-after-restart',
          name: 'session.history',
          payload: { sessionId, threadId },
        }),
      ).toMatchObject({
        payload: {
          messages: [
            { role: 'user' },
            { role: 'assistant', content: [{ type: 'artifact', artifactId }] },
          ],
        },
      })
      const bytes = await get(restarted.url, `/artifacts/${sessionId}/${artifactId}`, host.token)
      expect(bytes.status).toBe(200)
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(GENERATED)
    } finally {
      await restarted.close()
    }
  })

  it('stores an image a tool returns once, however often the provider repeats it', async () => {
    const data = GENERATED.toString('base64')
    const content = [
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data } },
    ] as const
    const connections: FakeConnectionFactory = new FakeConnectionFactory({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
      newSession: async () => ({ sessionId: 'stub-session' }),
      prompt: async (params) => {
        const sessionId = promptSessionId(params)
        await connections.last.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Render chart',
            kind: 'other',
            status: 'in_progress',
            content: [...content],
          },
        })
        // Providers resend a tool's whole content with every update.
        await connections.last.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            content: [...content],
          },
        })
        return { stopReason: 'end_turn' }
      },
    })
    const host = await startStubHost(connections)
    const { client, sessionId, threadId, subscriptionId } = await openSession(host)
    const sendId = client.command('turn.send', { sessionId, threadId, text: 'chart it' })
    await nextResponse(client, sendId)
    const records = await collectThreadRecords(client, subscriptionId, (seen) =>
      seen.some((record) => record.event.name === 'turn.completed'),
    )

    const rows = attachmentRows(host.dataDir)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ session_id: sessionId, source: 'generated' })
    const artifactId = rows[0]!.attachment_id as string
    expect(
      records
        .filter((record) => record.event.name === 'message.delta')
        .map((record) => record.event.payload),
    ).toMatchObject([{ role: 'assistant', content: { type: 'artifact', artifactId } }])
    expect(JSON.stringify(records)).not.toContain(data)
    // The result is filed after the tool call that produced it, so a transcript
    // in arrival order shows the work before the image.
    const names = records.map((record) => record.event.name)
    expect(names.indexOf('tool.updated')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('tool.updated')).toBeLessThan(names.indexOf('message.delta'))

    await host.server.close()
    const restarted = await restart(host, connections)
    try {
      const bytes = await get(restarted.url, `/artifacts/${sessionId}/${artifactId}`, host.token)
      expect(bytes.status).toBe(200)
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(GENERATED)
    } finally {
      await restarted.close()
    }
  })

  it('refuses artifacts the caller cannot name', async () => {
    const connections = new FakeConnectionFactory({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
      newSession: async () => ({ sessionId: 'stub-session' }),
      prompt: async () => ({ stopReason: 'end_turn' }),
    })
    const host = await startStubHost(connections)
    const first = await openSession(host)
    const second = await openSession(host)
    const artifact = await upload(host, first.client, first.sessionId)

    // An artifact belongs to the session it was uploaded to.
    const sendId = second.client.command('turn.send', {
      sessionId: second.sessionId,
      threadId: second.threadId,
      text: 'borrowed',
      artifactIds: [artifact.artifactId],
    })
    expect(await nextResponse(second.client, sendId)).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })

    const path = `/artifacts/${first.sessionId}/${artifact.artifactId}`
    const anonymous = await get(host.server.url, path)
    expect(anonymous.status).toBe(401)
    // A refusal must never be what a client keeps as the image.
    expect(anonymous.headers.get('cache-control')).toBe('no-store')
    expect((await get(host.server.url, path, 'not-a-credential')).status).toBe(401)
    expect(
      (await get(host.server.url, `/artifacts/${second.sessionId}/${artifact.artifactId}`, host.token))
        .status,
    ).toBe(404)
    expect(
      (await get(host.server.url, `/artifacts/${first.sessionId}/..%2F..%2Fidentity.json`, host.token))
        .status,
    ).toBe(404)
    expect((await get(host.server.url, path, host.token)).status).toBe(200)
  })
})
