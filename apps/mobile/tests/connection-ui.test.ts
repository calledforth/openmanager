import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { describe, expect, it } from 'vitest'
import type { BootstrapOutcome } from '@openmanager/environment-client/connection'

import {
  NEXT_STEP_LABELS,
  phoneConnectionInput,
  phoneConnectionView,
  retryCountdownWords,
} from '../src/environment/connection-ui'
import { PHONE_SOCKET_FAILURE_COOLDOWN_MS } from '../src/environment/controller'
import {
  ROUTE_ORDER_NOTE,
  environmentCards,
  pageStatusWords,
  routeRows,
  shortConnectionWords,
} from '../src/settings/environments'
import { LAN, OTHER_ENV, TUNNEL, flush, harness, ready, registryWith, silent } from './support'

type Harness = ReturnType<typeof harness>
const view = (h: Harness) => phoneConnectionView(h.state())

async function connect(h: Harness) {
  await h.controller.start()
  await flush()
  h.socket().accept()
  await flush()
  expect(h.state().status).toBe('connected')
}

/**
 * Every state the phone can be in, through the real controller and the real
 * client over fake sockets, read through the shared derivation: each has its
 * own words and its own next step.
 */
describe('connection states in the shared words', () => {
  it('no environment saved: pair with a computer', async () => {
    const h = harness({ registry: { selectedId: null, environments: [] } })
    await h.controller.start()
    await flush()
    const v = view(h)
    expect(v.ui).toMatchObject({ kind: 'no_environment', title: 'No environment configured' })
    expect(v.next).toEqual(['pair'])
    expect(v.tone).toBe('idle')
  })

  it('connecting for the first time: nothing has failed, nothing to do', async () => {
    const h = harness()
    await h.controller.start()
    await flush()
    expect(h.state().status).toBe('connecting')
    const v = view(h)
    expect(v.ui).toMatchObject({
      kind: 'connecting',
      title: 'Connecting to Studio',
      description: 'Waiting for an answer…',
    })
    expect(v.next).toEqual([])
    expect(v.tone).toBe('working')
    expect(shortConnectionWords(v)).toBe('Connecting…')
  })

  it('connected: the route in use, by kind', async () => {
    const h = harness({ routes: [LAN, TUNNEL], answers: { [LAN]: silent, [TUNNEL]: ready() } })
    await connect(h)
    const v = view(h)
    expect(v.ui).toMatchObject({ kind: 'ready', title: 'Connected' })
    expect(v.route).toEqual({ endpoint: TUNNEL, kind: 'tunnel' })
    expect(v.tone).toBe('ok')
    expect(v.next).toEqual([])
    expect(shortConnectionWords(v)).toBeNull()
    expect(pageStatusWords(v)).toBe('Connected over Tunnel')
  })

  it('reconnecting after a drop: retrying, with a countdown and a way to try now', async () => {
    const h = harness({ options: { retryDelaysMs: [4000] } })
    await connect(h)
    // Up past the stable mark, then the socket drops and nothing answers.
    h.timers.advance(11_000)
    h.answers.set(LAN, silent)
    h.socket().drop(1006)
    await flush()
    expect(h.state().status).toBe('waiting')
    const v = view(h)
    expect(v.ui).toMatchObject({
      kind: 'unreachable',
      title: "Can't reach Studio",
      description: 'Trying to reconnect…',
      detail: 'No answer from 192.168.1.20:43120',
      retrying: true,
    })
    expect(v.next).toEqual(['retry'])
    // The page's line names the state; the panel under it gives the cause.
    expect(pageStatusWords(v)).toBe('Reconnecting')
    expect(v.retryAt).toBe(h.timers.now() + 4000)
    expect(retryCountdownWords(v.retryAt, h.timers.now())).toBe('Trying again in 4 s')
    expect(retryCountdownWords(v.retryAt, h.timers.now() + 3100)).toBe('Trying again in 1 s')
    expect(retryCountdownWords(v.retryAt, h.timers.now() + 4000)).toBe('Trying again…')
    // The client's own "stopped retrying" (it is made with no retries of its
    // own) never reaches the words: the controller is the one retrying.
    expect(phoneConnectionInput(h.state()).transport.retriesExhausted).toBeUndefined()
  })

  it('a searching retry while the previous search failed keeps the cause on screen', async () => {
    const h = harness({ answers: { [LAN]: silent }, options: { retryDelaysMs: [1000] } })
    await h.controller.start()
    await flush()
    const failing = view(h).ui
    expect(failing).toMatchObject({
      kind: 'unreachable',
      detail: 'No answer from 192.168.1.20:43120',
    })
    h.answers.set(LAN, new Promise<BootstrapOutcome>(() => undefined))
    h.timers.advance(1000)
    await flush()
    expect(h.state().status).toBe('searching')
    expect(view(h).ui).toMatchObject({ kind: 'unreachable', title: "Can't reach Studio" })
  })

  it('unreachable on every route: says how many were tried', async () => {
    const h = harness({ routes: [LAN, TUNNEL], answers: { [LAN]: silent, [TUNNEL]: silent } })
    await h.controller.start()
    await flush()
    const v = view(h)
    expect(v.ui).toMatchObject({ kind: 'unreachable', routesTried: 2 })
    expect(v.ui.detail).toMatch(/\(2 routes tried\)$/)
  })

  it('the tunnel up but nothing behind it: its own cause', async () => {
    const down: BootstrapOutcome = {
      status: 'unreachable',
      cause: 'http',
      httpStatus: 530,
      message: 'HTTP 530',
    }
    const h = harness({ routes: [TUNNEL], answers: { [TUNNEL]: down } })
    await h.controller.start()
    await flush()
    expect(view(h).ui).toMatchObject({
      kind: 'unreachable',
      reason: 'tunnel_down',
      detail: 'studio.example.com answered, but nothing is connected behind it',
    })
  })

  it('offline: the network settings, and it comes back with the network on its own', async () => {
    const h = harness()
    await connect(h)
    h.network.set({ online: false })
    await flush()
    const v = view(h)
    expect(v.ui).toMatchObject({
      kind: 'offline',
      title: "You're offline",
      description: 'Reconnects when the network is back.',
    })
    expect(v.next).toEqual(['network_settings'])
    expect(NEXT_STEP_LABELS.network_settings).toBe('Open network settings')
    expect(v.tone).toBe('warn')
  })

  it('a refused token: not authorized, and the way out is pairing again', async () => {
    const h = harness({
      registry: {
        selectedId: registryWith([LAN]).selectedId,
        environments: [
          ...registryWith([LAN]).environments,
          ...registryWith([TUNNEL], OTHER_ENV).environments,
        ],
      },
    })
    await h.controller.start()
    await flush()
    h.socket().open()
    h.socket().drop(4401, 'unauthorized')
    await flush()
    expect(h.state().status).toBe('unauthorized')
    const v = view(h)
    expect(v.ui).toMatchObject({ kind: 'unauthorized', title: 'Not authorized' })
    expect(v.ui.description).toContain('pair this device again')
    expect(v.next).toEqual(['pair_again', 'switch_environment'])
    expect(v.tone).toBe('error')
  })

  it('a revoked token forgotten: pairing again is the only step, whatever the routes say', async () => {
    const h = harness()
    await h.controller.start()
    await flush()
    h.socket().open()
    h.socket().drop(4401, 'revoked')
    await flush()
    await h.controller.flush()
    const environment = h.state().environments[0]!
    expect(environment.paired).toBe(false)
    expect(view(h).next).toEqual(['pair_again'])
    const [card] = environmentCards(h.state(), view(h))
    expect(card).toMatchObject({ words: 'Needs pairing again', tone: 'error' })
  })

  it('a protocol mismatch at bootstrap: names both versions', async () => {
    const mismatch: BootstrapOutcome = {
      status: 'incompatible_protocol',
      clientProtocolVersion: PROTOCOL_VERSION,
      serverProtocolVersion: PROTOCOL_VERSION + 1,
      environmentId: 'env-studio',
    }
    const h = harness({ answers: { [LAN]: mismatch } })
    await h.controller.start()
    await flush()
    const v = view(h)
    expect(v.ui).toMatchObject({
      kind: 'incompatible_protocol',
      title: 'Incompatible protocol',
      clientProtocolVersion: PROTOCOL_VERSION,
      serverProtocolVersion: PROTOCOL_VERSION + 1,
    })
    expect(v.ui.description).toContain(
      `This client speaks protocol ${PROTOCOL_VERSION}; Studio speaks protocol ${PROTOCOL_VERSION + 1}.`,
    )
    expect(v.next).toEqual(['retry'])
  })

  it('a protocol mismatch at the handshake: the version is read and named', async () => {
    const h = harness()
    await h.controller.start()
    await flush()
    const socket = h.socket()
    h.answers.set(LAN, {
      status: 'incompatible_protocol',
      clientProtocolVersion: PROTOCOL_VERSION,
      serverProtocolVersion: 99,
      environmentId: 'env-studio',
    })
    socket.open()
    socket.receive({
      type: 'error',
      requestId: socket.last('protocol.handshake').requestId,
      error: {
        code: 'protocol_incompatible',
        message: 'Upgrade required.',
        details: { clientProtocolVersion: PROTOCOL_VERSION, serverProtocolVersion: 99 },
      },
    })
    await flush()
    expect(view(h).ui.description).toContain('Studio speaks protocol 99')
  })
})

