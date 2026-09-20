import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  ProofResponseSchemas,
  UploadResponseSchemas,
  UploadResultSchema,
  type ServerMessage,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { MAX_ATTACHMENT_BYTES } from '../src/upload-limits.js'
import { createUploadService } from '../src/uploads.js'
import { createAuditLog } from '../src/audit.js'
import { createRateLimiter } from '../src/rate-limit.js'
import {
  cleanupProtocolHosts,
  connectProtocol,
  handshake,
  nextResponse,
  type ProtocolClient,
  type ProtocolHost,
} from './helpers/protocol-client.js'
import { startStubHost } from './helpers/proof-slice.js'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupProtocolHosts()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const BYTES = Buffer.from('not really a png, but bytes all the same')

function stubConnections() {
  return new FakeConnectionFactory({
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    newSession: async () => ({ sessionId: 'stub-session' }),
    prompt: async () => ({ stopReason: 'end_turn' }),
  })
}

async function hostWithSession() {
  const host = await startStubHost(stubConnections())
  const client = await connectProtocol(host)
  await handshake(client)
  const createId = client.command('session.create', {
    environmentId: host.server.identity.environmentId,
    providerId: 'opencode',
    workspaceId: host.workspaceId,
  })
  const created = ProofResponseSchemas['session.create'].parse(await nextResponse(client, createId))
  return { host, client, sessionId: created.payload.session.sessionId }
}

