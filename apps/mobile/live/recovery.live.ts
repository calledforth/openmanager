import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createWebSocketEnvironmentClient,
  encodePairingLink,
  type WebSocketConstructor,
} from '@openmanager/environment-client'
import { fetchBootstrap, noLoopbackGate } from '@openmanager/environment-client/connection'
import { phoneConnectionView } from '../src/environment/connection-ui'
import {
  createPhoneConnectionController,
  type AppActivity,
  type PhoneConnectionController,
  type PhoneNetwork,
} from '../src/environment/controller'
import type { NativeWebSocketConstructor } from '../src/environment/app-origin'
import { exchangeLink } from '../src/pairing/flow'
import { readPairingLink } from '../src/pairing/link'
import { createSource, relaunchedStorage } from '../tests/support'

/**
 * The recovery matrix against a real environment server, with the phone's
 * real controller, client and storage: airplane mode on and off, leaving the
 * LAN for the tunnel, the tunnel going down and coming back, and the server
 * restarting, then the owner revoking the phone and the phone pairing again.
 * Between pairing and the revocation nothing calls the controller: only the
 * phone's network input, the routes and the server change.
 *
 * The server is this test's own child, started with its CLI flags on a side
 * port; nothing in it is changed. In front of it sit two forwarders the test
 * can switch: the LAN route, under a private address (`192.168.250.250`, so
 * the phone asks it first, as it would a computer on its Wi-Fi), and the
 * tunnel route under a public-looking name, `tunnel.example.test`. The
 * phone's probe, pairing exchange and socket dial both at 127.0.0.1: the only
 * thing faked is those two names' lookup. Down means refused; the tunnel can
 * also answer like Cloudflare's edge with no connector running (HTTP 530).
 *
 * Run: LIVE_DATA_DIR=<fresh dir> LIVE_OUT=<file.json> pnpm --filter
 * @openmanager/mobile test:live live/recovery.live.ts
 *
 * LIVE_SERVER_MAIN  the server entry, e.g. ../server/src/main.ts
 * LIVE_PORT         the server's side port (default 43420); the forwarders use +1 and +2
 * LIVE_DATA_DIR     a fresh data directory for the server
 * LIVE_OUT          where to write the JSON record
 */
vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }))

const MAIN = process.env.LIVE_SERVER_MAIN ?? '../server/src/main.ts'
const PORT = Number(process.env.LIVE_PORT ?? 43420)
const LAN_PORT = PORT + 1
const TUNNEL_PORT = PORT + 2
const DATA_DIR = process.env.LIVE_DATA_DIR ?? ''
const OUT = process.env.LIVE_OUT
const APP_ORIGIN = 'https://app.example.test'
const SERVER = `http://127.0.0.1:${PORT}`
const LAN_HOST = '192.168.250.250'
const LAN = `http://${LAN_HOST}:${LAN_PORT}`
const TUNNEL_HOST = 'tunnel.example.test'
const TUNNEL = `http://${TUNNEL_HOST}:${TUNNEL_PORT}`

const started = Date.now()
const record: Array<Record<string, unknown>> = []
const note = (event: string, detail: Record<string, unknown> = {}) => {
  const entry = { t: Date.now() - started, event, ...detail }
  record.push(entry)
  console.log(JSON.stringify(entry))
}

/** The two routes' names, looked up as the phone's resolver would: here, 127.0.0.1. */
const resolve = (url: string) =>
  url.replace(`//${TUNNEL_HOST}:`, '//127.0.0.1:').replace(`//${LAN_HOST}:`, '//127.0.0.1:')
const phoneFetch: typeof fetch = (input, init) =>
  fetch(resolve(typeof input === 'string' ? input : String(input)), init)

const NodeWebSocket = globalThis.WebSocket
const dials: string[] = []
/** Node's WebSocket with React Native's constructor and Origin rule, and the tunnel's lookup. */
class PhoneWebSocket extends NodeWebSocket {
  constructor(
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    super(resolve(url), { protocols, headers: { ...options?.headers } } as never)
    dials.push(url)
  }
}

type Mode = 'pass' | 'down' | '530'

