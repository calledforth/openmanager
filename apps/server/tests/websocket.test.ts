import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { WebSocket, type ClientOptions } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HEARTBEAT_POLICY,
  PROTOCOL_VERSION,
  ProofResponseSchemas,
  ServerMessageSchema,
  type ServerMessage,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { startServer } from '../src/server.js'
import { SOCKET_LIMITS } from '../src/websocket.js'

const directories: string[] = []
const servers: Awaited<ReturnType<typeof startServer>>[] = []
const clients: WebSocket[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const client of clients.splice(0)) client.terminate()
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-socket-test-'))
  directories.push(dataDir)
  const server = await startServer({
    port: 0,
    dataDir,
    logLevel: 'silent',
    allowedOrigins: ['http://localhost:5173'],
  })
  servers.push(server)
  const token = (await readFile(join(dataDir, 'client-token'), 'utf8')).trim()
  return { server, token, url: `${server.url.replace('http:', 'ws:')}/ws` }
}
type Host = Awaited<ReturnType<typeof setup>>

async function connect(host: Host, browser = false) {
  const ws = browser
    ? new WebSocket(host.url, ['openmanager.v1', `openmanager.auth.${host.token}`], {
        origin: 'http://localhost:5173',
      })
    : new WebSocket(host.url, { headers: { authorization: `Bearer ${host.token}` } })
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
type Client = Awaited<ReturnType<typeof connect>>
async function handshake(client: Client) {
  const id = client.command('protocol.handshake', {
    protocolVersion: PROTOCOL_VERSION,
    requiredCapabilities: ['connection.heartbeat'],
  })
  expect(await client.next()).toMatchObject({ type: 'response', requestId: id })
}
async function subscribe(client: Client, scope: SubscriptionScope) {
  client.command('subscription.subscribe', { scope })
  return ProofResponseSchemas['subscription.subscribe'].parse(await client.next()).payload
    .subscriptionId
}
function record(scope: SubscriptionScope) {
  return {
    cursor: { scope, epoch: 'epoch-1', sequence: 1 },
    event: {
      type: 'event',
      eventId: 'event-1',
      timestamp: '2026-09-07T00:00:00Z',
      scope,
      ...(scope.type === 'environment'
        ? {
            name: 'workspace.updated',
            payload: { workspace: { workspaceId: 'workspace-1', name: 'Project' } },
          }
        : scope.type === 'session'
          ? {
              name: 'thread.created',
              payload: { thread: { sessionId: scope.sessionId, threadId: 'thread-1' } },
            }
          : { name: 'turn.completed', payload: { turnId: 'turn-1' } }),
    },
  }
}
async function rejection(url: string, options: ClientOptions = {}) {
  const ws = new WebSocket(url, options)
  clients.push(ws)
  ws.on('error', () => {})
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    ws.once('open', () => reject(new Error('Unexpected successful upgrade')))
    ws.once('unexpected-response', async (_request, response) => {
      let body = ''
      for await (const chunk of response) body += String(chunk)
      ws.terminate()
      resolve({ status: response.statusCode, body: JSON.parse(body) })
    })
  })
}

describe('authenticated upgrade', () => {
  it('rejects missing/invalid credentials before upgrade with the protocol auth code', async () => {
    const host = await setup()
    const headerCases: Record<string, string>[] = [
      {},
      { authorization: 'Bearer invalid' },
      { authorization: `Bearer ${'0'.repeat(64)}` },
    ]
    for (const headers of headerCases) {
      expect(await rejection(host.url, { headers })).toMatchObject({
        status: 401,
        body: { type: 'error', requestId: null, error: { code: 'auth' } },
      })
    }
    expect(host.server.sockets.connectionCount).toBe(0)
  })

  it('accepts native bearer and browser subprotocol credentials without echoing the token', async () => {
    const host = await setup()
    const native = await connect(host)
    const browser = await connect(host, true)
    expect(native.ws.protocol).toBe('')
    expect(browser.ws.protocol).toBe('openmanager.v1')
    await handshake(native)
    await handshake(browser)
    expect(host.server.sockets.connectionCount).toBe(2)
  })

  it('rejects untrusted and opaque origins even with a valid credential', async () => {
    const host = await setup()
    for (const origin of [
      'https://attacker.example',
      'null',
      'http://localhost:5173.attacker.example',
    ]) {
      expect(
        await rejection(host.url, {
          origin,
          headers: { authorization: `Bearer ${host.token}` },
        }),
      ).toMatchObject({ status: 403, body: { error: { code: 'auth' } } })
    }
    expect(await rejection(`${host.url}?token=${host.token}`)).toMatchObject({ status: 404 })
    expect(host.server.sockets.connectionCount).toBe(0)
  })

  it('allows bootstrap reads from configured browser origins only', async () => {
    const { server } = await setup()
    for (const path of ['/health', '/bootstrap']) {
      const allowed = await fetch(`${server.url}${path}`, {
        headers: { origin: 'http://localhost:5173' },
      })
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
      expect(allowed.headers.get('vary')).toBe('Origin')
      const denied = await fetch(`${server.url}${path}`, {
        headers: { origin: 'https://attacker.example' },
      })
      expect(denied.status).toBe(403)
      expect(denied.headers.has('access-control-allow-origin')).toBe(false)
      expect(await denied.json()).toMatchObject({ error: { code: 'auth' } })
    }
  })
})

