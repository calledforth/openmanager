import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer, connect as connectTcp, type Server } from 'node:net'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@openmanager/protocol'
import {
  createWebSocketEnvironmentClient,
  encodePairingLink,
  type EnvironmentClient,
  type WebSocketConstructor,
} from '@openmanager/environment-client'
import { exchangePairingToken } from '@openmanager/environment-client/connection'
import {
  createPhoneConnectionController,
  type AppActivity,
  type PhoneConnectionState,
  type PhoneNetwork,
} from '../src/environment/controller'
import {
  appOriginFromPairingLink,
  type NativeWebSocketConstructor,
} from '../src/environment/app-origin'
import { createMemoryPhoneStorage } from '../src/environment/phone-storage'
import {
  installAbortSignalTimeout,
  installRandomUUID,
  missingRuntimeFills,
  type RuntimeScope,
} from '../src/environment/runtime-fills'
import { createSource } from '../tests/support'

/**
 * The phone's connection, end to end, against a real environment server:
 * the runtime fills, a pairing exchange, the local-network route search,
 * bootstrap, the socket handshake with protocol negotiation, `session.open`
 * with its snapshot, a background hold and return, a network gap, and a
 * revocation that must latch. Only React Native itself is absent: its
 * WebSocket is played by Node's, taking React Native's constructor
 * (`url, protocols, { headers }`) and sending `Origin` the way its native
 * module does (the given `headers.origin`, else the dialled URL's origin), and
 * AppState / NetInfo by value sources.
 *
 * LIVE_SERVER   the server's loopback URL, e.g. http://127.0.0.1:43230
 * LIVE_LAN      the phone's route, e.g. http://192.168.1.4:43231
 * LIVE_FORWARD  "1" to forward LIVE_LAN's port to LIVE_SERVER here (the
 *               server binds loopback only)
 * LIVE_DATA_DIR the server's data directory (for its owner credential)
 * LIVE_OUT      where to write the JSON record
 * LIVE_EXPECT   "refused" when the server is expected to refuse the upgrade
 * LIVE_APP_ORIGIN the web app's origin, as the server's --allowed-origin
 *               lists it; the pairing link is made under it. Empty pairs
 *               from a bare fragment, leaving no app origin (the fallback)
 */
vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }))

const SERVER = process.env.LIVE_SERVER ?? 'http://127.0.0.1:43230'
const LAN = process.env.LIVE_LAN ?? 'http://192.168.1.4:43231'
const DATA_DIR = process.env.LIVE_DATA_DIR ?? ''
const OUT = process.env.LIVE_OUT
const EXPECT_REFUSED = process.env.LIVE_EXPECT === 'refused'
const APP_ORIGIN = process.env.LIVE_APP_ORIGIN ?? 'https://app.example.test'

const started = Date.now()
const record: Array<Record<string, unknown>> = []
const note = (event: string, detail: Record<string, unknown> = {}) => {
  const entry = { t: Date.now() - started, event, ...detail }
  record.push(entry)
  console.log(JSON.stringify(entry))
}

const frames: Array<{ socket: number; direction: 'out' | 'in'; name: string; detail?: unknown }> =
  []
let socketCount = 0
const NodeWebSocket = globalThis.WebSocket

/** What React Native's WebSocketModule sends: Origin from the dialled URL. */
function nativeOrigin(url: string) {
  const parsed = new URL(url)
  return `${parsed.protocol === 'wss:' ? 'https' : 'http'}://${parsed.host}`
}

/**
 * Upgrade `/ws` by hand with `origin` and the phone's token, and report the
 * status the server answers with: 101 when it takes the socket, 403 when the
 * request guard refuses the origin.
 */
function upgradeStatus(endpoint: string, origin: string, credential: string): Promise<number> {
  const url = new URL('ws', endpoint.endsWith('/') ? endpoint : `${endpoint}/`)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from(randomUUID().slice(0, 16)).toString('base64'),
        'sec-websocket-protocol': `openmanager.v1, openmanager.auth.${credential}`,
        origin,
      },
    })
    req.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    req.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Node's WebSocket with React Native's constructor, with every frame noted.
 * `options.headers.origin` replaces the origin derived from the URL, as
 * `WebSocketModule.kt` does on Android.
 */