async function requestTicket(
  client: ProtocolClient,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<ServerMessage> {
  const requestId = client.command('upload.ticket.create', {
    sessionId,
    name: 'screenshot.png',
    mimeType: 'image/png',
    sizeBytes: BYTES.byteLength,
    ...overrides,
  })
  return nextResponse(client, requestId)
}

async function ticketFor(client: ProtocolClient, sessionId: string) {
  return UploadResponseSchemas['upload.ticket.create'].parse(await requestTicket(client, sessionId))
    .payload
}

function put(
  host: ProtocolHost,
  path: string,
  body: Buffer,
  token: string | undefined = host.token,
) {
  return fetch(`${host.server.url}${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  })
}

const blobs = async (host: ProtocolHost) =>
  (await readdir(join(host.dataDir, 'uploads'))).filter((entry) => entry !== 'partial')
const partials = (host: ProtocolHost) => readdir(join(host.dataDir, 'uploads', 'partial'))

function attachmentRows(host: ProtocolHost) {
  const database = openEnvironmentDatabase(host.dataDir)
  try {
    return database.prepare('SELECT * FROM attachments').all() as Record<string, unknown>[]
  } finally {
    database.close()
  }
}

const rejections = (host: ProtocolHost) =>
  host.server.audit.query({ type: 'upload.rejected' }).map((event) => event.details.reason)

describe('upload tickets', () => {
  it('advertises the capability', async () => {
    const { host } = await hostWithSession()
    const bootstrap = (await (await fetch(`${host.server.url}/bootstrap`)).json()) as {
      capabilities: string[]
    }
    expect(bootstrap.capabilities).toContain('upload.ticket.create')
  })

  it('trades a ticket and the bytes for an artifact id', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    expect(ticket.uploadPath).toBe(`/uploads/${ticket.ticket}`)
    expect(ticket.maxBytes).toBe(BYTES.byteLength)
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now())

    const response = await put(host, ticket.uploadPath, BYTES)
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result = UploadResultSchema.parse(await response.json())
    expect(result).toMatchObject({
      sessionId,
      name: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: BYTES.byteLength,
    })

    expect(await blobs(host)).toEqual([result.artifactId])
    expect(await partials(host)).toEqual([])
    expect(await readFile(join(host.dataDir, 'uploads', result.artifactId))).toEqual(BYTES)
    const [row] = attachmentRows(host)
    expect(row).toMatchObject({
      attachment_id: result.artifactId,
      workspace_id: host.workspaceId,
      message_id: null,
      uploaded_by_client_id: host.server.owner.clientId,
      storage_key: `uploads/${result.artifactId}`,
      name: 'screenshot.png',
      mime_type: 'image/png',
      size_bytes: BYTES.byteLength,
    })
    expect(JSON.parse(row!.metadata_json as string)).toEqual({ sessionId, source: 'prompt' })
    expect(host.server.uploads.pendingTicketCount).toBe(0)
  })

  it('never lets the client name reach the filesystem', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = UploadResponseSchemas['upload.ticket.create'].parse(
      await requestTicket(client, sessionId, { name: '..\\..\\evil/../../name.png' }),
    ).payload
    const result = UploadResultSchema.parse(
      await (await put(host, ticket.uploadPath, BYTES)).json(),
    )
    expect(await blobs(host)).toEqual([result.artifactId])
    expect(result.artifactId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it.each(['owner', 'paired'] as const)(
    'enforces the type and size policy for %s clients',
    async (kind) => {
      const { host, client: owner, sessionId } = await hostWithSession()
      const credential =
        kind === 'owner'
          ? host.token
          : host.server.clients.issue({
              label: 'Remote',
              kind: 'paired',
              capabilities: ['read', 'operate'],
            }).credential
      const client =
        kind === 'owner' ? owner : await connectProtocol({ ...host, token: credential })
      if (kind === 'paired') await handshake(client)
      for (const mimeType of [
        'image/svg+xml',
        'text/html',
        'application/octet-stream',
        'image/gif',
      ]) {
        expect(await requestTicket(client, sessionId, { mimeType })).toMatchObject({
          type: 'error',
          error: { code: 'validation' },
        })
      }
      expect(
        await requestTicket(client, sessionId, { sizeBytes: MAX_ATTACHMENT_BYTES + 1 }),
      ).toMatchObject({ type: 'error', error: { code: 'validation' } })
      expect(host.server.uploads.pendingTicketCount).toBe(0)
      expect(await blobs(host)).toEqual([])
      expect(await partials(host)).toEqual([])
      expect(attachmentRows(host)).toEqual([])
      expect(rejections(host).filter((reason) => reason === 'unsupported_type')).toHaveLength(4)
      for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'IMAGE/PNG']) {
        const ticket = UploadResponseSchemas['upload.ticket.create'].parse(
          await requestTicket(client, sessionId, { mimeType }),
        ).payload
        const response = await put(host, ticket.uploadPath, BYTES, credential)
        expect(response.status).toBe(201)
        expect(await response.json()).toMatchObject({ mimeType: mimeType.toLowerCase() })
      }
      expect(attachmentRows(host).map((row) => row.mime_type)).toEqual([
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/png',
      ])
    },
  )

  it('rejects destination paths instead of treating them as upload options', async () => {
    const { host, client, sessionId } = await hostWithSession()
    expect(await requestTicket(client, sessionId, { path: '../../outside.png' })).toMatchObject({
      type: 'error',
      error: { code: 'validation' },
    })
    expect(host.server.uploads.pendingTicketCount).toBe(0)
    expect(await blobs(host)).toEqual([])
  })

  it('requires an available workspace at ticket creation and at PUT time', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    // The helper creates an empty workspace; removing it makes registry resolution fail.
    await rmdir(host.workspaceRoot)
    expect(await requestTicket(client, sessionId)).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    const response = await put(host, ticket.uploadPath, BYTES)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
    expect(await blobs(host)).toEqual([])
    expect(await partials(host)).toEqual([])
    expect(attachmentRows(host)).toEqual([])
  })

  it('removes bytes from an oversized chunked transfer without Content-Length', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${host.server.url}${ticket.uploadPath}`,
          {
            method: 'PUT',
            headers: { authorization: `Bearer ${host.token}` },
          },
          (response) => {
            let body = ''
            response.on('data', (chunk) => {
              body += String(chunk)
            })
            response.on('end', () => resolve({ status: response.statusCode, body }))
          },
        )
        request.on('error', reject)
        request.write(BYTES)
        request.end(BYTES)
      },
    )
    expect(response.status).toBe(413)
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'validation' } })
    await expect.poll(() => partials(host)).toEqual([])
    expect(await blobs(host)).toEqual([])
    expect(attachmentRows(host)).toEqual([])
  })

  it('refuses a reused ticket', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    expect((await put(host, ticket.uploadPath, BYTES)).status).toBe(201)

    const again = await put(host, ticket.uploadPath, BYTES)
    expect(again.status).toBe(404)
    expect(await again.json()).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(await blobs(host)).toHaveLength(1)
    expect(rejections(host)).toContain('unknown_ticket')
  })

  it('spends the ticket on a failed transfer too', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const short = await put(host, ticket.uploadPath, BYTES.subarray(0, 4))
    expect(short.status).toBe(400)
    expect((await put(host, ticket.uploadPath, BYTES)).status).toBe(404)
    expect(await blobs(host)).toEqual([])
    expect(await partials(host)).toEqual([])
    expect(attachmentRows(host)).toEqual([])
  })

  it('refuses an unknown ticket and a missing credential', async () => {
    const { host, client, sessionId } = await hostWithSession()
    expect((await put(host, '/uploads/made-up', BYTES)).status).toBe(404)

    const ticket = await ticketFor(client, sessionId)
    const anonymous = await put(host, ticket.uploadPath, BYTES, '')
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ error: { code: 'auth' } })
    // The refusal did not spend the ticket: its owner can still use it.
    expect((await put(host, ticket.uploadPath, BYTES)).status).toBe(201)
  })

  it("refuses another client's ticket without spending it", async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const phone = host.server.clients.issue({
      label: 'Phone',
      kind: 'paired',
      capabilities: ['read', 'operate'],
    })
    const stolen = await put(host, ticket.uploadPath, BYTES, phone.credential)
    expect(stolen.status).toBe(404)
    expect(rejections(host)).toContain('foreign_ticket')
    expect(await blobs(host)).toEqual([])
    expect((await put(host, ticket.uploadPath, BYTES)).status).toBe(201)
  })

  it('ends a revoked client’s tickets with its credential', async () => {
    const { host, sessionId } = await hostWithSession()
    const phone = host.server.clients.issue({
      label: 'Phone',
      kind: 'paired',
      capabilities: ['read', 'operate'],
    })
    const phoneClient = await connectProtocol({ ...host, token: phone.credential })
    await handshake(phoneClient)
    const ticket = await ticketFor(phoneClient, sessionId)
    expect(host.server.revokeClient(phone.client.clientId)).toBe(true)
    expect(host.server.uploads.pendingTicketCount).toBe(0)
    expect((await put(host, ticket.uploadPath, BYTES, phone.credential)).status).toBe(401)
    expect(await blobs(host)).toEqual([])
  })

  it('cuts a revoked client’s transfer that is already under way', async () => {
    const { host, sessionId } = await hostWithSession()
    const phone = host.server.clients.issue({
      label: 'Phone',
      kind: 'paired',
      capabilities: ['read', 'operate'],
    })
    const phoneClient = await connectProtocol({ ...host, token: phone.credential })
    await handshake(phoneClient)
    const ticket = await ticketFor(phoneClient, sessionId)
    const request = httpRequest(`${host.server.url}${ticket.uploadPath}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${phone.credential}`, 'content-length': BYTES.byteLength },
    })
    request.on('error', () => {})
    request.write(BYTES.subarray(0, 8))
    await expect.poll(() => partials(host)).toHaveLength(1)
    expect(host.server.revokeClient(phone.client.clientId)).toBe(true)

    await expect.poll(() => partials(host)).toEqual([])
    expect(rejections(host)).toContain('revoked')
    expect(await blobs(host)).toEqual([])
    expect(attachmentRows(host)).toEqual([])
  })

  it('keeps nothing when the session is deleted while the bytes arrive', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const request = httpRequest(`${host.server.url}${ticket.uploadPath}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${host.token}`, 'content-length': BYTES.byteLength },
    })
    const status = new Promise<number | undefined>((resolve, reject) => {
      request.on('response', (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', reject)
    })
    request.write(BYTES.subarray(0, 8))
    await expect.poll(() => partials(host)).toHaveLength(1)
    await nextResponse(client, client.command('session.delete', { sessionId }))
    request.end(BYTES.subarray(8))

    expect(await status).toBe(404)
    expect(rejections(host)).toContain('session_gone')
    await expect.poll(() => partials(host)).toEqual([])
    expect(await blobs(host)).toEqual([])
    expect(attachmentRows(host)).toEqual([])
  })

  it('requires the operate capability for a ticket', async () => {
    const { host, sessionId } = await hostWithSession()
    const watcher = host.server.clients.issue({
      label: 'Watcher',
      kind: 'paired',
      capabilities: ['read'],
    })
    const watcherClient = await connectProtocol({ ...host, token: watcher.credential })
    await handshake(watcherClient)
    expect(await requestTicket(watcherClient, sessionId)).toMatchObject({
      type: 'error',
      error: { code: 'capability_missing', details: { requiredCapability: 'operate' } },
    })
  })

  it('refuses a ticket for an unknown session or an oversized file', async () => {
    const { host, client, sessionId } = await hostWithSession()
    expect(await requestTicket(client, 'no-such-session')).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
    expect(
      await requestTicket(client, sessionId, { sizeBytes: MAX_ATTACHMENT_BYTES + 1 }),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(await requestTicket(client, sessionId, { mimeType: 'not a type' })).toMatchObject({
      type: 'error',
      error: { code: 'validation' },
    })
    expect(rejections(host)).toContain('oversized')
    expect(host.server.uploads.pendingTicketCount).toBe(0)
  })

  it('keeps nothing from a body larger than the ticket allows', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const response = await put(host, ticket.uploadPath, Buffer.concat([BYTES, BYTES]))
    expect(response.status).toBe(413)
    expect(await blobs(host)).toEqual([])
    expect(await partials(host)).toEqual([])
    expect(attachmentRows(host)).toEqual([])
  })

  it('removes the partial file of an interrupted transfer', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const request = httpRequest(`${host.server.url}${ticket.uploadPath}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${host.token}`,
        'content-length': BYTES.byteLength,
      },
    })
    request.on('error', () => {})
    request.write(BYTES.subarray(0, 8))
    await expect.poll(() => partials(host)).toHaveLength(1)
    request.destroy()

    await expect.poll(() => partials(host)).toEqual([])
    await expect.poll(() => rejections(host)).toContain('interrupted')
    expect(await blobs(host)).toEqual([])
    expect(attachmentRows(host)).toEqual([])
    // The interrupted transfer spent the ticket.
    expect((await put(host, ticket.uploadPath, BYTES)).status).toBe(404)
  })

  it('cuts an in-flight transfer on shutdown', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const request = httpRequest(`${host.server.url}${ticket.uploadPath}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${host.token}`, 'content-length': BYTES.byteLength },
    })
    request.on('error', () => {})
    request.write(BYTES.subarray(0, 8))
    await expect.poll(() => partials(host)).toHaveLength(1)
    await host.server.close()
    await expect.poll(() => partials(host)).toEqual([])
  })

  it('answers the browser preflight and refuses other methods', async () => {
    const { host } = await hostWithSession()
    const preflight = await fetch(`${host.server.url}/uploads/anything`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toBe('PUT')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    const get = await fetch(`${host.server.url}/uploads/anything`)
    expect(get.status).toBe(405)
  })
})

