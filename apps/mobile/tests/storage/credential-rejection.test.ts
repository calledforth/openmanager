import { afterEach, describe, expect, it } from 'vitest'
import {
  createWebSocketEnvironmentClient,
  type WebSocketLike,
} from '@openmanager/environment-client'
import {
  EMPTY_REGISTRY,
  PROTOCOL_VERSION,
  deriveConnectionUi,
  findStoredEnvironment,
  readEnvironmentRegistry,
  routeHealthFromConnection,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import {
  environmentNeedsPairing,
  forgetRejectedCredential,
  isRevokedCredentialFailure,
  isRevokedCredentialReport,
} from '../../src/storage/credential-rejection'
import { createPhoneStorage } from '../../src/storage/phone-storage'
import { TOKEN_A, TOKEN_B, device, secretOf, storeContains, takeLeaks } from './fakes'

const STUDIO = 'env-studio'
const ENDPOINT = 'https://studio.example.com'

type Listener = (event: never) => void

/** The server end of a socket, as in environment-client's own tests. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: Array<{ requestId: string; name: string }> = []
  private listeners = new Map<string, Listener[]>()
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeSocket.instances.push(this)
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }
  open() {
    this.readyState = 1
    this.dispatch('open', undefined)
  }
  drop(code: number, reason: string) {
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }
  respond(name: string, payload: unknown) {
    const request = [...this.sent].reverse().find((message) => message.name === name)!
    this.dispatch('message', {
      data: JSON.stringify({ type: 'response', requestId: request.requestId, payload }),
    })
  }
  private dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
}

function createTimers() {
  const queue: Array<{ fn: () => void; at: number; id: number }> = []
  let now = 0
  let id = 0
  return {
    now: () => now,
    setTimeout: (fn: () => void, delayMs: number) => {
      const entry = { fn, at: now + delayMs, id: ++id }
      queue.push(entry)
      return entry.id
    },
    clearTimeout: (handle: unknown) => {
      const index = queue.findIndex((entry) => entry.id === handle)
      if (index !== -1) queue.splice(index, 1)
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const next = queue.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        queue.splice(queue.indexOf(next), 1)
        now = next.at
        next.fn()
      }
      now = target
    },
    pending: () => queue.length,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function pairedPhone() {
  const stores = device()
  const storage = createPhoneStorage(stores)
  await storage.hydrate()
  const registry = upsertStoredEnvironment(EMPTY_REGISTRY, {
    environmentId: STUDIO,
    endpoint: ENDPOINT,
    label: 'Studio',
    credential: TOKEN_A,
  })!
  writeEnvironmentRegistry(registry, storage.registry)
  await storage.flush()
  return { ...stores, storage }
}

/** Connect with the stored credential, as the phone's controller does. */
async function connect(registry: EnvironmentRegistry, expectEnvironmentId = STUDIO) {
  FakeSocket.instances = []
  const timers = createTimers()
  let requests = 0
  const credential = findStoredEnvironment(registry.environments, STUDIO)!.credential
  const client = createWebSocketEnvironmentClient({
    url: 'wss://studio.example.com/ws',
    credential,
    environmentId: expectEnvironmentId,
    WebSocket: FakeSocket,
    timers,
    now: timers.now,
    requestId: () => `req-${++requests}`,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2 },
  })
  client.connect()
  const socket = FakeSocket.instances[0]!
  socket.open()
  socket.respond('protocol.handshake', {
    protocolVersion: PROTOCOL_VERSION,
    environmentId: STUDIO,
    capabilities: ['connection.heartbeat'],
  })
  await tick()
  return { client, socket, timers, credential }
}

afterEach(() => {
  expect(takeLeaks()).toEqual([])
})

