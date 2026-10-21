import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_STORAGE_KEY,
  type BootstrapOutcome,
} from '@openmanager/environment-client/connection'
import {
  ENV,
  LAN,
  OTHER_ENV,
  TOKEN,
  TUNNEL,
  FakeSocket,
  deferred,
  flush,
  harness,
  ready,
  registryWith,
  silent,
} from './support'

const savedDocument = (h: ReturnType<typeof harness>) =>
  JSON.parse(h.storage.registry.getItem(ENVIRONMENT_STORAGE_KEY)!) as {
    selectedId: string | null
    environments: Array<{
      environmentId: string
      label: string
      credential: string
      routes: Array<{ endpoint: string; health: { status: string } }>
    }>
  }

/** Start, let the search answer, and accept the socket it opened. */
async function connect(h: ReturnType<typeof harness>) {
  await h.controller.start()
  await flush()
  h.socket().accept()
  await flush()
  expect(h.state().status).toBe('connected')
}

describe('phone connection controller', () => {
  describe('route search, local network first', () => {
    it('waits for a LAN answer even when the tunnel answers first', async () => {
      const lan = deferred<BootstrapOutcome>()
      // The tunnel is the person's first choice and answers at once.
      const h = harness({
        routes: [TUNNEL, LAN],
        answers: { [TUNNEL]: ready(), [LAN]: lan.promise },
      })
      await h.controller.start()
      await flush()
      expect(h.state().status).toBe('searching')
      expect(h.probes.sort()).toEqual([LAN, TUNNEL].sort())
      expect(h.sockets()).toHaveLength(0)

      lan.resolve(ready())
      await flush()
      expect(h.state()).toMatchObject({ status: 'connecting', endpoint: LAN })
      expect(h.socket().url).toBe('ws://192.168.1.20:43120/ws')
    })

    it('takes the tunnel when the LAN route does not answer', async () => {
      const h = harness({ routes: [LAN, TUNNEL], answers: { [LAN]: silent, [TUNNEL]: ready() } })
      await h.controller.start()
      await flush()
      expect(h.state()).toMatchObject({ status: 'connecting', endpoint: TUNNEL })
      expect(h.socket().url).toBe('wss://studio.example.com/ws')
      const routes = savedDocument(h).environments[0]!.routes
      expect(routes.find((route) => route.endpoint === LAN)?.health.status).toBe('unreachable')
      expect(routes.find((route) => route.endpoint === TUNNEL)?.health.status).toBe('available')
      // The order is the person's; the search picking a route does not change it.
      expect(routes.map((route) => route.endpoint)).toEqual([LAN, TUNNEL])
    })

    it('skips an address where a different environment answers', async () => {
      const h = harness({
        routes: [LAN, TUNNEL],
        answers: { [LAN]: ready(OTHER_ENV, 'Someone else'), [TUNNEL]: ready() },
      })
      await h.controller.start()
      await flush()
      expect(h.state().endpoint).toBe(TUNNEL)
      expect(h.sockets().map((socket) => socket.url)).toEqual(['wss://studio.example.com/ws'])
    })
  })

  describe('bootstrap, then connect, with protocol negotiation', () => {
    it('opens the socket with the stored token and publishes the client once the handshake lands', async () => {
      const h = harness()
      await h.controller.start()
      await flush()
      expect(h.probes).toEqual([LAN])
      expect(h.state()).toMatchObject({
        status: 'connecting',
        endpoint: LAN,
        bootstrap: { status: 'ready', environmentId: ENV, protocolVersion: PROTOCOL_VERSION },
        protocol: { client: PROTOCOL_VERSION, environment: PROTOCOL_VERSION },
        client: null,
      })
      const socket = h.socket()
      expect(socket.protocols).toEqual(['openmanager.v1', `openmanager.auth.${TOKEN}`])

      socket.open()
      const handshake = socket.last('protocol.handshake')
      expect(handshake.payload).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
      socket.respond('protocol.handshake', {
        protocolVersion: PROTOCOL_VERSION,
        environmentId: ENV,
        capabilities: ['connection.heartbeat'],
      })
      await flush()
      expect(h.state()).toMatchObject({
        status: 'connected',
        connection: { phase: 'connected', hasConnected: true },
      })
      expect(h.state().client).not.toBeNull()
      expect(h.state().client!.getState().connection.phase).toBe('connected')
    })

    it('stops before any socket when the bootstrap answers in another protocol version', async () => {
      const mismatch: BootstrapOutcome = {
        status: 'incompatible_protocol',
        clientProtocolVersion: PROTOCOL_VERSION,
        serverProtocolVersion: PROTOCOL_VERSION + 1,
        environmentId: ENV,
      }
      const h = harness({ answers: { [LAN]: mismatch } })
      await h.controller.start()
      await flush()
      expect(h.state()).toMatchObject({
        status: 'incompatible_protocol',
        protocol: { client: PROTOCOL_VERSION, environment: PROTOCOL_VERSION + 1 },
        client: null,
      })
      expect(h.sockets()).toHaveLength(0)

      // Nothing on its own asks again: not time, not the app or the network.
      h.timers.advance(10 * 60_000)
      h.activity.set('background')
      h.activity.set('active')
      h.network.set({ online: false })
      h.network.set({ online: true })
      await flush()
      expect(h.probes).toEqual([LAN])

      // A person asking does, and an upgraded environment then connects.
      h.answers.set(LAN, ready())
      h.controller.retry()
      await flush()
      expect(h.probes).toEqual([LAN, LAN])
      h.socket().accept()
      await flush()
      expect(h.state().status).toBe('connected')
    })

    it('latches when the handshake itself refuses the protocol version', async () => {
      const h = harness()
      await h.controller.start()
      await flush()
      const socket = h.socket()
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
      expect(h.state()).toMatchObject({ status: 'incompatible_protocol', client: null })
      h.timers.advance(10 * 60_000)
      await flush()
      // One bootstrap read for the version that refused, then nothing.
      expect(h.probes).toEqual([LAN, LAN])
      expect(h.sockets()).toHaveLength(1)
    })

    it('keeps the newer refusal version when an older read answers late', async () => {
      const h = harness()
      await h.controller.start()
      await flush()
      const refuse = () => {
        const socket = h.socket()
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
      }
      const mismatch = (serverProtocolVersion: number): BootstrapOutcome => ({
        status: 'incompatible_protocol',
        clientProtocolVersion: PROTOCOL_VERSION,
        serverProtocolVersion,
        environmentId: ENV,
      })
      const older = deferred<BootstrapOutcome>()
      h.answers.set(LAN, older.promise)
      refuse()
      await flush()
      // A person retries; the environment still answers ready, then refuses again.
      h.answers.set(LAN, ready())
      h.controller.retry()
      await flush()
      const newer = deferred<BootstrapOutcome>()
      h.answers.set(LAN, newer.promise)
      refuse()
      await flush()
      newer.resolve(mismatch(99))
      await flush()
      older.resolve(mismatch(98))
      await flush()
      expect(h.state().protocol).toEqual({ client: PROTOCOL_VERSION, environment: 99 })
    })

    it('shows the version the environment speaks after a handshake refusal', async () => {
      const h = harness()
      await h.controller.start()
      await flush()
      // The environment was upgraded between bootstrap and handshake.
      h.answers.set(LAN, {
        status: 'incompatible_protocol',
        clientProtocolVersion: PROTOCOL_VERSION,
        serverProtocolVersion: 99,
        environmentId: ENV,
      })
      const socket = h.socket()
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
      expect(h.state()).toMatchObject({
        status: 'incompatible_protocol',
        protocol: { client: PROTOCOL_VERSION, environment: 99 },
        bootstrap: { status: 'incompatible_protocol', serverProtocolVersion: 99 },
      })
    })
  })

  describe('the default probe', () => {
    it('gives a silent route one request within its deadline, then takes the tunnel', async () => {
      const calls: Array<{ url: string; mode?: string }> = []
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, mode: init?.mode })
        if (url.startsWith(TUNNEL)) {
          return new Response(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              environmentId: ENV,
              capabilities: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        // The LAN address is silent: nothing answers until the probe gives up.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }) as typeof fetch
      try {
        const h = harness({
          routes: [LAN, TUNNEL],
          options: { probe: undefined, probeTimeoutMs: 50 },
        })
        await h.controller.start()
        await new Promise((resolve) => setTimeout(resolve, 200))
        await flush()
        expect(h.state()).toMatchObject({ status: 'connecting', endpoint: TUNNEL })
        // One bootstrap request each; no no-cors follow-up after the timeout.
        expect(calls.filter((call) => call.url.startsWith(LAN))).toEqual([
          { url: `${LAN}/bootstrap`, mode: undefined },
        ])
      } finally {
        globalThis.fetch = realFetch
      }
    })
  })

  describe('the app in the background', () => {
    it('holds: closes the socket, stops every timer and asks nothing', async () => {
      const h = harness()
      await connect(h)
      const client = h.state().client
      const socket = h.socket()

      h.activity.set('background')
      await flush()
      expect(h.state().status).toBe('held')
      expect(socket.closedWith).toEqual({ code: 1000, reason: 'client_disconnect' })
      // Heartbeat and retry timers are all gone.
      expect(h.timers.pending()).toBe(0)
      h.timers.advance(60 * 60_000)
      await flush()
      expect(h.probes).toEqual([LAN])
      expect(h.sockets()).toHaveLength(1)
      // Views keep the client and what it holds.
      expect(h.state().client).toBe(client)
    })

    it('reconnects on its own when the app comes back, on the same client', async () => {
      const h = harness()
      await connect(h)
      const client = h.state().client

      h.activity.set('background')
      await flush()
      h.activity.set('active')
      await flush()
      expect(h.probes).toEqual([LAN, LAN])
      expect(h.sockets()).toHaveLength(2)
      expect(h.state().status).toBe('connecting')
      h.socket().accept()
      await flush()
      expect(h.state().status).toBe('connected')
      expect(h.state().client).toBe(client)
    })

    it('comes back on the tunnel when the phone has left the LAN', async () => {
      const h = harness({ routes: [LAN, TUNNEL], answers: { [LAN]: ready(), [TUNNEL]: ready() } })
      await connect(h)
      expect(h.state().endpoint).toBe(LAN)
      const client = h.state().client

      h.activity.set('background')
      h.answers.set(LAN, silent)
      h.activity.set('active')
      await flush()
      expect(h.state()).toMatchObject({ status: 'connecting', endpoint: TUNNEL })
      // Same environment, new route: views keep reading the same store.
      expect(h.state().client).not.toBeNull()
      h.socket().accept()
      await flush()
      expect(h.state().status).toBe('connected')
      expect(h.state().client).not.toBe(client)
      expect(h.state().client!.getState()).toBe(client!.getState())
    })

    it('treats iOS inactive as still on screen: the socket stays', async () => {
      const h = harness()
      await connect(h)
      // The adapter maps `inactive` to `active`, so the source never changes.
      h.activity.set('active')
      await flush()
      expect(h.state().status).toBe('connected')
      expect(h.sockets()).toHaveLength(1)
    })

    it('does not start a search that was due while the app was away', async () => {
      const h = harness({ answers: { [LAN]: silent } })
      await h.controller.start()
      await flush()
      expect(h.state().status).toBe('waiting')
      h.activity.set('background')
      await flush()
      h.timers.advance(10 * 60_000)
      await flush()
      expect(h.probes).toEqual([LAN])
    })
  })

  describe('the network going and coming back', () => {
    it('goes offline without retrying, and reconnects when the network returns', async () => {
      const h = harness()
      await connect(h)
      const socket = h.socket()

      h.network.set({ online: false })
      await flush()
      expect(h.state().status).toBe('offline')
      expect(socket.closedWith?.code).toBe(1000)
      h.timers.advance(10 * 60_000)
      await flush()
      expect(h.probes).toEqual([LAN])

      h.network.set({ online: true })
      await flush()
      expect(h.probes).toEqual([LAN, LAN])
      h.socket().accept()
      await flush()
      expect(h.state().status).toBe('connected')
    })

    it('reopens once the closing socket has closed when the network blinks', async () => {
      const h = harness()
      await connect(h)
      FakeSocket.deferClose = true
      const first = h.socket()
      h.network.set({ online: false })
      await flush()
      expect(h.state().status).toBe('offline')
      // Back before the close handshake finished: the client still reads
      // connected, but that socket is going away.
      h.network.set({ online: true })
      await flush()
      expect(h.state().status).toBe('connecting')
      expect(h.sockets()).toHaveLength(1)
      first.finishClose()
      await flush()
      expect(h.sockets()).toHaveLength(2)
      h.socket().accept()
      await flush()
      expect(h.state().status).toBe('connected')
      expect(h.state().attempt).toBe(0)
    })

    it('reopens once the closing socket has closed when the app comes straight back', async () => {
      const h = harness()
      await connect(h)
      FakeSocket.deferClose = true
      const client = h.state().client
      h.activity.set('background')
      h.activity.set('active')
      await flush()
      expect(h.state().status).toBe('connecting')
      h.socket().finishClose()
      await flush()
      expect(h.sockets()).toHaveLength(2)
      h.socket().accept()
      await flush()
      expect(h.state()).toMatchObject({ status: 'connected', client })
    })

    it('does not count a socket that dropped with the network as a failure', async () => {
      const h = harness()
      await connect(h)
      h.network.set({ online: false })
      // The OS tears the socket down after the app was told the network went.
      h.socket().drop(1006)
      await flush()
      expect(h.state()).toMatchObject({ status: 'offline', attempt: 0, retryAt: null })
    })
  })

  describe('a refused token', () => {
    it('latches on 4401: no route is asked again and nothing redials', async () => {
      const h = harness({ routes: [LAN, TUNNEL], answers: { [LAN]: ready(), [TUNNEL]: ready() } })
      await h.controller.start()
      await flush()
      const socket = h.socket()
      socket.open()
      socket.drop(4401, 'unauthorized')
      await flush()
      expect(h.state()).toMatchObject({
        status: 'unauthorized',
        client: null,
        routeFailure: { reason: 'credential_rejected', endpoint: LAN, tried: 1 },
      })
      expect(
        savedDocument(h).environments[0]!.routes.find((route) => route.endpoint === LAN)?.health
          .status,
      ).toBe('unauthorized')
      const probes = h.probes.length

      h.timers.advance(60 * 60_000)
      h.activity.set('background')
      h.activity.set('active')
      h.network.set({ online: false })
      h.network.set({ online: true })
      await flush()
      expect(h.probes).toHaveLength(probes)
      expect(h.sockets()).toHaveLength(1)
      expect(h.state().status).toBe('unauthorized')
    })

    it('tries again once when a person asks, and latches again if still refused', async () => {
      const h = harness()
      await h.controller.start()
      await flush()
      h.socket().open()
      h.socket().drop(4401, 'revoked')
      await flush()
      expect(h.state().status).toBe('unauthorized')

      h.controller.retry()
      await flush()
      expect(h.sockets()).toHaveLength(2)
      h.socket().open()
      h.socket().drop(4401, 'revoked')
      await flush()
      expect(h.state().status).toBe('unauthorized')
      h.timers.advance(60 * 60_000)
      await flush()
      expect(h.sockets()).toHaveLength(2)
    })

    it('retires the socket on the old token when a new one is saved, so its refusal cannot latch the new one', async () => {
      const h = harness()
      await connect(h)
      const old = h.socket()
      const lan = deferred<BootstrapOutcome>()
      h.answers.set(LAN, lan.promise)
      const fresh = 'n'.repeat(43)
      h.controller.saveEnvironment({ environmentId: ENV, endpoint: LAN, credential: fresh })
      await flush()
      expect(old.closedWith?.reason).toBe('client_disposed')
      // The old token is refused while the new token's search is still out.
      old.drop(4401, 'revoked')
      await flush()
      expect(h.state().status).toBe('searching')
      lan.resolve(ready())
      await flush()
      expect(h.socket().protocols).toEqual(['openmanager.v1', `openmanager.auth.${fresh}`])
      h.socket().accept()
      await flush()
      expect(h.state().status).toBe('connected')
    })

    it('connects with a new token once one is saved for the environment', async () => {
      const h = harness()
      await h.controller.start()
      await flush()
      h.socket().open()
      h.socket().drop(4401, 'revoked')
      await flush()

      const fresh = 'n'.repeat(43)
      h.controller.saveEnvironment({ environmentId: ENV, endpoint: LAN, credential: fresh })
      await flush()
      expect(h.socket().protocols).toEqual(['openmanager.v1', `openmanager.auth.${fresh}`])
      h.socket().accept()
      await flush()
      expect(h.state().status).toBe('connected')
      await h.controller.flush()
      expect(h.storage.credentials.snapshot()).toEqual({ [ENV]: fresh })
    })
  })

  describe('cancelled searches', () => {
    it('aborts a probe in flight and asks no further route when the app goes to the background', async () => {
      const lan = deferred<BootstrapOutcome>()
      const h = harness({ routes: [LAN, TUNNEL], answers: { [LAN]: ready(), [TUNNEL]: ready() } })
      await connect(h)
      h.timers.advance(11_000)
      h.answers.set(LAN, lan.promise)
      // A stable connection drops: the route in use is asked on its own first.
      h.socket().drop(1006)
      await flush()
      expect(h.probes).toEqual([LAN, TUNNEL, LAN])
      const inFlight = h.signals.at(-1)!
      expect(inFlight.aborted).toBe(false)

      h.activity.set('background')
      await flush()
      expect(inFlight.aborted).toBe(true)
      // The aborted probe fails; the search must not go on to the tunnel.
      lan.resolve(silent)
      await flush()
      expect(h.probes).toEqual([LAN, TUNNEL, LAN])
      expect(h.state().status).toBe('held')
    })

    it('aborts the probes of a search that another search replaced', async () => {
      const lan = deferred<BootstrapOutcome>()
      const h = harness({ answers: { [LAN]: lan.promise } })
      await h.controller.start()
      await flush()
      const first = h.signals.at(-1)!
      h.answers.set(LAN, ready())
      h.controller.retry()
      await flush()
      expect(first.aborted).toBe(true)
      expect(h.signals.at(-1)!.aborted).toBe(false)
      lan.resolve(ready())
      await flush()
      expect(h.sockets()).toHaveLength(1)
    })
  })

  describe('retrying on its own', () => {
    it('backs off between failed searches, longer each time', async () => {
      const h = harness({
        answers: { [LAN]: silent },
        options: { retryDelaysMs: [1000, 2000, 4000] },
      })
      await h.controller.start()
      await flush()
      expect(h.state()).toMatchObject({
        status: 'waiting',
        attempt: 1,
        retryAt: h.timers.now() + 1000,
        routeFailure: { reason: 'route_down', endpoint: LAN },
      })
      h.timers.advance(999)
      await flush()
      expect(h.probes).toHaveLength(1)
      h.timers.advance(1)
      await flush()
      expect(h.probes).toHaveLength(2)
      expect(h.state().retryAt).toBe(h.timers.now() + 2000)
      h.timers.advance(2000)
      await flush()
      expect(h.state().retryAt).toBe(h.timers.now() + 4000)
      h.timers.advance(4000)
      await flush()
      // The last delay repeats.
      expect(h.state().retryAt).toBe(h.timers.now() + 4000)
      expect(h.probes).toHaveLength(4)
    })

    it('backs off when the route answers but its socket fails, instead of spinning', async () => {
      const h = harness({ options: { retryDelaysMs: [1000, 2000] } })
      await h.controller.start()
      await flush()
      h.socket().drop(1006)
      await flush()
      expect(h.state()).toMatchObject({ status: 'waiting', attempt: 1 })
      expect(h.sockets()).toHaveLength(1)
      h.timers.advance(1000)
      await flush()
      expect(h.sockets()).toHaveLength(2)
      h.socket().drop(1006)
      await flush()
      expect(h.state().retryAt).toBe(h.timers.now() + 2000)
    })

    it('searches at once when a connection that had been up drops, asking its route first', async () => {
      const lan = deferred<BootstrapOutcome>()
      const h = harness({ routes: [LAN, TUNNEL], answers: { [LAN]: ready(), [TUNNEL]: ready() } })
      await connect(h)
      // Stay up past the stable mark (the heartbeat allows longer than this).
      h.timers.advance(11_000)
      h.answers.set(LAN, lan.promise)
      h.socket().drop(1006)
      await flush()
      expect(h.state().status).toBe('searching')
      // Only the route in use is asked while it may just have blinked.
      expect(h.probes).toEqual([LAN, TUNNEL, LAN])
      lan.resolve(ready())
      await flush()
      expect(h.state()).toMatchObject({ status: 'connecting', endpoint: LAN, attempt: 0 })
    })
  })

  describe('storage', () => {
    it('keeps the token out of the registry document', async () => {
      const h = harness()
      await connect(h)
      await h.controller.flush()
      const document = savedDocument(h)
      expect(document.environments[0]).toMatchObject({ environmentId: ENV, credential: '' })
      expect(JSON.stringify(document)).not.toContain(TOKEN)
      expect(h.storage.credentials.snapshot()).toEqual({ [ENV]: TOKEN })
      expect(h.state().environments).toEqual([
        expect.objectContaining({ environmentId: ENV, label: 'Studio', paired: true }),
      ])
      expect(JSON.stringify(h.state().environments)).not.toContain(TOKEN)
    })

    it('records the label the environment answers with', async () => {
      const h = harness({ answers: { [LAN]: ready(ENV, 'Office tower') } })
      await connect(h)
      await h.controller.flush()
      expect(savedDocument(h).environments[0]!.label).toBe('Office tower')
    })

    it('forgets an environment and its token, and drops its client', async () => {
      const h = harness()
      await connect(h)
      h.controller.removeEnvironment(ENV)
      await h.controller.flush()
      expect(h.state()).toMatchObject({
        status: 'no_environment',
        client: null,
        environments: [],
      })
      expect(h.storage.credentials.snapshot()).toEqual({})
      expect(h.socket().closedWith?.reason).toBe('client_disposed')
    })
  })

  describe('choosing the environment', () => {
    it('waits with nothing saved, then connects to an environment once it is saved', async () => {
      const h = harness({ registry: { selectedId: null, environments: [] }, credentials: {} })
      await h.controller.start()
      await flush()
      expect(h.state().status).toBe('no_environment')
      expect(h.probes).toEqual([])

      h.controller.saveEnvironment({
        environmentId: ENV,
        endpoint: LAN,
        label: 'Studio',
        credential: TOKEN,
      })
      await flush()
      expect(h.probes).toEqual([LAN])
      h.socket().accept()
      await flush()
      expect(h.state()).toMatchObject({ status: 'connected', selectedId: ENV })
    })

    it('switching environments closes the old client and opens one for the new', async () => {
      const registry = registryWith([LAN])
      registry.environments.push({
        ...registryWith([TUNNEL], OTHER_ENV).environments[0]!,
        label: 'Other',
      })
      const h = harness({
        registry,
        credentials: { [ENV]: TOKEN, [OTHER_ENV]: 'o'.repeat(43) },
        answers: { [LAN]: ready(), [TUNNEL]: ready(OTHER_ENV, 'Other') },
      })
      await connect(h)
      const first = h.socket()
      const firstClient = h.state().client

      h.controller.selectEnvironment(OTHER_ENV)
      await flush()
      expect(first.closedWith?.reason).toBe('client_disposed')
      expect(h.state()).toMatchObject({ selectedId: OTHER_ENV, endpoint: TUNNEL, client: null })
      h.socket().accept(OTHER_ENV)
      await flush()
      expect(h.state().status).toBe('connected')
      expect(h.state().client).not.toBe(firstClient)
    })
  })

  it('stops everything on dispose', async () => {
    const h = harness()
    await connect(h)
    h.controller.dispose()
    expect(h.socket().closedWith?.reason).toBe('client_disposed')
    h.activity.set('background')
    h.activity.set('active')
    h.timers.advance(60_000)
    await flush()
    expect(h.probes).toEqual([LAN])
  })
})