/** A forwarder to the server, with a switch. Taking a route away closes its open sockets. */
async function forwarder(port: number) {
  let mode: Mode = 'pass'
  const live = new Set<{ inbound: Socket; outbound: Socket }>()
  const server: Server = createServer((req, res) => {
    if (mode === 'down') return req.socket.destroy()
    if (mode === '530') {
      res.writeHead(530, { 'content-type': 'text/html' })
      return res.end('<h1>Error 1033</h1>')
    }
    const upstream = httpRequest(
      { host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  server.on('upgrade', (req, inbound: Socket, head: Buffer) => {
    if (mode !== 'pass') return inbound.destroy()
    const outbound = connectTcp(PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      outbound.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) outbound.write(head)
      inbound.pipe(outbound).pipe(inbound)
    })
    const pair = { inbound, outbound }
    live.add(pair)
    const end = () => {
      live.delete(pair)
      inbound.destroy()
      outbound.destroy()
    }
    for (const socket of [inbound, outbound]) {
      socket.on('error', end)
      socket.on('close', end)
    }
  })
  server.keepAliveTimeout = 1
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
  return {
    set(next: Mode) {
      mode = next
      if (next !== 'pass') {
        for (const pair of [...live]) {
          pair.inbound.destroy()
          pair.outbound.destroy()
        }
      }
      server.closeIdleConnections()
      note('route', { port, mode: next })
    },
    close: () =>
      new Promise<void>((done) => {
        for (const pair of live) {
          pair.inbound.destroy()
          pair.outbound.destroy()
        }
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

let child: ChildProcess | null = null
function startServer() {
  mkdirSync(DATA_DIR, { recursive: true })
  const log = openSync(join(DATA_DIR, '..', 'recovery-server.log'), 'a')
  child = spawn(
    process.execPath,
    [
      MAIN,
      '--port',
      String(PORT),
      '--data-dir',
      DATA_DIR,
      '--allowed-origin',
      APP_ORIGIN,
      '--allowed-host',
      `127.0.0.1:${LAN_PORT}`,
      '--allowed-host',
      `${LAN_HOST}:${LAN_PORT}`,
      '--allowed-host',
      `${TUNNEL_HOST}:${TUNNEL_PORT}`,
      '--allowed-host',
      `127.0.0.1:${TUNNEL_PORT}`,
      '--exit-with-parent',
    ],
    { stdio: ['ignore', log, log] },
  )
  note('server.spawned', { pid: child.pid })
}
async function serverUp() {
  for (let i = 0; i < 400; i += 1) {
    try {
      if ((await fetch(`${SERVER}/health`)).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('The server did not start')
}
function stopServer() {
  const running = child
  child = null
  if (!running || running.exitCode !== null) return Promise.resolve()
  return new Promise<void>((done) => {
    running.once('exit', () => done())
    running.kill()
  })
}

async function until(label: string, read: () => boolean, timeoutMs = 90_000): Promise<number> {
  const from = Date.now()
  while (!read()) {
    if (Date.now() - from > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((done) => setTimeout(done, 25))
  }
  return Date.now() - from
}

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await stopServer()
  if (OUT) writeFileSync(OUT, JSON.stringify({ record, dials }, null, 2))
})

describe('connection recovery, live', () => {
  it(
    'recovers from airplane mode, LAN to tunnel, tunnel down and up, and a server restart',
    { timeout: 600_000 },
    async () => {
      startServer()
      await serverUp()
      const lan = await forwarder(LAN_PORT)
      const tunnel = await forwarder(TUNNEL_PORT)
      cleanups.push(lan.close, tunnel.close)

      // ---- the owner, as web's Pair-device dialog and Devices page are ------
      const ownerClient = async () => {
        const owner = createWebSocketEnvironmentClient({
          url: `${SERVER.replace('http:', 'ws:')}/ws`,
          credential: readFileSync(join(DATA_DIR, 'owner-credential'), 'utf8').trim(),
          WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
        })
        cleanups.push(() => owner.dispose())
        owner.connect()
        await until('owner', () => owner.getState().connection.phase === 'connected')
        return owner
      }
      const link = async (
        owner: Awaited<ReturnType<typeof ownerClient>>,
        environmentId: string,
        route: string,
      ) => {
        const made = await owner.commands.createPairingLink({
          capabilities: ['read', 'operate', 'agent'],
          label: null,
        })
        return encodePairingLink(`${APP_ORIGIN}/`, { route, environmentId, token: made.token })
      }
      const firstOwner = await ownerClient()
      const environmentId = firstOwner.getState().environment!.environmentId
      const lanLink = await link(firstOwner, environmentId, LAN)
      firstOwner.dispose()

      // ---- the phone pairs over the LAN, then the tunnel joins as a route ----
      const network = createSource<PhoneNetwork>({ online: true })
      const storage = relaunchedStorage({ selectedId: null, environments: [] })
      const phone: PhoneConnectionController = createPhoneConnectionController({
        storage,
        activity: createSource<AppActivity>('active'),
        network,
        transport: {
          WebSocket: PhoneWebSocket as unknown as NativeWebSocketConstructor,
          fetch: phoneFetch,
          requestId: () => globalThis.crypto.randomUUID(),
        },
        probe: (endpoint, signal) =>
          fetchBootstrap(resolve(endpoint), {
            signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
            loopbackAccessDenied: noLoopbackGate,
          }),
        warn: (message) => note('warn', { message }),
      })
      cleanups.push(() => phone.dispose())
      const states: string[] = []
      phone.subscribe(() => {
        const state = phone.getState()
        const view = phoneConnectionView(state)
        const line = `${state.status}|${view.ui.kind}|${view.ui.title}|${state.endpoint ?? ''}`
        if (states.at(-1) !== line) {
          states.push(line)
          note('state', {
            status: state.status,
            kind: view.ui.kind,
            title: view.ui.title,
            detail: view.ui.detail ?? null,
            endpoint: state.endpoint,
            retryAt: state.retryAt ? state.retryAt - Date.now() : null,
          })
        }
      })
      await phone.start()
      const read = readPairingLink(lanLink)
      if (!read.ok) throw new Error('link did not read')
      const paired = await exchangeLink(read.link, { label: 'Recovery phone' }, phone, phoneFetch)
      expect(paired).toMatchObject({ ok: true })
      const connected = (endpoint: string) => () =>
        phone.getState().status === 'connected' && phone.getState().endpoint === endpoint
      await until('connected over the LAN', connected(LAN))
      // The tunnel joins as the person agreed in the consent sheet.
      expect(phone.addRoute({ environmentId, endpoint: TUNNEL })).toBe(true)
      await until('connected over the LAN again', connected(LAN))
      note('paired', { routes: phone.getState().environments[0]!.routes.map((r) => r.endpoint) })
      // Past the controller's stable mark, so a drop starts over at once.
      await new Promise((done) => setTimeout(done, 11_000))
      const results: Record<string, number> = {}

      // ---- airplane mode ------------------------------------------------------
      network.set({ online: false })
      await until('offline', () => phone.getState().status === 'offline')
      const offline = phoneConnectionView(phone.getState())
      expect(offline.ui.title).toBe("You're offline")
      expect(offline.next).toEqual(['network_settings'])
      await new Promise((done) => setTimeout(done, 3000))
      network.set({ online: true })
      results.airplane = await until('back after airplane mode', connected(LAN))
      await new Promise((done) => setTimeout(done, 11_000))

      // ---- leaving the LAN ----------------------------------------------------
      lan.set('down')
      results.lanToTunnel = await until('over the tunnel', connected(TUNNEL))
      await new Promise((done) => setTimeout(done, 11_000))

      // ---- the tunnel goes down, then comes back --------------------------------
      tunnel.set('530')
      await until('waiting', () => phone.getState().status === 'waiting')
      const down = phoneConnectionView(phone.getState())
      note('tunnel.down', { reason: down.ui.reason, detail: down.ui.detail, next: down.next })
      expect(down.ui).toMatchObject({ kind: 'unreachable', reason: 'tunnel_down', retrying: true })
      expect(down.retryAt).not.toBeNull()
      expect(down.next[0]).toBe('retry')
      await new Promise((done) => setTimeout(done, 5000))
      tunnel.set('pass')
      results.tunnelBack = await until('tunnel back', connected(TUNNEL))
      lan.set('pass')
      await new Promise((done) => setTimeout(done, 11_000))

      // ---- the server restarts ------------------------------------------------
      await stopServer()
      await until('server gone', () => ['waiting', 'searching'].includes(phone.getState().status))
      const gone = phoneConnectionView(phone.getState())
      note('server.down', { kind: gone.ui.kind, detail: gone.ui.detail })
      startServer()
      await serverUp()
      results.serverRestart = await until(
        'back after the restart',
        () => phone.getState().status === 'connected',
      )
      await new Promise((done) => setTimeout(done, 2000))

      // ---- the owner revokes the phone: refused, and pairing is the way back --
      const owner = await ownerClient()
      await owner.commands.revokeOtherAuthorizedClients()
      await until('unauthorized', () => phone.getState().status === 'unauthorized')
      const refused = phoneConnectionView(phone.getState())
      note('revoked', { kind: refused.ui.kind, title: refused.ui.title, next: refused.next })
      expect(refused.ui.kind).toBe('unauthorized')
      expect(refused.next[0]).toBe('pair_again')
      const again = readPairingLink(await link(owner, environmentId, LAN))
      if (!again.ok) throw new Error('link did not read')
      const from = Date.now()
      const repaired = await exchangeLink(
        again.link,
        { label: 'Recovery phone' },
        phone,
        phoneFetch,
      )
      expect(repaired).toMatchObject({ ok: true })
      await until('connected after pairing again', () => phone.getState().status === 'connected')
      results.pairAgain = Date.now() - from
      note('results', { results, finalEndpoint: phone.getState().endpoint })
    },
  )
})