describe('the environment list', () => {
  it('marks the selected environment, its route in use, and the others by what the phone last learned', async () => {
    const h = harness({
      registry: {
        selectedId: 'env-studio',
        environments: [
          ...registryWith([TUNNEL, LAN]).environments,
          ...registryWith(['https://other.example.com'], OTHER_ENV).environments,
        ],
      },
      credentials: { 'env-studio': 't'.repeat(43), [OTHER_ENV]: 'o'.repeat(43) },
    })
    await connect(h)
    const v = view(h)
    const cards = environmentCards(h.state(), v)
    expect(cards.map((card) => [card.label, card.selected])).toEqual([
      ['Studio', true],
      ['Studio', false],
    ])
    expect(cards[0]).toMatchObject({
      tone: 'ok',
      route: { kind: 'lan', host: '192.168.1.20:43120' },
    })
    // Never checked: no route health to show, so its first route and no words.
    expect(cards[1]).toMatchObject({ tone: 'idle', words: null, route: { kind: 'tunnel' } })

    const rows = routeRows(h.state().environments[0]!, v.route?.endpoint ?? null)
    // Local network first, as the phone asks them.
    expect(rows.map((row) => [row.title, row.inUse, row.health])).toEqual([
      ['Local network', true, 'available'],
      ['Tunnel', false, 'unknown'],
    ])
  })
})

describe('the route order note', () => {
  it('says the order is the usual preference and that failover is temporary, as the controller does it', () => {
    expect(ROUTE_ORDER_NOTE).toMatch(/^Usually this device and the local network first/)
    expect(ROUTE_ORDER_NOTE).toContain('the route in use is tried again first')
    // "About a minute" is the controller's cooldown for a route whose socket just failed.
    expect(PHONE_SOCKET_FAILURE_COOLDOWN_MS).toBe(60_000)
    expect(ROUTE_ORDER_NOTE).toContain('waits about a minute')
  })
})