class PhoneWebSocket extends NodeWebSocket {
  readonly index: number
  constructor(
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    const origin = options?.headers?.origin ?? nativeOrigin(url)
    super(url, { protocols, headers: { ...options?.headers, origin } } as never)
    this.index = ++socketCount
    const index = this.index
    note('socket.dial', {
      socket: index,
      url,
      origin,
      originFrom: options?.headers?.origin ? 'headers.origin' : 'dialled URL',
      protocols: (protocols === undefined ? [] : [protocols].flat()).map((p) =>
        p.startsWith('openmanager.auth.') ? 'openmanager.auth.<token>' : p,
      ),
    })
    this.addEventListener('open', () => note('socket.open', { socket: index }))
    this.addEventListener('close', (event) =>
      note('socket.close', { socket: index, code: event.code, reason: event.reason }),
    )
    this.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string
          name?: string
          payload?: { protocolVersion?: number; capabilities?: string[] }
        }
        if (message.type === 'response' && message.payload?.protocolVersion !== undefined) {
          frames.push({
            socket: index,
            direction: 'in',
            name: 'protocol.handshake (result)',
            detail: {
              protocolVersion: message.payload.protocolVersion,
              capabilities: message.payload.capabilities?.length,
            },
          })
        }
      } catch {
        /* not JSON */
      }
    })
  }
  send(data: string) {
    const message = JSON.parse(data) as { name?: string; payload?: unknown }
    if (message.name) {
      frames.push({
        socket: this.index,
        direction: 'out',
        name: message.name,
        ...(message.name === 'protocol.handshake' ? { detail: message.payload } : {}),
      })
    }
    super.send(data)
  }
}

async function until(label: string, read: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!read()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

let forwarder: Server | undefined
const cleanups: Array<() => void> = []

afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await new Promise<void>((resolve) => (forwarder ? forwarder.close(() => resolve()) : resolve()))
  if (OUT) writeFileSync(OUT, JSON.stringify({ record, frames }, null, 2))
})

