import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, type ClientOptions } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AccessDeniedErrorSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ServerMessage,
} from '@openmanager/protocol/node'
import { containsSecret } from '../src/redact.js'
import { startServer } from '../src/server.js'
import { isOversizedUpload, MAX_ATTACHMENT_BYTES } from '../src/upload-limits.js'
import { REVOKED_CLOSE_CODE, REVOKED_CLOSE_REASON } from '../src/websocket.js'

/**
 * Negative tests assert the *security* rejection, not that something failed.
 * A 500, a missing route, or a generic internal error is the wrong reason:
 * the test must fail so a removed or broken check cannot hide behind it.
 */
function expectClosedFor(
  reason: string,
  actual: { status?: number; code?: string },
  expected: { status: number; code: string },
) {
  expect(
    actual.status,
    `${reason} must fail with HTTP ${expected.status}, not ${actual.status} (crash, missing route, or a different check)`,
  ).toBe(expected.status)
  expect(
    actual.code,
    `${reason} must fail with error code ${expected.code}, not ${actual.code}`,
  ).toBe(expected.code)
  expect(actual.code, `${reason} must not fail as a generic internal error`).not.toBe('internal')
}

const directories: string[] = []
const servers: Awaited<ReturnType<typeof startServer>>[] = []
const clients: WebSocket[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.terminate()
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-security-test-'))
  directories.push(dataDir)
  const workspace = join(dataDir, 'workspace')
  await mkdir(join(workspace, 'src'), { recursive: true })
  const stderr: string[] = []
  vi.spyOn(console, 'error').mockImplementation((line) => {
    stderr.push(String(line))
  })
  const server = await startServer({
    port: 0,
    dataDir,
    logLevel: 'warn',
    allowedOrigins: ['http://localhost:5173'],
    workspaces: [workspace],
  })
  servers.push(server)
  const token = (await readFile(join(dataDir, 'owner-credential'), 'utf8')).trim()
  return {
    server,
    token,
    dataDir,
    stderr,
    url: `${server.url.replace('http:', 'ws:')}/ws`,
    workspaceId: server.workspaces.list()[0]!.workspaceId,
  }
}

async function rejection(url: string, options: ClientOptions = {}) {
  const ws = new WebSocket(url, options)
  clients.push(ws)
  ws.on('error', () => {})
  return new Promise<{ status: number | undefined; body: { error?: { code?: string } } }>(
    (resolve, reject) => {
      ws.once('open', () => reject(new Error('Unexpected successful upgrade')))
      ws.once('unexpected-response', async (_request, response) => {
        let body = ''
        for await (const chunk of response) body += String(chunk)
        ws.terminate()
        resolve({ status: response.statusCode, body: JSON.parse(body) })
      })
    },
  )
}

async function connect(url: string, credential: string) {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } })
  clients.push(ws)
  const queue: ServerMessage[] = []
  let waiter: ((message: ServerMessage) => void) | undefined
  ws.on('message', (data) => {
    const message = ServerMessageSchema.parse(JSON.parse(data.toString()))
    if (waiter) {
      const resolve = waiter
      waiter = undefined
      resolve(message)
    } else queue.push(message)
  })
  ws.on('error', () => {})
  await once(ws, 'open')
  let id = 0
  return {
    ws,
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift()!)
        : new Promise<ServerMessage>((resolve) => {
            waiter = resolve
          }),
    command(name: string, payload: unknown, requestId = `req-${++id}`) {
      ws.send(JSON.stringify({ type: 'command', requestId, name, payload }))
      return requestId
    },
  }
}