describe('handshake and scoped subscriptions', () => {
  it('requires the application handshake before subscriptions and closes rejected handshakes', async () => {
    const host = await setup()
    const early = await connect(host)
    const earlyClosed = once(early.ws, 'close')
    early.command('subscription.subscribe', {
      scope: { type: 'environment', environmentId: host.server.identity.environmentId },
    })
    expect(await early.next()).toMatchObject({ type: 'error', error: { code: 'validation' } })
    await earlyClosed
    for (const payload of [
      { protocolVersion: 2, futureVersionField: true },
      { protocolVersion: PROTOCOL_VERSION, requiredCapabilities: ['turn.send'] },
    ]) {
      const client = await connect(host)
      const closed = once(client.ws, 'close')
      client.command('protocol.handshake', payload)
      expect(await client.next()).toMatchObject({
        type: 'error',
        error: {
          code: payload.protocolVersion === 2 ? 'protocol_incompatible' : 'capability_missing',
        },
      })
      await closed
    }
    expect(host.server.sockets.connectionCount).toBe(0)
    expect(host.server.sockets.subscriptionCount).toBe(0)
  })

  it('delivers durable records to exact scopes and isolates unsubscribe by connection', async () => {
    const host = await setup()
    const a = await connect(host)
    const b = await connect(host)
    await handshake(a)
    await handshake(b)
    const environmentId = host.server.identity.environmentId
    const envScope = { type: 'environment' as const, environmentId }
    const sessionScope = { type: 'session' as const, environmentId, sessionId: 'session-1' }
    const threadScope = {
      type: 'thread' as const,
      environmentId,
      sessionId: 'session-1',
      threadId: 'thread-1',
    }
    const aId = await subscribe(a, envScope)
    const bId = await subscribe(b, sessionScope)
    const threadId = await subscribe(b, threadScope)
    expect(host.server.sockets.subscriptionCount).toBe(3)
    for (const [scope, subscriptionId] of [
      [sessionScope, bId],
      [threadScope, threadId],
    ] as const) {
      host.server.sockets.publish(record(scope))
      expect(await b.next()).toMatchObject({
        type: 'event',
        name: 'subscription.event',
        payload: { subscriptionId },
      })
    }
    // Ordered command result proves the environment subscription received no child-scope event.
    a.command('unknown.command', null)
    expect(await a.next()).toMatchObject({ type: 'error', error: { code: 'validation' } })
    b.command('subscription.unsubscribe', { subscriptionId: aId })
    expect(await b.next()).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    host.server.sockets.publish(record(envScope))
    expect(await a.next()).toMatchObject({ type: 'event', payload: { subscriptionId: aId } })
    a.command('subscription.unsubscribe', { subscriptionId: aId })
    expect(await a.next()).toMatchObject({ type: 'response', payload: null })
    host.server.sockets.publish(record(envScope))
    a.command('unknown.command', null)
    expect(await a.next()).toMatchObject({ type: 'error' })
    expect(host.server.sockets.subscriptionCount).toBe(2)
    expect(() =>
      host.server.sockets.publish(record({ type: 'environment', environmentId: 'foreign' })),
    ).toThrow('another environment')
  })

  it('rejects foreign and malformed scopes without adding subscriptions', async () => {
    const host = await setup()
    const client = await connect(host)
    await handshake(client)
    client.command('subscription.subscribe', {
      scope: { type: 'environment', environmentId: 'foreign' },
    })
    expect(await client.next()).toMatchObject({ type: 'error', error: { code: 'auth' } })
    client.command('subscription.subscribe', {
      scope: { type: 'thread', environmentId: host.server.identity.environmentId },
    })
    expect(await client.next()).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(host.server.sockets.subscriptionCount).toBe(0)
  })

  it('replays duplicate command results without a second effect and closes conflicting reuse', async () => {
    const host = await setup()
    const client = await connect(host)
    await handshake(client)
    const payload = {
      scope: { type: 'environment', environmentId: host.server.identity.environmentId },
    }
    client.command('subscription.subscribe', payload, 'same-id')
    const first = await client.next()
    client.command('subscription.subscribe', payload, 'same-id')
    expect(await client.next()).toEqual(first)
    expect(host.server.sockets.subscriptionCount).toBe(1)
    const closed = once(client.ws, 'close')
    client.command('subscription.unsubscribe', { subscriptionId: 'different' }, 'same-id')
    expect(await client.next()).toMatchObject({
      type: 'error',
      requestId: null,
      error: { code: 'conflict' },
    })
    await closed
    expect(host.server.sockets.subscriptionCount).toBe(0)
  })

  it.each(['graceful', 'abrupt'])(
    'releases all connection state on %s client close',
    async (mode) => {
      const host = await setup()
      const client = await connect(host)
      await handshake(client)
      await subscribe(client, {
        type: 'environment',
        environmentId: host.server.identity.environmentId,
      })
      const closed = once(client.ws, 'close')
      if (mode === 'graceful') client.ws.close()
      else client.ws.terminate()
      await closed
      // Abrupt client close can precede the server's EOF notification.
      for (let i = 0; i < 100 && host.server.sockets.connectionCount; i++) await immediate()
      expect(host.server.sockets.connectionCount).toBe(0)
      expect(host.server.sockets.subscriptionCount).toBe(0)
    },
  )

  it('returns safe validation errors for malformed JSON and invalid message direction', async () => {
    const host = await setup()
    for (const text of [
      '{',
      JSON.stringify({ type: 'response', requestId: 'bad-1', payload: null }),
    ]) {
      const client = await connect(host)
      const closed = once(client.ws, 'close')
      client.ws.send(text)
      expect(await client.next()).toMatchObject({ type: 'error', error: { code: 'validation' } })
      await closed
    }
    expect(host.server.sockets.connectionCount).toBe(0)
  })
})

