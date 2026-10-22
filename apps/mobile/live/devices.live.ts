import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createWebSocketEnvironmentClient,
  encodePairingLink,
  type WebSocketConstructor,
} from '@openmanager/environment-client'
import { fetchBootstrap, noLoopbackGate } from '@openmanager/environment-client/connection'
import {
  createPhoneConnectionController,
  type AppActivity,
  type PhoneConnectionController,
  type PhoneNetwork,
} from '../src/environment/controller'
import type { NativeWebSocketConstructor } from '../src/environment/app-origin'
import { exchangeLink } from '../src/pairing/flow'
import { readPairingLink } from '../src/pairing/link'
import { qrMatrix } from '../src/pairing/qr'
import { createDeviceAdmin } from '../src/settings/device-admin'
import { deviceRows, pairingGrant, revocableOthers } from '../src/settings/devices'
import { createSource, relaunchedStorage } from '../tests/support'

/**
 * Settings → Devices against a real environment server, from the phone's
 * side: the phone pairs with Manage access, then reads the device list over
 * its own client with the same store the environment page uses, and renames,
 * revokes and revokes the others while the list follows the environment's
 * pushes. A second and third "phone" (each its own controller and storage)
 * pair along the way; one of them pairs from a link the first phone made,
 * through the shared link encoding its QR code carries. The revoked ones are
 * then refused at their next connect.
 *
 * The server is this test's own child on a side port with a fresh data
 * directory; nothing in it is changed.
 *
 * Run: LIVE_DATA_DIR=<fresh dir> LIVE_OUT=<file.json> pnpm --filter
 * @openmanager/mobile test:live live/devices.live.ts
 *
 * LIVE_SERVER_MAIN  the server entry, e.g. ../server/src/main.ts
 * LIVE_PORT         the server's side port (default 43440)
 * LIVE_DATA_DIR     a fresh data directory for the server
 * LIVE_OUT          where to write the JSON record
 */
vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }))

const MAIN = process.env.LIVE_SERVER_MAIN ?? '../server/src/main.ts'
const PORT = Number(process.env.LIVE_PORT ?? 43440)
const DATA_DIR = process.env.LIVE_DATA_DIR ?? ''
const OUT = process.env.LIVE_OUT
const APP_ORIGIN = 'https://app.example.test'
const SERVER = `http://127.0.0.1:${PORT}`

const started = Date.now()
const record: Array<Record<string, unknown>> = []
const note = (event: string, detail: Record<string, unknown> = {}) => {
  const entry = { t: Date.now() - started, event, ...detail }
  record.push(entry)
  console.log(JSON.stringify(entry))
}

const NodeWebSocket = globalThis.WebSocket
class PhoneWebSocket extends NodeWebSocket {
  constructor(
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    super(url, { protocols, headers: { ...options?.headers } } as never)
  }
}

let child: ChildProcess | null = null
function startServer() {
  mkdirSync(DATA_DIR, { recursive: true })
  const log = openSync(join(DATA_DIR, '..', 'devices-server.log'), 'a')
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
      `127.0.0.1:${PORT}`,
      '--exit-with-parent',
    ],
    { stdio: ['ignore', log, log] },
  )
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

async function until(label: string, read: () => boolean, timeoutMs = 60_000): Promise<number> {
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
  const running = child
  child = null
  if (running && running.exitCode === null) {
    await new Promise<void>((done) => {
      running.once('exit', () => done())
      running.kill()
    })
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ record }, null, 2))
})

function phone(name: string): PhoneConnectionController {
  const controller = createPhoneConnectionController({
    storage: relaunchedStorage({ selectedId: null, environments: [] }),
    activity: createSource<AppActivity>('active'),
    network: createSource<PhoneNetwork>({ online: true }),
    transport: {
      WebSocket: PhoneWebSocket as unknown as NativeWebSocketConstructor,
      fetch: globalThis.fetch,
      requestId: () => globalThis.crypto.randomUUID(),
    },
    probe: (endpoint, signal) =>
      fetchBootstrap(endpoint, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
        loopbackAccessDenied: noLoopbackGate,
      }),
    warn: (message) => note('warn', { name, message }),
  })
  cleanups.push(() => controller.dispose())
  return controller
}

async function pair(controller: PhoneConnectionController, link: string, label: string) {
  await controller.start()
  const read = readPairingLink(link)
  if (!read.ok) throw new Error('link did not read')
  const paired = await exchangeLink(read.link, { label }, controller, globalThis.fetch)
  expect(paired).toMatchObject({ ok: true })
  await until(`${label} connected`, () => controller.getState().status === 'connected')
}