describe('negative security tests', () => {
  it('rejects unauthenticated socket upgrades as auth, not as a missing route or crash', async () => {
    const host = await setup()
    const denied = await rejection(host.url)
    expectClosedFor(
      'unauthenticated WebSocket',
      {
        status: denied.status,
        code: denied.body.error?.code,
      },
      { status: 401, code: 'auth' },
    )
    expect(host.server.sockets.connectionCount).toBe(0)

    const events = host.server.audit.query({ type: 'auth.failed' })
    expect(events, 'unauthenticated upgrade must write an auth.failed audit row').not.toHaveLength(
      0,
    )
    expect(events[0]).toMatchObject({
      command: 'ws.upgrade',
      outcome: 'failed',
      details: { presented: false },
    })
    expect(containsSecret(events)).toBe(false)
  })

  it('rejects a revoked credential as auth and cuts the live socket for that reason', async () => {
    const host = await setup()
    const phone = host.server.clients.issue({
      label: 'Phone',
      kind: 'paired',
      capabilities: ['read'],
    })
    const client = await connect(host.url, phone.credential)
    const handshakeId = client.command('protocol.handshake', {
      protocolVersion: PROTOCOL_VERSION,
      requiredCapabilities: ['connection.heartbeat'],
    })
    expect(await client.next()).toMatchObject({ type: 'response', requestId: handshakeId })

    const closed = once(client.ws, 'close')
    expect(host.server.revokeClient(phone.client.clientId)).toBe(true)
    const [code, reason] = await closed
    expect(code, 'revocation must close with 4401, not a generic 1006/1008').toBe(
      REVOKED_CLOSE_CODE,
    )
    expect(String(reason)).toBe(REVOKED_CLOSE_REASON)

    const replay = await rejection(host.url, {
      headers: { authorization: `Bearer ${phone.credential}` },
    })
    expectClosedFor(
      'revoked credential reuse',
      {
        status: replay.status,
        code: replay.body.error?.code,
      },
      { status: 401, code: 'auth' },
    )

    const revoked = host.server.audit.query({
      type: 'token.revoked',
      clientId: phone.client.clientId,
    })
    expect(revoked).toMatchObject([
      { command: 'client.revoke', outcome: 'revoked', clientId: phone.client.clientId },
    ])
    expect(
      host.server.audit
        .query({ type: 'auth.failed' })
        .some((event) => event.command === 'ws.upgrade'),
    ).toBe(true)
    expect(containsSecret(host.server.audit.query())).toBe(false)
    expect(containsSecret(phone.credential) && containsSecret(host.stderr.join('\n'))).toBe(false)
  })

  it('rejects origin mismatch as 403 auth, not as an unauthenticated 401', async () => {
    const host = await setup()
    const denied = await rejection(host.url, {
      origin: 'https://attacker.example',
      headers: { authorization: `Bearer ${host.token}` },
    })
    expectClosedFor(
      'origin mismatch',
      {
        status: denied.status,
        code: denied.body.error?.code,
      },
      { status: 403, code: 'auth' },
    )
    expect(denied.body.error).toMatchObject({ message: 'Origin is not allowed.' })

    const events = host.server.audit.query({ type: 'origin.rejected' })
    expect(events).toMatchObject([
      {
        command: 'GET /ws',
        outcome: 'rejected',
        details: { origin: 'https://attacker.example' },
      },
    ])
  })

  it('rejects path traversal because it escaped the workspace, not because the file is missing', async () => {
    const host = await setup()
    const context = { clientId: host.server.owner.clientId, command: 'file.read' }
    const missingEscape = join('..', 'does-not-exist', 'secret.txt')
    const result = host.server.workspaces.resolvePath(host.workspaceId, missingEscape, context)
    expect(result.ok, 'an escape must be refused even when the target does not exist').toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(
      result.reason,
      'path traversal must fail as escape, not unknown_workspace or a missing-file miss',
    ).toBe('escape')

    const events = host.server.audit.query({
      type: 'path.rejected',
      clientId: host.server.owner.clientId,
    })
    expect(events).toMatchObject([
      {
        command: 'file.read',
        outcome: 'rejected',
        details: { path: missingEscape, reason: 'escape' },
      },
    ])
  })

  it('rejects commands outside the grant with capability_missing and a capability.denied audit', async () => {
    const host = await setup()
    const prompt = vi.spyOn(host.server.runtime, 'prompt')
    const watcher = host.server.clients.issue({
      label: 'Watcher',
      kind: 'paired',
      capabilities: ['read'],
    })
    const client = await connect(host.url, watcher.credential)
    const handshakeId = client.command('protocol.handshake', {
      protocolVersion: PROTOCOL_VERSION,
      requiredCapabilities: ['connection.heartbeat'],
    })
    expect(await client.next()).toMatchObject({ type: 'response', requestId: handshakeId })

    const requestId = client.command('turn.send', {
      sessionId: 's',
      threadId: 't',
      text: 'hi',
    })
    const denied = AccessDeniedErrorSchema.parse(await client.next())
    expect(denied.requestId).toBe(requestId)
    expect(
      denied.error.code,
      'missing capability must be capability_missing, not a generic 500 or validation miss',
    ).toBe('capability_missing')
    expect(denied.error.details.requiredCapability).toBe('agent')
    expect(prompt).not.toHaveBeenCalled()

    const events = host.server.audit.query({
      type: 'capability.denied',
      clientId: watcher.client.clientId,
    })
    expect(events).toMatchObject([
      {
        command: 'turn.send',
        outcome: 'denied',
        details: { requiredCapability: 'agent' },
      },
    ])
  })

  it.each(['session.rename', 'session.delete'])(
    'rejects %s for a read-only client',
    async (name) => {
      const host = await setup()
      const watcher = host.server.clients.issue({
        label: 'Watcher',
        kind: 'paired',
        capabilities: ['read'],
      })
      const client = await connect(host.url, watcher.credential)
      client.command('protocol.handshake', {
        protocolVersion: PROTOCOL_VERSION,
        requiredCapabilities: [],
      })
      await client.next()
      const requestId = client.command(name, {
        sessionId: 's',
        ...(name === 'session.rename' ? { title: 'Name' } : {}),
      })
      expect(await client.next()).toMatchObject({
        type: 'error',
        requestId,
        error: { code: 'capability_missing', details: { requiredCapability: 'operate' } },
      })
    },
  )

  it('keeps owner token issuance queryable in SQLite and writes no secrets to audit or logs', async () => {
    const host = await setup()
    const issued = host.server.audit.query({ type: 'token.issued' })
    expect(issued.some((event) => event.clientId === host.server.owner.clientId)).toBe(true)
    expect(issued[0]).toMatchObject({
      command: 'client.issue',
      outcome: 'issued',
      details: { kind: 'owner' },
    })
    expect(containsSecret(issued)).toBe(false)
    expect(containsSecret(host.stderr.join('\n'))).toBe(false)
    expect(host.stderr.join('\n')).not.toContain(host.token)

    await host.server.close()
    const restarted = await startServer({
      port: 0,
      dataDir: host.dataDir,
      logLevel: 'silent',
      workspaces: [join(host.dataDir, 'workspace')],
    })
    servers.push(restarted)
    expect(
      restarted.audit
        .query({ type: 'token.issued' })
        .some((event) => event.clientId === host.server.owner.clientId),
    ).toBe(true)
  })

  it('refuses upload bytes without a credential or a ticket the server issued', async () => {
    const host = await setup()
    expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(0)
    expect(isOversizedUpload(MAX_ATTACHMENT_BYTES)).toBe(false)
    expect(isOversizedUpload(MAX_ATTACHMENT_BYTES + 1)).toBe(true)
    expect(isOversizedUpload(Number.POSITIVE_INFINITY)).toBe(true)

    // Oversized, reused, expired and interrupted transfers need a session and
    // live in uploads.integration.test.ts; these two need nothing but the route.
    const put = async (headers: Record<string, string>) => {
      const response = await fetch(`${host.server.url}/uploads/not-a-ticket`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', ...headers },
        body: Buffer.from('bytes'),
      })
      return {
        status: response.status,
        code: ((await response.json()) as { error?: { code?: string } }).error?.code,
      }
    }
    expectClosedFor('PUT without a credential', await put({}), { status: 401, code: 'auth' })
    expectClosedFor(
      'PUT with a ticket the server never issued',
      await put({ authorization: `Bearer ${host.token}` }),
      { status: 404, code: 'not_found' },
    )
    expect(
      host.server.audit.query({ type: 'upload.rejected' }).map((event) => event.details.reason),
    ).toEqual(['unknown_ticket'])
    expect(host.server.audit.query({ type: 'auth.failed' }).length).toBeGreaterThan(0)
  })
})
