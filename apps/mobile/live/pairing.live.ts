import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, connect as connectTcp, type Server } from 'node:net'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createWebSocketEnvironmentClient,
  encodePairingLink,
  type WebSocketConstructor,
} from '@openmanager/environment-client'
import {
  createPhoneConnectionController,
  type AppActivity,
  type PhoneNetwork,
} from '../src/environment/controller'
import { connectedRoute, environmentLine } from '../src/environment/connected-route'
import type { NativeWebSocketConstructor } from '../src/environment/app-origin'
import { describePairingFailure } from '../src/pairing/failures'
import {
  checkNewRoute,
  exchangeLink,
  joinRoute,
  planPairing,
  redeemLink,
  type PairingController,
} from '../src/pairing/flow'
import { readPairingLink } from '../src/pairing/link'
import { createSource, relaunchedStorage } from '../tests/support'

/**
 * The phone's pairing core, end to end, against a real environment server:
 * the owner makes links the way web's Pair-device dialog does (its own origin,
 * `/pair`, the payload in the fragment), and the phone reads each with the
 * shared parser, plans, exchanges or redeems, stores through its real storage
 * adapter, and connects with the link's app origin. Then the refusals: a used
 * link, a withdrawn one, an address that answers as another environment, an
 * address nothing answers at, and (with LIVE_EXPIRE=1) an expired link.
 *
 * LIVE_SERVER   the server's loopback URL, e.g. http://127.0.0.1:43260
 * LIVE_LAN      the phone's route, e.g. http://192.168.1.4:43261 (forwarded here)
 * LIVE_DATA_DIR the server's data directory (for its owner credential)
 * LIVE_APP_ORIGIN the web app's origin, as the server's --allowed-origin lists it
 * LIVE_OUT      where to write the JSON record
 * LIVE_EXPIRE   "1" to also wait out a link's five minutes
 */
vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }))

const SERVER = process.env.LIVE_SERVER ?? 'http://127.0.0.1:43260'
const LAN = process.env.LIVE_LAN ?? 'http://192.168.1.4:43261'
const DATA_DIR = process.env.LIVE_DATA_DIR ?? ''
const APP_ORIGIN = process.env.LIVE_APP_ORIGIN ?? 'https://app.example.test'
const OUT = process.env.LIVE_OUT
const EXPIRE = process.env.LIVE_EXPIRE === '1'
const DEAD = 'http://127.0.0.1:43269'

const started = Date.now()
const record: Array<Record<string, unknown>> = []
const note = (event: string, detail: Record<string, unknown> = {}) => {
  const entry = { t: Date.now() - started, event, ...detail }
  record.push(entry)
  console.log(JSON.stringify(entry))
}
const redact = (link: string) => link.replace(/token=[^&]+/, 'token=<token>')

const NodeWebSocket = globalThis.WebSocket
const dials: Array<{ url: string; origin: string; from: string }> = []
const opens: string[] = []

/** Node's WebSocket with React Native's constructor and Origin rule. */
class PhoneWebSocket extends NodeWebSocket {
  constructor(
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    const parsed = new URL(url)
    const fallback = `${parsed.protocol === 'wss:' ? 'https' : 'http'}://${parsed.host}`
    const origin = options?.headers?.origin ?? fallback
    super(url, { protocols, headers: { ...options?.headers, origin } } as never)
    dials.push({ url, origin, from: options?.headers?.origin ? 'headers.origin' : 'dialled URL' })
    this.addEventListener('open', () => opens.push(url))
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
  if (OUT) writeFileSync(OUT, JSON.stringify({ record, dials, opens }, null, 2))
})

/** A phone on a first launch: its real storage adapter over in-memory stores. */
function freshPhone() {
  const storage = relaunchedStorage({ selectedId: null, environments: [] })
  const warnings: string[] = []
  const controller = createPhoneConnectionController({
    storage,
    activity: createSource<AppActivity>('active'),
    network: createSource<PhoneNetwork>({ online: true }),
    transport: {
      WebSocket: PhoneWebSocket as unknown as NativeWebSocketConstructor,
      fetch: globalThis.fetch,
      requestId: () => globalThis.crypto.randomUUID(),
    },
    warn: (message) => warnings.push(message),
  })
  cleanups.push(() => controller.dispose())
  return { storage, controller, warnings }
}