describe('devices from the phone, live', () => {
  it(
    'lists, renames, revokes and pairs from the phone, following the environment live',
    { timeout: 300_000 },
    async () => {
      startServer()
      await serverUp()

      // ---- the owner makes the first phone's link, with Manage access ------
      const owner = createWebSocketEnvironmentClient({
        url: `${SERVER.replace('http:', 'ws:')}/ws`,
        credential: readFileSync(join(DATA_DIR, 'owner-credential'), 'utf8').trim(),
        WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
      })
      cleanups.push(() => owner.dispose())
      owner.connect()
      await until('owner', () => owner.getState().connection.phase === 'connected')
      const environmentId = owner.getState().environment!.environmentId
      const ownerLink = async (capabilities: Parameters<typeof pairingGrant>[2]) => {
        const made = await owner.commands.createPairingLink({ capabilities: [...capabilities] })
        return encodePairingLink(`${APP_ORIGIN}/`, {
          route: SERVER,
          environmentId,
          token: made.token,
        })
      }

      const first = phone('first')
      await pair(first, await ownerLink(['read', 'operate', 'agent', 'admin']), 'Live phone')
      const client = first.getState().client!
      const admin = createDeviceAdmin(client, environmentId)
      cleanups.push(() => admin.dispose())
      admin.start()
      await until('the list', () => admin.getState().list !== null)
      const labels = () => admin.getState().list?.clients.map((item) => item.label) ?? []
      note('listed', { labels: labels(), access: admin.getState().access })
      const rows = deviceRows(admin.getState().list!, Date.now(), { canKeepCredential: true })
      const me = rows.find((row) => row.isCurrent)!
      expect(me.label).toBe('Live phone')
      expect(rows.find((row) => row.kind === 'owner')).toMatchObject({
        canRevoke: false,
        canRename: false,
        canRotate: false,
      })

      // ---- a second phone pairs from the owner's link: it appears live ------
      const second = phone('second')
      let pushed = Date.now()
      await pair(second, await ownerLink(['read']), 'Second phone')
      const appearedIn = await until('the second phone in the list', () =>
        labels().includes('Second phone'),
      )
      pushed = Date.now() - pushed
      note('appeared', { labels: labels(), afterPairMs: appearedIn, sincePairStartMs: pushed })
      const secondId = admin
        .getState()
        .list!.clients.find((item) => item.label === 'Second phone')!.clientId

      // ---- rename it from the phone ----------------------------------------
      expect(await admin.rename(secondId, 'Kitchen tablet')).toBe(true)
      await until('the new name', () => labels().includes('Kitchen tablet'))
      // The owner's own client hears the same list.
      const ownerList = await owner.commands.listAuthorizedClients()
      expect(ownerList.clients.map((item) => item.label)).toContain('Kitchen tablet')
      note('renamed', { labels: labels() })

      // ---- the first phone makes a link; a third phone pairs from it --------
      const held = admin.getState().list!.clients.find((item) => item.clientId === me.clientId)!
      const grant = pairingGrant('view', false, held.capabilities)
      const shown = await admin.createLink({
        capabilities: grant,
        route: SERVER,
        appUrl: APP_ORIGIN,
      })
      expect(shown).not.toBeNull()
      const qr = qrMatrix(shown!.url)
      note('link.made', { qrModules: qr.size, waiting: shown!.link.status })
      await until('the link listed', () =>
        (admin.getState().links ?? []).some((link) => link.linkId === shown!.link.linkId),
      )
      const third = phone('third')
      await pair(third, shown!.url, 'Third phone')
      await until('the link used', () =>
        (admin.getState().links ?? []).some(
          (link) => link.linkId === shown!.link.linkId && link.status === 'used',
        ),
      )
      await until('the third phone in the list', () => labels().includes('Third phone'))
      note('link.used', { labels: labels(), madeStillHeld: admin.madeLink(shown!.link.linkId) })
      expect(admin.madeLink(shown!.link.linkId)).toBeUndefined()

      // A link made and withdrawn: the environment then reports it revoked.
      const spare = await admin.createLink({
        capabilities: ['read'],
        route: SERVER,
        appUrl: APP_ORIGIN,
      })
      expect(await admin.revokeLink(spare!.link.linkId)).toBe(true)
      await until('the spare withdrawn', () =>
        (admin.getState().links ?? []).some(
          (link) => link.linkId === spare!.link.linkId && link.status === 'revoked',
        ),
      )

      // ---- revoke the kitchen tablet: gone from the list, refused next time -
      expect(await admin.revoke(secondId)).toBe(true)
      await until('the tablet gone', () => !labels().includes('Kitchen tablet'))
      await until('the tablet signed out', () => second.getState().status === 'unauthorized')
      note('revoked', { labels: labels(), second: second.getState().status })

      // ---- revoke the others: only the owner and this phone stay ------------
      expect(revocableOthers(admin.getState().list!)).toBe(1)
      expect(await admin.revokeOthers()).toBe(true)
      await until('only the owner and this phone', () => labels().length === 2)
      await until('the third phone signed out', () => third.getState().status === 'unauthorized')
      note('revoked_others', { labels: labels(), third: third.getState().status })
      expect(first.getState().status).toBe('connected')

      // ---- the phone cannot rotate the owner's credential -------------------
      expect(await admin.rotate()).toBeNull()
      note('rotate.refused', { error: admin.getState().actionError })
    },
  )
})