describe('a credential the environment revoked', () => {
  it('is dropped from SecureStore, keeps the environment, offers pairing, and is never retried', async () => {
    const { storage, asyncStore, secureStore } = await pairedPhone()
    let registry = readEnvironmentRegistry(storage.registry)
    const { client, socket, timers, credential } = await connect(registry)
    expect(client.getState().connection.phase).toBe('connected')
    // The phone carries the credential the way a browser does, so the
    // environment answers with the revocation close rather than a bare 401.
    expect(socket.protocols).toEqual(['openmanager.v1', `openmanager.auth.${TOKEN_A}`])

    // Revoked from web's Devices page.
    socket.drop(4401, 'revoked')
    const connection = client.getState().connection
    expect(isRevokedCredentialFailure(connection.failure)).toBe(true)
    const report = routeHealthFromConnection(connection)
    expect(isRevokedCredentialReport(report)).toBe(true)

    // What the controller does with it: the shared latch, and the phone's drop.
    registry = forgetRejectedCredential(registry, STUDIO, credential)
    writeEnvironmentRegistry(registry, storage.registry)
    await storage.flush()

    expect(secretOf(secureStore, STUDIO)).toBeNull()
    expect(storeContains(asyncStore, TOKEN_A)).toBe(false)
    const ui = deriveConnectionUi({
      environment: {
        status: 'selected',
        endpoint: ENDPOINT,
        environmentId: STUDIO,
        label: 'Studio',
      },
      bootstrap: { status: 'ready', environmentId: STUDIO, protocolVersion: PROTOCOL_VERSION },
      transport: {
        phase: connection.phase,
        hasConnected: connection.hasConnected,
        failure: { code: 'auth', message: connection.failure!.message },
        retriesExhausted: connection.retriesExhausted,
      },
      routeFailure: {
        reason: 'credential_rejected',
        endpoint: ENDPOINT,
        local: false,
        tried: 1,
        message: connection.failure!.message,
      },
    })
    expect(ui).toMatchObject({
      kind: 'unauthorized',
      surface: 'screen',
      reason: 'credential_rejected',
      action: 'change_environment',
    })
    expect(ui.retrying).toBeUndefined()

    // No retry loop: nothing is scheduled, and no socket is ever opened again.
    expect(timers.pending()).toBe(0)
    timers.advance(10 * 60_000)
    expect(FakeSocket.instances).toHaveLength(1)

    // The environment survives, selected, with its routes; it reads as needing to pair.
    const relaunched = createPhoneStorage({ asyncStore, secureStore })
    await relaunched.hydrate()
    const after = readEnvironmentRegistry(relaunched.registry)
    expect(after.selectedId).toBe(STUDIO)
    const environment = findStoredEnvironment(after.environments, STUDIO)
    expect(environment?.routes.map((route) => route.endpoint)).toEqual([ENDPOINT])
    expect(environmentNeedsPairing(environment)).toBe(true)

    // Pairing again stores the new credential in SecureStore.
    const repaired = upsertStoredEnvironment(after, {
      environmentId: STUDIO,
      endpoint: ENDPOINT,
      credential: TOKEN_B,
    })!
    writeEnvironmentRegistry(repaired, relaunched.registry)
    await relaunched.flush()
    expect(secretOf(secureStore, STUDIO)).toBe(TOKEN_B)
    expect(storeContains(asyncStore, TOKEN_B)).toBe(false)
  })

  it('is also dropped when the environment no longer knows it at all', async () => {
    const { storage } = await pairedPhone()
    const { client, socket } = await connect(readEnvironmentRegistry(storage.registry))
    socket.drop(4401, 'unauthorized')
    expect(isRevokedCredentialFailure(client.getState().connection.failure)).toBe(true)
  })
})

describe('a credential that was not revoked', () => {
  it('is kept when the address now leads to a different environment', async () => {
    const { storage, secureStore } = await pairedPhone()
    const registry = readEnvironmentRegistry(storage.registry)
    // Also an `auth` failure, raised by this client, not the environment.
    const { client, timers } = await connect(registry, 'env-somewhere-else')
    const connection = client.getState().connection
    expect(connection.failure?.code).toBe('auth')
    expect(isRevokedCredentialFailure(connection.failure)).toBe(false)
    expect(isRevokedCredentialReport(routeHealthFromConnection(connection))).toBe(false)
    timers.advance(10 * 60_000)
    expect(secretOf(secureStore, STUDIO)).toBe(TOKEN_A)
  })

  it('is kept when a late refusal names a credential the phone has already replaced', async () => {
    const { storage } = await pairedPhone()
    const registry = upsertStoredEnvironment(readEnvironmentRegistry(storage.registry), {
      environmentId: STUDIO,
      endpoint: ENDPOINT,
      credential: TOKEN_B,
    })!
    expect(forgetRejectedCredential(registry, STUDIO, TOKEN_A)).toBe(registry)
    expect(forgetRejectedCredential(registry, 'env-unknown', TOKEN_B)).toBe(registry)
    expect(forgetRejectedCredential(registry, STUDIO, '')).toBe(registry)
  })

  it('reads as paired, and an unknown environment as neither', () => {
    const registry = upsertStoredEnvironment(EMPTY_REGISTRY, {
      environmentId: STUDIO,
      endpoint: ENDPOINT,
      credential: TOKEN_A,
    })!
    expect(environmentNeedsPairing(registry.environments[0])).toBe(false)
    expect(environmentNeedsPairing(undefined)).toBe(false)
  })
})