describe('protocol heartbeat timers', () => {
  it('starts after handshake, requires a matching timely pong, and immediately releases timed-out subscriptions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const host = await setup()
    const client = await connect(host)
    await handshake(client)
    await subscribe(client, {
      type: 'environment',
      environmentId: host.server.identity.environmentId,
    })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLICY.serverPingIntervalMs)
    const ping = await client.next()
    expect(ping).toMatchObject({ type: 'ping', heartbeatId: expect.any(String) })
    if (ping.type !== 'ping') throw new Error('Expected ping')
    client.ws.send(JSON.stringify({ type: 'pong', heartbeatId: ping.heartbeatId }))
    client.command('unknown.command', null)
    await client.next() // Barrier: pong processed before advancing the clock.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLICY.serverPingIntervalMs)
    const nextPing = await client.next()
    expect(nextPing).toMatchObject({ type: 'ping' })
    expect(nextPing).not.toEqual(ping)
    client.ws.send(JSON.stringify({ type: 'pong', heartbeatId: ping.heartbeatId }))
    client.command('unknown.command', null)
    await client.next()
    const closed = once(client.ws, 'close')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLICY.pongTimeoutMs)
    expect(host.server.sockets.connectionCount).toBe(0)
    expect(host.server.sockets.subscriptionCount).toBe(0)
    const [code, reason] = await closed
    expect(code).toBe(4000)
    expect(String(reason)).toBe('heartbeat_timeout')
  })

  it('expires connections that never perform a handshake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const host = await setup()
    const client = await connect(host)
    const closed = once(client.ws, 'close')
    await vi.advanceTimersByTimeAsync(SOCKET_LIMITS.handshakeTimeoutMs)
    const [code, reason] = await closed
    expect(code).toBe(1008)
    expect(String(reason)).toBe('handshake_timeout')
    expect(host.server.sockets.connectionCount).toBe(0)
  })
})
