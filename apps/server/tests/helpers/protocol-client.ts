import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { expect } from 'vitest'
import {
  PROTOCOL_VERSION,
  ProofResponseSchemas,
  ServerMessageSchema,
  SubscriptionEventSchema,
  type DurableEvent,
  type ServerMessage,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { startServer } from '../../src/server.js'
import type { ServerConfig } from '../../src/config.js'

const directories: string[] = []
const servers: Awaited<ReturnType<typeof startServer>>[] = []
const clients: WebSocket[] = []

export async function cleanupProtocolHosts(): Promise<void> {
  for (const client of clients.splice(0)) client.terminate()
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}

export async function startProtocolHost(overrides: Partial<ServerConfig> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-stream-test-'))
  directories.push(dataDir)
  const server = await startServer({
    port: 0,
    dataDir,
    logLevel: 'silent',
    ...overrides,
  })
  servers.push(server)
  const token = (await readFile(join(dataDir, 'client-token'), 'utf8')).trim()
  return { server, token, url: `${server.url.replace('http:', 'ws:')}/ws`, dataDir }
}

export type ProtocolHost = Awaited<ReturnType<typeof startProtocolHost>>

export async function connectProtocol(host: ProtocolHost) {
  const ws = new WebSocket(host.url, { headers: { authorization: `Bearer ${host.token}` } })
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
    heldEvents: [] as ServerMessage[],
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

export type ProtocolClient = Awaited<ReturnType<typeof connectProtocol>>

export async function handshake(client: ProtocolClient) {
  const id = client.command('protocol.handshake', {
    protocolVersion: PROTOCOL_VERSION,
    requiredCapabilities: ['connection.heartbeat'],
  })
  expect(await nextResponse(client, id)).toMatchObject({ type: 'response', requestId: id })
}

export async function subscribe(client: ProtocolClient, scope: SubscriptionScope) {
  const requestId = client.command('subscription.subscribe', { scope })
  return ProofResponseSchemas['subscription.subscribe'].parse(await nextResponse(client, requestId))
    .payload.subscriptionId
}

export async function nextNonPing(client: ProtocolClient): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next()
    if (message.type === 'ping') {
      client.ws.send(JSON.stringify({ type: 'pong', heartbeatId: message.heartbeatId }))
      continue
    }
    return message
  }
}

export async function nextResponse(client: ProtocolClient, requestId: string): Promise<ServerMessage> {
  for (;;) {
    const message = await nextNonPing(client)
    if (
      (message.type === 'response' || message.type === 'error') &&
      message.requestId === requestId
    ) {
      return message
    }
    if (message.type === 'event') client.heldEvents.push(message)
  }
}

export async function collectThreadRecords(
  client: ProtocolClient,
  subscriptionId: string,
  until: (records: DurableEvent[]) => boolean,
  timeoutMs = 15_000,
): Promise<DurableEvent[]> {
  const records: DurableEvent[] = []
  const ingest = (message: ServerMessage) => {
    if (message.type !== 'event' || message.name !== 'subscription.event') return false
    const event = SubscriptionEventSchema.parse(message)
    if (event.payload.subscriptionId !== subscriptionId) return false
    records.push(event.payload.record)
    return until(records)
  }
  while (client.heldEvents.length) {
    if (ingest(client.heldEvents.shift()!)) return records
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const message = await Promise.race([
      nextNonPing(client),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for thread events')), remaining),
      ),
    ])
    if (ingest(message)) return records
  }
  throw new Error(`timed out waiting for thread events: ${JSON.stringify(records.map(summarize))}`)
}

export function eventNames(records: DurableEvent[]): string[] {
  return records.map((record) => record.event.name)
}

export function sequences(records: DurableEvent[]): number[] {
  return records.map((record) => record.cursor.sequence)
}

export function assistantText(records: DurableEvent[]): string {
  return records
    .filter((record) => record.event.name === 'message.delta')
    .flatMap((record) => {
      const payload = record.event.payload as {
        role?: string
        content?: { type?: string; text?: string }
      }
      if (payload.role !== 'assistant') return []
      return payload.content?.type === 'text' && payload.content.text ? [payload.content.text] : []
    })
    .join('')
}

function summarize(record: DurableEvent) {
  return { sequence: record.cursor.sequence, name: record.event.name }
}
