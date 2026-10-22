import { SERVER_SHUTDOWN_CLOSE_CODE, SERVER_SHUTDOWN_CLOSE_REASON } from '@openmanager/protocol'
import { describe, expect, it } from 'vitest'
import type { BootstrapOutcome } from '@openmanager/environment-client/connection'

import { phoneConnectionView } from '../src/environment/connection-ui'
import { LAN, TUNNEL, flush, harness, ready, silent } from './support'

type Harness = ReturnType<typeof harness>

/** What a person reads at each step: the shared kind and title, and the next steps. */
const reads = (h: Harness) => {
  const view = phoneConnectionView(h.state())
  return { kind: view.ui.kind, title: view.ui.title, next: view.next, route: view.route }
}

async function connect(h: Harness) {
  await h.controller.start()
  await flush()
  h.socket().accept()
  await flush()
  expect(h.state().status).toBe('connected')
}

/** Cloudflare's answer for a hostname whose tunnel has no connector running. */
const TUNNEL_DOWN: BootstrapOutcome = {
  status: 'unreachable',
  cause: 'http',
  httpStatus: 530,
  message: 'HTTP 530',
}

/**
 * The recovery matrix: each case starts connected, breaks the way the world
 * does, and comes back with no call into the controller at all (no retry, no
 * select, no save). Only the phone's inputs change: the network, the app's
 * lifecycle, what the routes answer, and the sockets.
 */
describe('recovers without a person', () => {
  it('airplane mode on, then off', async () => {
    const h = harness()
    await connect(h)
    const client = h.state().client

    h.network.set({ online: false })
    await flush()
    expect(reads(h)).toMatchObject({
      kind: 'offline',
      title: "You're offline",
      next: ['network_settings'],
    })
    // Nothing is asked while there is no network, however long it lasts.
    h.timers.advance(30 * 60_000)
    await flush()
    expect(h.probes).toEqual([LAN])

    h.network.set({ online: true })
    await flush()
    h.socket().accept()
    await flush()
    expect(reads(h)).toMatchObject({ kind: 'ready', route: { endpoint: LAN, kind: 'lan' } })
    // The same client: what the screens show was kept through the gap.
    expect(h.state().client).toBe(client)
  })

  it('the tunnel goes down, then comes back', async () => {
    const h = harness({
      routes: [TUNNEL],
      answers: { [TUNNEL]: ready() },
      options: { retryDelaysMs: [1000, 2000, 4000] },
    })
    await connect(h)
    h.timers.advance(11_000)

    // cloudflared stops: the socket drops and the edge answers 530.
    h.answers.set(TUNNEL, TUNNEL_DOWN)
    h.socket().drop(1006)
    await flush()
    expect(reads(h)).toMatchObject({ kind: 'unreachable', title: "Can't reach Studio" })
    expect(phoneConnectionView(h.state()).ui.reason).toBe('tunnel_down')
    // It keeps asking on the retry delays.
    h.timers.advance(1000)
    await flush()
    h.timers.advance(2000)
    await flush()
    expect(h.probes.length).toBeGreaterThanOrEqual(3)
    expect(h.state().status).toBe('waiting')

    // The tunnel is back.
    h.answers.set(TUNNEL, ready())
    h.timers.advance(4000)
    await flush()
    h.socket().accept()
    await flush()
    expect(reads(h)).toMatchObject({ kind: 'ready', route: { endpoint: TUNNEL, kind: 'tunnel' } })
  })

  it('the server restarts', async () => {
    const h = harness({ options: { retryDelaysMs: [1000, 2000] } })
    await connect(h)
    h.timers.advance(11_000)

    // The environment says it is shutting down and closes the socket; while
    // it restarts nothing answers at the address.
    h.answers.set(LAN, silent)
    h.socket().drop(SERVER_SHUTDOWN_CLOSE_CODE, SERVER_SHUTDOWN_CLOSE_REASON)
    await flush()
    expect(reads(h)).toMatchObject({ kind: 'unreachable', next: ['retry'] })

    // It is up again before the next try.
    h.answers.set(LAN, ready())
    h.timers.advance(1000)
    await flush()
    expect(h.state().status).toBe('connecting')
    h.socket().accept()
    await flush()
    expect(reads(h)).toMatchObject({ kind: 'ready', route: { endpoint: LAN } })
  })

  it('leaving the LAN: from the local address to the tunnel, no consent needed for a saved route', async () => {
    const h = harness({ routes: [LAN, TUNNEL], answers: { [LAN]: ready(), [TUNNEL]: ready() } })
    await connect(h)
    expect(reads(h).route).toEqual({ endpoint: LAN, kind: 'lan' })
    h.timers.advance(11_000)

    // The phone walks out of the house: Wi-Fi goes, mobile data takes over.
    // The OS reports the change as a blink of the network.
    h.network.set({ online: false })
    h.answers.set(LAN, silent)
    await flush()
    h.network.set({ online: true })
    await flush()
    expect(h.state()).toMatchObject({ status: 'connecting', endpoint: TUNNEL })
    h.socket().accept()
    await flush()
    expect(reads(h)).toMatchObject({ kind: 'ready', route: { endpoint: TUNNEL, kind: 'tunnel' } })

    // And home again: the LAN answers, and the next search prefers it.
    h.answers.set(LAN, ready())
    h.network.set({ online: false })
    await flush()
    h.network.set({ online: true })
    await flush()
    h.socket().accept()
    await flush()
    expect(reads(h).route).toEqual({ endpoint: LAN, kind: 'lan' })
  })

  it('leaving the LAN with no network change reported: the dropped socket finds the tunnel', async () => {
    const h = harness({
      routes: [LAN, TUNNEL],
      answers: { [LAN]: ready(), [TUNNEL]: ready() },
      options: { retryDelaysMs: [1000] },
    })
    await connect(h)
    h.timers.advance(11_000)
    h.answers.set(LAN, silent)
    h.socket().drop(1006)
    await flush()
    expect(h.state()).toMatchObject({ status: 'connecting', endpoint: TUNNEL })
    h.socket().accept()
    await flush()
    expect(reads(h)).toMatchObject({ kind: 'ready', route: { endpoint: TUNNEL } })
  })
})
