import { PROTOCOL_VERSION } from '@openmanager/protocol'
import {
  createWebSocketEnvironmentClient,
  type WebSocketEnvironmentClientOptions,
  type WebSocketLike,
} from '@openmanager/environment-client'
import {
  writeEnvironmentRegistry,
  type BootstrapOutcome,
  type EnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import {
  createPhoneConnectionController,
  type AppActivity,
  type PhoneConnectionOptions,
  type PhoneNetwork,
} from '../src/environment/controller'
import { createMemoryPhoneStorage } from '../src/environment/phone-storage'

type Listener = (event: never) => void

/** The server end of a socket, scriptable; the client sees a WHATWG-shaped object. */
export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = []
  /** Hold a client-side close until `finishClose()`, as a real socket's close handshake does. */
  static deferClose = false
  readyState = 0
  private pendingClose: { code: number; reason: string } | null = null
  sent: Array<{ type: string; requestId: string; name: string; payload: unknown }> = []
  closedWith: { code: number; reason: string } | null = null
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
    if (this.readyState >= 2) return
    this.closedWith = { code, reason }
    if (FakeSocket.deferClose) {
      this.readyState = 2
      this.pendingClose = { code, reason }
      return
    }
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }
  /** Deliver a close held by `deferClose`. */
  finishClose() {
    const pending = this.pendingClose
    if (!pending) throw new Error('No close is pending')
    this.pendingClose = null
    this.readyState = 3
    this.dispatch('close', pending)
  }
  // --- server side -------------------------------------------------------
  open() {
    this.readyState = 1
    this.dispatch('open', undefined)
  }
  receive(message: unknown) {
    this.dispatch('message', { data: JSON.stringify(message) })
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3
    this.closedWith = { code, reason }
    this.dispatch('close', { code, reason })
  }
  last(name: string) {
    return [...this.sent].reverse().find((message) => message.name === name)!
  }
  respond(name: string, payload: unknown) {
    this.receive({ type: 'response', requestId: this.last(name).requestId, payload })
  }
  /** Accept the socket and answer the handshake as `environmentId`. */
  accept(environmentId = ENV, capabilities: string[] = ['connection.heartbeat']) {
    this.open()
    this.respond('protocol.handshake', {
      protocolVersion: PROTOCOL_VERSION,
      environmentId,
      capabilities,
    })
  }
  private dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
}

export function createTimers() {
  const queue: Array<{ fn: () => void; at: number; id: number }> = []
  let now = 1_000_000
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

export type Timers = ReturnType<typeof createTimers>

/** A value source with the controller's `current` / `subscribe` shape. */
export function createSource<T>(initial: T) {
  let value = initial
  const listeners = new Set<(value: T) => void>()
  return {
    current: () => value,
    subscribe(listener: (value: T) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: T) {
      value = next
      for (const listener of [...listeners]) listener(next)
    },
  }
}

/** Let promise continuations (probes, registry writes) run. */
export const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export const ENV = 'env-studio'
export const OTHER_ENV = 'env-other'
export const TOKEN = 't'.repeat(43)
export const LAN = 'http://192.168.1.20:43120'
export const TUNNEL = 'https://studio.example.com'

export const ready = (environmentId = ENV, label = 'Studio'): BootstrapOutcome => ({
  status: 'ready',
  environmentId,
  label,
  protocolVersion: PROTOCOL_VERSION,
})

export const silent: BootstrapOutcome = {
  status: 'unreachable',
  message: 'Could not reach it.',
  cause: 'network',
}

export function registryWith(endpoints: string[], environmentId = ENV): EnvironmentRegistry {
  return {
    selectedId: environmentId,
    environments: [
      {
        environmentId,
        label: 'Studio',
        routes: endpoints.map((endpoint, priority) => ({
          type: endpoint.startsWith('https:') ? 'cloudflare' : 'lan',
          endpoint,
          priority,
          health: { status: 'unknown' as const },
        })),
        credential: '',
      },
    ],
  }
}

/**
 * A controller over memory storage with one saved environment, fake timers,
 * scripted route answers and the real WebSocket client on fake sockets.
 */
export function harness(
  input: {
    routes?: string[]
    answers?: Record<string, BootstrapOutcome | Promise<BootstrapOutcome>>
    registry?: EnvironmentRegistry
    credentials?: Record<string, string>
    options?: Partial<PhoneConnectionOptions>
  } = {},
) {
  FakeSocket.instances = []
  FakeSocket.deferClose = false
  const timers = createTimers()
  const storage = createMemoryPhoneStorage({ credentials: input.credentials ?? { [ENV]: TOKEN } })
  writeEnvironmentRegistry(input.registry ?? registryWith(input.routes ?? [LAN]), storage.registry)
  const activity = createSource<AppActivity>('active')
  const network = createSource<PhoneNetwork>({ online: true })
  const answers = new Map(Object.entries(input.answers ?? { [LAN]: ready() }))
  const probes: string[] = []
  let requests = 0
  const controller = createPhoneConnectionController({
    storage,
    activity,
    network,
    timers,
    now: timers.now,
    probe: async (endpoint) => {
      probes.push(endpoint)
      return (await answers.get(endpoint)) ?? silent
    },
    createClient: (options: WebSocketEnvironmentClientOptions) =>
      createWebSocketEnvironmentClient({ ...options, timers, now: timers.now }),
    transport: {
      WebSocket: FakeSocket,
      requestId: () => `req-${++requests}`,
    },
    ...input.options,
  })
  return {
    controller,
    storage,
    timers,
    activity,
    network,
    answers,
    probes,
    sockets: () => FakeSocket.instances,
    socket: () => FakeSocket.instances.at(-1)!,
    state: () => controller.getState(),
  }
}

/** A pairing link token: twelve characters of the pairing alphabet. */
export const PAIRING_TOKEN = 'ABCDEFGHJKMN'