describe('phone pairing, live', () => {
  it(
    'pairs by link, stores the app origin, connects with it, and words every refusal',
    { timeout: 420_000 },
    async () => {
      const lan = new URL(LAN)
      const server = new URL(SERVER)
      forwarder = createServer((inbound) => {
        const outbound = connectTcp(Number(server.port), server.hostname)
        inbound.pipe(outbound).pipe(inbound)
        inbound.on('error', () => outbound.destroy())
        outbound.on('error', () => inbound.destroy())
      })
      await new Promise<void>((resolve) => forwarder!.listen(Number(lan.port), '0.0.0.0', resolve))
      note('forwarder.listening', { from: `0.0.0.0:${lan.port}`, to: server.host })

      // ---- the owner, as web's Devices page ---------------------------------
      const ownerCredential = readFileSync(join(DATA_DIR, 'owner-credential'), 'utf8').trim()
      const owner = createWebSocketEnvironmentClient({
        url: `${SERVER.replace('http:', 'ws:')}/ws`,
        credential: ownerCredential,
        WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
      })
      cleanups.push(() => owner.dispose())
      owner.connect()
      await until('owner connected', () => owner.getState().connection.phase === 'connected')
      const environmentId = owner.getState().environment!.environmentId
      /** A link the way the dialog builds one, under the web app's origin. */
      const makeLink = async (route: string, options: { environmentId?: string } = {}) => {
        const made = await owner.commands.createPairingLink({
          capabilities: ['read', 'operate', 'agent'],
          label: null,
        })
        return {
          linkId: made.link.linkId,
          url: encodePairingLink(`${APP_ORIGIN}/`, {
            route,
            environmentId: options.environmentId ?? environmentId,
            token: made.token,
          }),
        }
      }
      const expiring = EXPIRE ? await makeLink(LAN) : null
      const expiringAt = Date.now()

      // ---- a fresh install pairs by link --------------------------------------
      const phone = freshPhone()
      await phone.controller.start()
      expect(phone.controller.getState().status).toBe('no_environment')
      const first = await makeLink(LAN)
      const read = readPairingLink(first.url)
      if (!read.ok) throw new Error('link did not read')
      note('link.read', {
        link: redact(first.url),
        route: read.link.payload.route,
        appOrigin: read.link.appOrigin,
      })
      const plan = planPairing(read.link, phone.controller)
      note('plan', { plan })
      expect(plan).toEqual({ kind: 'exchange' })
      const result = await exchangeLink(
        read.link,
        { label: 'Pixel 9 (live)' },
        phone.controller,
        fetch,
      )
      note('exchanged', { result })
      expect(result).toMatchObject({ ok: true, paired: { how: 'exchanged', environmentId } })
      await phone.controller.flush()
      const saved = phone.storage.document()?.environments[0]
      const token = phone.storage.secret(environmentId)
      note('stored', {
        environmentId: saved?.environmentId,
        label: saved?.label,
        routes: saved?.routes.map((route) => route.endpoint),
        appOrigin: saved?.appOrigin ?? null,
        secureStoreHasToken: Boolean(token),
        asyncStorageHasToken: token
          ? JSON.stringify(phone.storage.asyncStore.dump()).includes(token)
          : null,
        asyncStorageKeys: Object.keys(phone.storage.asyncStore.dump()),
      })
      expect(saved?.appOrigin).toBe(APP_ORIGIN)
      expect(token).toBeTruthy()

      await until('connected', () => phone.controller.getState().status === 'connected')
      const state = phone.controller.getState()
      note('connected', {
        status: state.status,
        endpoint: state.endpoint,
        socketOrigin: state.socketOrigin,
        route: connectedRoute(state),
        environmentLine: environmentLine(state),
        dials: dials.length,
        opens: opens.length,
        warnings: phone.warnings,
      })
      expect(state.socketOrigin).toEqual({ origin: APP_ORIGIN, from: 'app' })
      expect(opens.length).toBeGreaterThan(0)
      expect(phone.warnings).toEqual([])

      const clients = await owner.commands.listAuthorizedClients()
      const listed = clients.clients.find((client) => client.label === 'Pixel 9 (live)')
      note('devices.page', {
        labels: clients.clients.map((client) => `${client.label} (${client.kind})`),
        phoneListed: Boolean(listed),
      })
      expect(listed).toBeTruthy()

      // ---- the same link again, from another fresh install: used ---------------
      const other = freshPhone()
      await other.controller.start()
      const used = await exchangeLink(read.link, {}, other.controller, fetch)
      note('refused.used', {
        result: used,
        words: used.ok ? null : describePairingFailure(used.failure),
      })
      expect(used).toEqual({ ok: false, failure: { kind: 'rejected', reason: 'used' } })

      // ---- a withdrawn link: invalid -----------------------------------------
      const withdrawn = await makeLink(LAN)
      await owner.commands.revokePairingLink(withdrawn.linkId)
      const withdrawnRead = readPairingLink(withdrawn.url)
      if (!withdrawnRead.ok) throw new Error('link did not read')
      const invalid = await exchangeLink(withdrawnRead.link, {}, other.controller, fetch)
      note('refused.withdrawn', {
        result: invalid,
        words: invalid.ok ? null : describePairingFailure(invalid.failure),
      })
      expect(invalid).toEqual({ ok: false, failure: { kind: 'rejected', reason: 'invalid' } })

      // ---- a link naming another environment than its route answers as --------
      const forged = await makeLink(LAN, { environmentId: 'env-somewhere-else' })
      const forgedRead = readPairingLink(forged.url)
      if (!forgedRead.ok) throw new Error('link did not read')
      const mismatch = await exchangeLink(forgedRead.link, {}, other.controller, fetch)
      await other.controller.flush()
      note('refused.mismatch', {
        result: mismatch,
        words: mismatch.ok ? null : describePairingFailure(mismatch.failure),
        saved: other.controller.getState().environments.length,
      })
      expect(mismatch).toEqual({ ok: false, failure: { kind: 'environment_mismatch', route: LAN } })
      expect(other.controller.getState().environments).toEqual([])

      // ---- an address nothing answers at ---------------------------------------
      const dead = await makeLink(DEAD)
      const deadRead = readPairingLink(dead.url)
      if (!deadRead.ok) throw new Error('link did not read')
      const unreachable = await exchangeLink(deadRead.link, {}, other.controller, fetch)
      note('refused.unreachable', {
        result: unreachable,
        words: unreachable.ok ? null : describePairingFailure(unreachable.failure),
      })
      expect(unreachable).toEqual({ ok: false, failure: { kind: 'unreachable', route: DEAD } })

      // ---- the paired phone scans a link with a new address: consent, then redeem
      const loopbackLink = await makeLink(SERVER)
      const loopbackRead = readPairingLink(loopbackLink.url)
      if (!loopbackRead.ok) throw new Error('link did not read')
      const consent = planPairing(loopbackRead.link, phone.controller)
      note('plan.known_environment_new_address', { plan: consent })
      expect(consent).toMatchObject({ kind: 'consent', route: SERVER })
      const checked = await checkNewRoute(loopbackRead.link, phone.controller)
      note('consent.check', { checked })
      expect(checked).toEqual({ ok: true })
      const routesBefore = phone.storage.document()?.environments[0]?.routes.map((r) => r.endpoint)
      expect(joinRoute(loopbackRead.link, phone.controller as PairingController)).toBe(true)
      await phone.controller.flush()
      const routesAfter = phone.storage.document()?.environments[0]?.routes.map((r) => r.endpoint)
      const redeemed = await redeemLink(loopbackRead.link, phone.controller)
      note('redeemed', { routesBefore, routesAfter, result: redeemed })
      expect(redeemed).toMatchObject({ ok: true, paired: { how: 'redeemed' } })
      expect(routesAfter).toEqual([LAN, SERVER])

      // ---- a known address: redeemed over the phone's socket, same link twice --
      const again = await makeLink(LAN)
      const againRead = readPairingLink(again.url)
      if (!againRead.ok) throw new Error('link did not read')
      expect(planPairing(againRead.link, phone.controller)).toMatchObject({ kind: 'redeem' })
      const once = await redeemLink(againRead.link, phone.controller)
      const twice = await redeemLink(againRead.link, phone.controller)
      note('redeem.twice', {
        once,
        twice,
        words: twice.ok ? null : describePairingFailure(twice.failure),
      })
      expect(once.ok).toBe(true)
      expect(twice).toEqual({ ok: false, failure: { kind: 'rejected', reason: 'used' } })

      // ---- an expired link ----------------------------------------------------
      if (expiring) {
        const wait = Math.max(0, expiringAt + 5 * 60_000 + 2_000 - Date.now())
        note('expiry.wait', { ms: wait })
        await new Promise((resolve) => setTimeout(resolve, wait))
        const expiredRead = readPairingLink(expiring.url)
        if (!expiredRead.ok) throw new Error('link did not read')
        const expired = await exchangeLink(expiredRead.link, {}, other.controller, fetch)
        note('refused.expired', {
          result: expired,
          words: expired.ok ? null : describePairingFailure(expired.failure),
        })
        expect(expired).toEqual({ ok: false, failure: { kind: 'rejected', reason: 'expired' } })
      }
      note('done', { dials: dials.length, opens: opens.length })
    },
  )
})