describe('phone connection, live', () => {
  it('pairs, connects over the LAN route, opens a session, holds and returns, and latches on revocation', async () => {
    // ---- the runtime the phone has --------------------------------------
    const { URL: PolyfillURL } = await import('react-native-url-polyfill')
    const scope = globalThis as unknown as RuntimeScope & { URL?: typeof URL }
    // Hermes has neither of these; take Node's away so the fills are what runs.
    const nativeTimeout = AbortSignal.timeout
    delete (AbortSignal as unknown as { timeout?: unknown }).timeout
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    const NodeURL = globalThis.URL
    globalThis.URL = PolyfillURL as unknown as typeof URL
    cleanups.push(() => {
      globalThis.URL = NodeURL
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        writable: true,
        value: nativeTimeout,
      })
      delete (globalThis.crypto as unknown as { randomUUID?: unknown }).randomUUID
    })
    note('runtime.before', { missing: missingRuntimeFills(scope) })
    installAbortSignalTimeout(scope)
    installRandomUUID(scope, randomUUID)
    note('runtime.after', { missing: missingRuntimeFills(scope) })
    expect(missingRuntimeFills(scope)).toEqual([])

    if (process.env.LIVE_FORWARD === '1') {
      const lan = new NodeURL(LAN)
      const server = new NodeURL(SERVER)
      forwarder = createServer((inbound) => {
        const outbound = connectTcp(Number(server.port), server.hostname)
        inbound.pipe(outbound).pipe(inbound)
        inbound.on('error', () => outbound.destroy())
        outbound.on('error', () => inbound.destroy())
      })
      await new Promise<void>((resolve) => forwarder!.listen(Number(lan.port), '0.0.0.0', resolve))
      note('forwarder.listening', { from: `0.0.0.0:${lan.port}`, to: server.host })
    }

    // ---- the owner makes a pairing link, as web's Devices page does -------
    const ownerCredential = readFileSync(join(DATA_DIR, 'owner-credential'), 'utf8').trim()
    const owner = createWebSocketEnvironmentClient({
      url: `${SERVER.replace('http:', 'ws:')}/ws`,
      credential: ownerCredential,
      WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
    })
    cleanups.push(() => owner.dispose())
    owner.connect()
    await until('owner connected', () => owner.getState().connection.phase === 'connected')
    const { token } = await owner.commands.createPairingLink({
      capabilities: ['read', 'operate', 'agent'],
      label: 'Live check phone',
    })
    // The link the web app shows: its own origin, `/pair`, the payload in the fragment.
    const pairingLink = APP_ORIGIN
      ? encodePairingLink(`${APP_ORIGIN}/`, {
          route: LAN,
          environmentId: owner.getState().environment!.environmentId,
          token,
        })
      : null
    const appOrigin = pairingLink ? appOriginFromPairingLink(pairingLink) : null
    note('pairing.link', {
      capabilities: ['read', 'operate', 'agent'],
      link: pairingLink?.replace(/token=[^&]+/, 'token=<token>') ?? null,
      appOrigin,
    })

    // ---- the phone trades it at POST /pair on its LAN route ----------------
    const paired = await exchangePairingToken(LAN, { token, label: 'Live check phone' })
    note('pairing.exchanged', {
      route: LAN,
      environmentId: paired.environmentId,
      label: paired.label,
      clientId: paired.clientId,
      grant: paired.grant,
    })

    // ---- what the request guard does with each Origin, on the phone's route --
    const routeOrigin = nativeOrigin(LAN.replace('http', 'ws'))
    const withApp = APP_ORIGIN ? await upgradeStatus(LAN, APP_ORIGIN, paired.credential) : null
    const withRoute = await upgradeStatus(LAN, routeOrigin, paired.credential)
    note('upgrade.origins', {
      appOrigin: APP_ORIGIN || null,
      withAppOrigin: withApp,
      routeOrigin,
      withRouteOrigin: withRoute,
    })
    if (APP_ORIGIN) expect(withApp).toBe(101)
    expect(withRoute).toBe(403)

    // ---- the phone's controller ------------------------------------------
    const storage = createMemoryPhoneStorage()
    const warnings: string[] = []
    const activity = createSource<AppActivity>('active')
    const network = createSource<PhoneNetwork>({ online: true })
    const controller = createPhoneConnectionController({
      storage,
      activity,
      network,
      transport: {
        WebSocket: PhoneWebSocket as unknown as NativeWebSocketConstructor,
        fetch: globalThis.fetch,
        requestId: () => globalThis.crypto.randomUUID(),
      },
      warn: (message) => {
        warnings.push(message)
        note('controller.warn', { message })
      },
    })
    cleanups.push(() => controller.dispose())
    let last: PhoneConnectionState['status'] | undefined
    controller.subscribe(() => {
      const state = controller.getState()
      if (state.status === last) return
      last = state.status
      note('status', {
        status: state.status,
        endpoint: state.endpoint,
        bootstrap: state.bootstrap.status,
        protocol: state.protocol,
        connection: state.connection
          ? { phase: state.connection.phase, failure: state.connection.failure?.code ?? null }
          : null,
        routeFailure: state.routeFailure?.reason ?? null,
        socketOrigin: state.socketOrigin,
        client: state.client ? 'published' : null,
      })
    })
    await controller.start()
    expect(controller.getState().status).toBe('no_environment')
    controller.saveEnvironment({
      environmentId: paired.environmentId,
      endpoint: LAN,
      label: paired.label,
      credential: paired.credential,
      appOrigin,
    })

    if (EXPECT_REFUSED) {
      await until(
        'a refused upgrade',
        () => socketCount > 0 && controller.getState().status === 'waiting',
      )
      note('refused', {
        status: controller.getState().status,
        connection: controller.getState().connection,
        attempt: controller.getState().attempt,
        socketOrigin: controller.getState().socketOrigin,
        warnings: warnings.length,
      })
      expect(controller.getState().socketOrigin?.from).toBe('route')
      expect(warnings).toHaveLength(1)
      return
    }

    await until('connected', () => controller.getState().status === 'connected')
    const state = controller.getState()
    expect(state.socketOrigin).toEqual({ origin: APP_ORIGIN, from: 'app' })
    expect(warnings).toEqual([])
    expect(state.bootstrap).toMatchObject({ status: 'ready', protocolVersion: PROTOCOL_VERSION })
    expect(state.protocol).toEqual({ client: PROTOCOL_VERSION, environment: PROTOCOL_VERSION })
    const handshake = frames.find((frame) => frame.name === 'protocol.handshake')
    expect(handshake?.detail).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
    note('negotiated', {
      bootstrapProtocol:
        state.bootstrap.status === 'ready' ? state.bootstrap.protocolVersion : null,
      handshakeSent: handshake?.detail,
      handshakeResult: frames.find((frame) => frame.name === 'protocol.handshake (result)')?.detail,
      capabilities: state.connection?.capabilities.length,
    })
    const client = state.client as EnvironmentClient
    const storedDocument = storage.registry.getItem('openmanager-environments') ?? ''
    note('storage', {
      registryHasToken: storedDocument.includes(paired.credential),
      credentialStore: Object.keys(storage.credentials.snapshot()),
    })
    expect(storedDocument.includes(paired.credential)).toBe(false)

    // ---- a session, opened with session.open and its snapshot -------------
    const workspaceId = owner.getState().workspaceOrder[0]
    expect(workspaceId).toBeTruthy()
    const providerId = Object.keys(owner.getState().providers)[0] ?? 'opencode'
    const created = await owner.commands.createSession({
      environmentId: paired.environmentId,
      workspaceId: workspaceId!,
      providerId,
      title: 'Opened from the phone',
    })
    const sessionId = created.session.sessionId
    note('session.created', { by: 'owner', sessionId, providerId })
    const sentBefore = frames.length
    await client.commands.openSession(sessionId)
    await until('session hydrated', () => {
      const phone = client.getState()
      const threads = phone.sessions[sessionId]?.threadIds ?? []
      return threads.every((threadId) => phone.threads[threadId]?.hydration === 'ready')
    })
    const opened = frames
      .slice(sentBefore)
      .filter((frame) => frame.direction === 'out')
      .map((frame) => frame.name)
    note('session.open', {
      commands: opened,
      threads: client.getState().sessions[sessionId]?.threadIds.length,
      title: client.getState().sessions[sessionId]?.title,
    })
    expect(opened).toContain('session.open')
    expect(frames.some((frame) => frame.name === 'session.history')).toBe(false)

    // ---- background, and back --------------------------------------------
    const socketsBefore = socketCount
    activity.set('background')
    await until('held', () => controller.getState().status === 'held')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    note('held.quiet', {
      newSockets: socketCount - socketsBefore,
      status: controller.getState().status,
    })
    expect(socketCount).toBe(socketsBefore)
    const back = Date.now()
    activity.set('active')
    await until('connected after foreground', () => controller.getState().status === 'connected')
    note('foreground.reconnected', {
      ms: Date.now() - back,
      sameClient: controller.getState().client === client,
      sessionStillThere: Boolean(client.getState().sessions[sessionId]),
    })
    expect(controller.getState().client).toBe(client)

    // ---- the network goes, and comes back --------------------------------
    network.set({ online: false })
    await until('offline', () => controller.getState().status === 'offline')
    const online = Date.now()
    network.set({ online: true })
    await until('connected after network', () => controller.getState().status === 'connected')
    note('network.reconnected', { ms: Date.now() - online })

    // ---- the owner revokes the phone: one 4401, then nothing --------------
    await owner.commands.revokeAuthorizedClient(paired.clientId)
    await until('unauthorized', () => controller.getState().status === 'unauthorized')
    const socketsAtRevoke = socketCount
    activity.set('background')
    activity.set('active')
    network.set({ online: false })
    network.set({ online: true })
    await new Promise((resolve) => setTimeout(resolve, 5000))
    note('revoked.latched', {
      status: controller.getState().status,
      routeFailure: controller.getState().routeFailure,
      newSockets: socketCount - socketsAtRevoke,
    })
    expect(controller.getState().status).toBe('unauthorized')
    expect(socketCount).toBe(socketsAtRevoke)
  })
})
