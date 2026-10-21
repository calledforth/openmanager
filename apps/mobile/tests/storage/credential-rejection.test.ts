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
  type BootstrapOutcome,
  type EnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import {
  environmentNeedsPairing,
  forgetRejectedCredential,
  confirmCredentialRejected,
  credentialRefusalOf,
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
async function connect(
  registry: EnvironmentRegistry,
  { expectEnvironmentId = STUDIO, handshake = true } = {},
) {
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
  if (handshake)
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

const answersAs = (environmentId: string) => async (): Promise<BootstrapOutcome> => ({
  status: 'ready',
  environmentId,
  protocolVersion: PROTOCOL_VERSION,
})
const neverAsked = async (): Promise<BootstrapOutcome> => {
  throw new Error('should not have asked')
}

/** The controller's part: the shared latch, then the phone's drop when confirmed. */
async function handleRefusal(
  storage: ReturnType<typeof createPhoneStorage>,
  connection: Parameters<typeof routeHealthFromConnection>[0],
  credential: string,
  probe: (endpoint: string) => Promise<BootstrapOutcome>,
) {
  const report = routeHealthFromConnection(connection)
  const forget = await confirmCredentialRejected({
    refusal: credentialRefusalOf(report),
    environmentId: STUDIO,
    endpoint: ENDPOINT,
    probe,
  })
  if (forget) {
    const registry = forgetRejectedCredential(
      readEnvironmentRegistry(storage.registry),
      STUDIO,
      credential,
    )
    writeEnvironmentRegistry(registry, storage.registry)
  }
  await storage.flush()
  return forget
}

describe('a credential revoked from the Devices page', () => {
  it('while the phone was away: refused on the next connect, confirmed, dropped, never retried, offers pairing', async () => {
    const { storage, asyncStore, secureStore } = await pairedPhone()
    const { client, socket, timers, credential } = await connect(
      readEnvironmentRegistry(storage.registry),
      { handshake: false },
    )
    // The phone carries the credential the way a browser does, so the
    // environment answers with the revocation close rather than a bare 401.
    expect(socket.protocols).toEqual(['openmanager.v1', `openmanager.auth.${TOKEN_A}`])
    socket.drop(4401, 'unauthorized')
    const connection = client.getState().connection
    expect(credentialRefusalOf(connection.failure)).toBe('unknown')

    // The same address still answers as this environment, so it was this one that refused.
    expect(await handleRefusal(storage, connection, credential, answersAs(STUDIO))).toBe(true)
    expect(secretOf(secureStore, STUDIO)).toBeNull()
    expect(storeContains(asyncStore, TOKEN_A)).toBe(false)

    // The shared latch: "Not authorized", nothing retrying.
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

  it('while connected: dropped without asking, since only its own environment can revoke it', async () => {
    const { storage, secureStore } = await pairedPhone()
    const { client, socket, timers, credential } = await connect(
      readEnvironmentRegistry(storage.registry),
    )
    expect(client.getState().connection.phase).toBe('connected')
    socket.drop(4401, 'revoked')
    const connection = client.getState().connection
    expect(credentialRefusalOf(connection.failure)).toBe('revoked')
    expect(await handleRefusal(storage, connection, credential, neverAsked)).toBe(true)
    expect(secretOf(secureStore, STUDIO)).toBeNull()
    timers.advance(10 * 60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe('a credential that was not revoked', () => {
  it('is kept when a different environment at the address refuses it', async () => {
    const { storage, secureStore } = await pairedPhone()
    const { client, socket, timers, credential } = await connect(
      readEnvironmentRegistry(storage.registry),
      { handshake: false },
    )
    // A reused tunnel: the server there knows none of this environment's credentials.
    socket.drop(4401, 'unauthorized')
    const connection = client.getState().connection
    expect(
      await handleRefusal(storage, connection, credential, answersAs('env-somewhere-else')),
    ).toBe(false)
    expect(secretOf(secureStore, STUDIO)).toBe(TOKEN_A)
    // Still no retry: the latch holds whatever the phone keeps.
    timers.advance(10 * 60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('is kept when the address cannot say which environment it is', async () => {
    const probes = [
      async (): Promise<BootstrapOutcome> => ({ status: 'unreachable', cause: 'network' }),
      async (): Promise<BootstrapOutcome> => ({ status: 'unauthorized' }),
      async (): Promise<BootstrapOutcome> => {
        throw new Error('offline')
      },
    ]
    for (const probe of probes) {
      expect(
        await confirmCredentialRejected({
          refusal: 'unknown',
          environmentId: STUDIO,
          endpoint: ENDPOINT,
          probe,
        }),
      ).toBe(false)
    }
  })

  it('is kept when this client itself finds a different environment at the handshake', async () => {
    const { storage, secureStore } = await pairedPhone()
    const { client, timers, credential } = await connect(
      readEnvironmentRegistry(storage.registry),
      { expectEnvironmentId: 'env-somewhere-else' },
    )
    const connection = client.getState().connection
    expect(connection.failure?.code).toBe('auth')
    expect(credentialRefusalOf(connection.failure)).toBeNull()
    expect(await handleRefusal(storage, connection, credential, neverAsked)).toBe(false)
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