describe('upload service', () => {
  async function isolatedService(now: { value: number }) {
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-upload-test-'))
    directories.push(dataDir)
    const database = openEnvironmentDatabase(dataDir)
    const log = () => undefined
    const create = () =>
      createUploadService({
        dataDir,
        database,
        audit: createAuditLog(log),
        log,
        rateLimiter: createRateLimiter(),
        authenticate: () => undefined,
        sessionWorkspace: () => 'workspace-1',
        resolveWorkspace: () => ({}),
        clock: () => now.value,
      })
    return { dataDir, database, create }
  }

  const ticketCommand = (requestId: string) => ({
    type: 'command' as const,
    requestId,
    name: 'upload.ticket.create',
    payload: { sessionId: 'session-1', name: 'a.png', mimeType: 'image/png', sizeBytes: 4 },
  })
  const context = { clientId: 'client-1', command: 'upload.ticket.create' }

  it('sweeps partial files and unrecorded blobs left by a previous process', async () => {
    const now = { value: 1_000 }
    const { dataDir, database, create } = await isolatedService(now)
    const partial = join(dataDir, 'uploads', 'partial')
    await mkdir(partial, { recursive: true })
    await writeFile(join(partial, 'left-behind'), 'half a file')
    await writeFile(join(dataDir, 'uploads', 'finished'), 'a whole file')
    create()
    expect(await readdir(partial)).toEqual([])
    // A crash between the rename and the insert leaves a blob no row names.
    expect(await readdir(join(dataDir, 'uploads'))).toEqual(['partial'])
    database.close()
  })

  it('keeps the blobs a row names when it sweeps', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const stored = UploadResultSchema.parse(
      await (await put(host, ticket.uploadPath, BYTES)).json(),
    )
    await writeFile(join(host.dataDir, 'uploads', 'unrecorded'), 'a whole file')
    const database = openEnvironmentDatabase(host.dataDir)
    const log = () => undefined
    createUploadService({
      dataDir: host.dataDir,
      database,
      audit: createAuditLog(log),
      log,
      rateLimiter: createRateLimiter(),
      authenticate: () => undefined,
      sessionWorkspace: () => undefined,
      resolveWorkspace: () => undefined,
    })
    database.close()
    expect(await blobs(host)).toEqual([stored.artifactId])
  })

  it('forgets expired tickets and bounds the ones a client can hold', async () => {
    const now = { value: 1_000 }
    const { database, create } = await isolatedService(now)
    const service = create()
    for (let index = 0; index < 32; index += 1) {
      expect(service.dispatch(ticketCommand(`req-${index}`), context)).toMatchObject({
        type: 'response',
      })
    }
    expect(service.dispatch(ticketCommand('req-over'), context)).toMatchObject({
      type: 'error',
      error: { code: 'unavailable' },
    })
    expect(service.pendingTicketCount).toBe(32)
    now.value += 2 * 60_000
    expect(service.pendingTicketCount).toBe(0)
    expect(service.dispatch(ticketCommand('req-later'), context)).toMatchObject({
      type: 'response',
    })
    database.close()
  })
})

describe('expired upload tickets', () => {
  it('refuses the bytes', async () => {
    const { host, client, sessionId } = await hostWithSession()
    const ticket = await ticketFor(client, sessionId)
    const issuedAt = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => issuedAt + 2 * 60_000 + 1)
    const response = await put(host, ticket.uploadPath, BYTES)
    vi.restoreAllMocks()
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
    expect(rejections(host)).toContain('expired_ticket')
    expect(await blobs(host)).toEqual([])
    expect((await put(host, ticket.uploadPath, BYTES)).status).toBe(404)
  })
})
