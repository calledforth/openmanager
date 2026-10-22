import { describe, expect, it } from 'vitest'
import { encodePairingLink } from '@openmanager/environment-client'
import { PROTOCOL_VERSION, type PairingRejectionReason } from '@openmanager/protocol'
import { connectedRoute } from '../src/environment/connected-route'
import { readPhoneLabel, suggestPhoneLabel } from '../src/pairing/device-label'
import {
  checkNewRoute,
  connectedClient,
  exchangeLink,
  joinRoute,
  planPairing,
  redeemLink,
} from '../src/pairing/flow'
import { describePairingFailure, type PairingFailure } from '../src/pairing/failures'
import { readPairingLink, type PairingLinkRead } from '../src/pairing/link'
import {
  ENV,
  LAN,
  OTHER_ENV,
  PAIRING_TOKEN,
  TOKEN,
  TUNNEL,
  flush,
  harness,
  ready,
  registryWith,
} from './support'

const APP = 'https://app.example.test'
const PHONE_TOKEN = 'p'.repeat(43)

const linkTo = (route: string, environmentId = ENV) =>
  encodePairingLink(`${APP}/`, { route, environmentId, token: PAIRING_TOKEN })

function read(text: string): PairingLinkRead {
  const result = readPairingLink(text)
  if (!result.ok) throw new Error(`not a link: ${JSON.stringify(result.failure)}`)
  return result.link
}

const answer = (environmentId = ENV) => ({
  environmentId,
  label: 'Studio',
  kind: 'paired',
  clientId: 'client-phone',
  clientLabel: 'Pixel 9',
  grant: ['read', 'operate', 'agent'],
  credential: PHONE_TOKEN,
})

type Call = { url: string; init: RequestInit }

/** A `fetch` that answers `POST /pair` with `respond`, and records each call. */
function pairFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  }) as typeof fetch
  return { fetchImpl, calls }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const refusal = (reason: PairingRejectionReason) =>
  json(401, { error: { code: 'auth', message: 'refused', details: { reason } } })

/** A fresh install: the phone's storage holds nothing yet. */
function freshInstall() {
  return harness({ registry: { selectedId: null, environments: [] }, credentials: {} })
}

describe('reading a pairing link', () => {
  it("takes the payload with the shared parser and the app origin from the link's own URL", () => {
    const result = readPairingLink(`  ${linkTo(LAN)}\n`)
    expect(result).toEqual({
      ok: true,
      link: {
        payload: { route: LAN, environmentId: ENV, token: PAIRING_TOKEN },
        appOrigin: APP,
      },
    })
  })

  it('reads a bare fragment, which names no app origin', () => {
    const fragment = new URL(linkTo(LAN)).hash
    expect(readPairingLink(fragment)).toMatchObject({ ok: true, link: { appOrigin: null } })
  })

  it('reports what the shared parser says is wrong', () => {
    expect(readPairingLink('https://example.com/hello')).toEqual({
      ok: false,
      failure: { kind: 'link', problem: 'not_a_link' },
    })
    expect(readPairingLink(linkTo(LAN).replace('v=1', 'v=2'))).toEqual({
      ok: false,
      failure: { kind: 'link', problem: 'unsupported_version' },
    })
    expect(readPairingLink(linkTo(LAN).replace(/token=[^&]+/, 'token=nope'))).toEqual({
      ok: false,
      failure: { kind: 'link', problem: 'malformed' },
    })
  })
})

describe('the device label', () => {
  it("suggests the phone's model name, else its system, else Phone", () => {
    expect(suggestPhoneLabel({ modelName: 'Pixel 9', osName: 'Android' })).toBe('Pixel 9')
    expect(suggestPhoneLabel({ modelName: '  ', osName: 'iOS' })).toBe('iOS')
    expect(suggestPhoneLabel({ modelName: null, osName: null })).toBe('Phone')
    expect(suggestPhoneLabel({ modelName: 'bad\u0007name', osName: null })).toBe('Phone')
  })

  it('sends a trimmed edit, nothing for an empty one, and refuses one the environment would', () => {
    expect(readPhoneLabel('  Work phone ')).toEqual({ ok: true, label: 'Work phone' })
    expect(readPhoneLabel('   ')).toEqual({ ok: true, label: undefined })
    expect(readPhoneLabel('x'.repeat(129)).ok).toBe(false)
    expect(readPhoneLabel('a​b').ok).toBe(false)
  })
})

describe('pairing a fresh install: link, exchange, store', () => {
  it('trades the token at the link route and saves token, route, label and app origin', async () => {
    const h = freshInstall()
    await h.controller.start()
    expect(h.state().status).toBe('no_environment')
    const link = read(linkTo(LAN))
    expect(planPairing(link, h.controller)).toEqual({ kind: 'exchange' })

    const { fetchImpl, calls } = pairFetch(() => json(200, answer()))
    const result = await exchangeLink(link, { label: 'Pixel 9' }, h.controller, fetchImpl)
    expect(result).toEqual({
      ok: true,
      paired: { environmentId: ENV, clientLabel: 'Pixel 9', how: 'exchanged' },
    })

    // One request, to the link's route, carrying the link's token and the
    // label and nothing that could be a credential.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${LAN}/pair`)
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      token: PAIRING_TOKEN,
      label: 'Pixel 9',
    })
    expect(JSON.stringify(calls[0]!.init.headers)).not.toMatch(/authorization/i)

    // Saved through the registry: the token in SecureStore only, the rest in
    // AsyncStorage, the app origin on the record.
    await h.controller.flush()
    expect(h.storage.secret(ENV)).toBe(PHONE_TOKEN)
    expect(JSON.stringify(h.storage.asyncStore.dump())).not.toContain(PHONE_TOKEN)
    expect(h.storage.document()).toMatchObject({
      selectedId: ENV,
      environments: [
        {
          environmentId: ENV,
          label: 'Studio',
          appOrigin: APP,
          routes: [{ endpoint: LAN }],
        },
      ],
    })
    expect(h.state().environments).toEqual([
      expect.objectContaining({ environmentId: ENV, paired: true, appOrigin: APP }),
    ])
  })

  it('then connects with the app origin, on a route the controller reads as LAN', async () => {
    const h = freshInstall()
    await h.controller.start()
    const { fetchImpl } = pairFetch(() => json(200, answer()))
    await exchangeLink(read(linkTo(LAN)), {}, h.controller, fetchImpl)
    await flush()
    expect(h.probes).toEqual([LAN])
    const socket = h.socket()
    expect(socket.origin).toBe(APP)
    expect(socket.protocols).toContain(`openmanager.auth.${PHONE_TOKEN}`)
    expect(connectedRoute(h.state())).toBeNull()
    socket.accept()
    await flush()
    expect(h.state().status).toBe('connected')
    expect(connectedRoute(h.state())).toEqual({ endpoint: LAN, kind: 'lan' })
    expect(h.state().environments[0]?.label).toBe('Studio')
  })

  it('reads a tunnel route as Tunnel', async () => {
    const h = freshInstall()
    h.answers.set(TUNNEL, ready())
    await h.controller.start()
    const { fetchImpl } = pairFetch(() => json(200, answer()))
    await exchangeLink(read(linkTo(TUNNEL)), {}, h.controller, fetchImpl)
    await flush()
    h.socket().accept()
    await flush()
    expect(connectedRoute(h.state())).toEqual({ endpoint: TUNNEL, kind: 'tunnel' })
  })

  it('refuses to follow a redirect with the token', async () => {
    const h = freshInstall()
    await h.controller.start()
    const { fetchImpl, calls } = pairFetch(() => json(200, answer()))
    await exchangeLink(read(linkTo(LAN)), {}, h.controller, fetchImpl)
    expect(calls[0]!.init.redirect).toBe('error')
  })

  it('leaves the label out when the person cleared it', async () => {
    const h = freshInstall()
    await h.controller.start()
    const { fetchImpl, calls } = pairFetch(() => json(200, answer()))
    await exchangeLink(read(linkTo(LAN)), { label: undefined }, h.controller, fetchImpl)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ token: PAIRING_TOKEN })
  })

  it('saves nothing when the route answers as another environment than the link names', async () => {
    const h = freshInstall()
    await h.controller.start()
    const { fetchImpl } = pairFetch(() => json(200, answer(OTHER_ENV)))
    const result = await exchangeLink(read(linkTo(LAN)), {}, h.controller, fetchImpl)
    expect(result).toEqual({ ok: false, failure: { kind: 'environment_mismatch', route: LAN } })
    await h.controller.flush()
    expect(h.state().environments).toEqual([])
    expect(h.storage.secret(OTHER_ENV)).toBeNull()
    expect(JSON.stringify(h.storage.asyncStore.dump())).not.toContain(PHONE_TOKEN)
    expect(h.sockets()).toHaveLength(0)
  })

  it.each(['expired', 'used', 'invalid', 'creator_revoked', 'malformed'] as const)(
    'reports the environment refusing the token as %s, and saves nothing',
    async (reason) => {
      const h = freshInstall()
      await h.controller.start()
      const { fetchImpl } = pairFetch(() => refusal(reason))
      const result = await exchangeLink(read(linkTo(LAN)), {}, h.controller, fetchImpl)
      expect(result).toEqual({ ok: false, failure: { kind: 'rejected', reason } })
      expect(h.state().environments).toEqual([])
    },
  )

  it('tells nothing answering apart from an HTTP refusal', async () => {
    const h = freshInstall()
    await h.controller.start()
    const down = pairFetch(() => {
      throw new TypeError('Network request failed')
    })
    expect(await exchangeLink(read(linkTo(LAN)), {}, h.controller, down.fetchImpl)).toEqual({
      ok: false,
      failure: { kind: 'unreachable', route: LAN },
    })
    const busy = pairFetch(() => json(429, { error: { code: 'rate_limited', message: 'slow' } }))
    expect(await exchangeLink(read(linkTo(LAN)), {}, h.controller, busy.fetchImpl)).toEqual({
      ok: false,
      failure: { kind: 'rate_limited' },
    })
    const missing = pairFetch(() => json(404, {}))
    expect(await exchangeLink(read(linkTo(LAN)), {}, h.controller, missing.fetchImpl)).toEqual({
      ok: false,
      failure: { kind: 'not_pairing', route: LAN },
    })
    const broken = pairFetch(() => json(500, {}))
    expect(await exchangeLink(read(linkTo(LAN)), {}, h.controller, broken.fetchImpl)).toMatchObject(
      {
        ok: false,
        failure: { kind: 'unexpected' },
      },
    )
    expect(h.state().environments).toEqual([])
  })
})

describe('what keeps a link from being used up for nothing', () => {
  it('sends nothing while the phone has not read what it saved', async () => {
    const h = freshInstall()
    const { fetchImpl, calls } = pairFetch(() => json(200, answer()))
    const result = await exchangeLink(read(linkTo(LAN)), {}, h.controller, fetchImpl)
    expect(result).toMatchObject({ ok: false, failure: { kind: 'unexpected' } })
    expect(calls).toHaveLength(0)
  })

  it('gives up on an exchange that never finishes answering, as unreachable', async () => {
    const h = freshInstall()
    await h.controller.start()
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })) as typeof fetch
    const result = await exchangeLink(read(linkTo(LAN)), {}, h.controller, hanging, {
      timeoutMs: 50,
    })
    expect(result).toEqual({ ok: false, failure: { kind: 'unreachable', route: LAN } })
  })

  it('ends an exchange whose body never finishes, and saves nothing when it lands late', async () => {
    const h = freshInstall()
    await h.controller.start()
    let finish!: (body: unknown) => void
    // Headers arrive, the body never settles, and the network abort is ignored.
    const stuck = (async () =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      }) as unknown as Response) as typeof fetch
    const pending = exchangeLink(read(linkTo(LAN)), {}, h.controller, stuck, {
      timers: h.timers,
      timeoutMs: 20_000,
    })
    await flush()
    h.timers.advance(20_000)
    const result = await pending
    expect(result).toEqual({ ok: false, failure: { kind: 'timed_out', route: LAN } })
    expect(describePairingFailure((result as { failure: PairingFailure }).failure)).toMatchObject({
      next: 'retry',
    })
    finish(answer())
    await flush()
    await h.controller.flush()
    expect(h.state().environments).toEqual([])
    expect(h.storage.secret(ENV)).toBeNull()
    expect(h.timers.pending()).toBe(0)
  })

  it('reports a save the controller did not take instead of a pairing', async () => {
    const h = freshInstall()
    await h.controller.start()
    const { fetchImpl } = pairFetch(() => json(200, answer()))
    const result = await exchangeLink(
      read(linkTo(LAN)),
      {},
      { ...h.controller, saveEnvironment: () => undefined },
      fetchImpl,
    )
    expect(result).toMatchObject({ ok: false, failure: { kind: 'unexpected' } })
  })
})

describe('a link for an environment the phone already knows', () => {
  it('needs consent before a new address joins one it holds a token for', async () => {
    const h = harness({ routes: [LAN] })
    await h.controller.start()
    const link = read(linkTo(TUNNEL))
    expect(h.controller.classifyRoute({ environmentId: ENV, endpoint: TUNNEL })).toEqual({
      kind: 'new_route',
      sendsSavedCredential: true,
    })
    expect(planPairing(link, h.controller)).toEqual({
      kind: 'consent',
      label: 'Studio',
      route: TUNNEL,
      then: 'redeem',
      sendsSavedCredential: true,
    })
    // Planning sends nothing and saves nothing.
    expect(h.storage.document()!.environments[0]!.routes.map((r) => r.endpoint)).toEqual([LAN])
  })

  it('asks the new address first, and offers nothing when it answers as another environment', async () => {
    const h = harness({ routes: [LAN] })
    await h.controller.start()
    h.answers.set(TUNNEL, ready(OTHER_ENV))
    expect(await checkNewRoute(read(linkTo(TUNNEL)), h.controller)).toEqual({
      ok: false,
      failure: { kind: 'environment_mismatch', route: TUNNEL },
    })
    h.answers.delete(TUNNEL)
    expect(await checkNewRoute(read(linkTo(TUNNEL)), h.controller)).toEqual({
      ok: false,
      failure: { kind: 'unreachable', route: TUNNEL },
    })
    h.answers.set(TUNNEL, ready())
    expect(await checkNewRoute(read(linkTo(TUNNEL)), h.controller)).toEqual({ ok: true })
  })

  it('adds the address only once agreed, as the last route, keeping the token', async () => {
    const h = harness({ routes: [LAN] })
    await connect(h)
    expect(joinRoute(read(linkTo(TUNNEL)), h.controller)).toBe(true)
    await h.controller.flush()
    expect(h.storage.document()!.environments[0]!.routes.map((r) => r.endpoint)).toEqual([
      LAN,
      TUNNEL,
    ])
    expect(h.storage.secret(ENV)).toBe(TOKEN)
    // The record had no app origin; the link's fills it.
    expect(h.storage.document()!.environments[0]!.appOrigin).toBe(APP)
    // Joining it twice is nothing.
    expect(joinRoute(read(linkTo(TUNNEL)), h.controller)).toBe(false)
  })

  it('keeps a saved app origin when a new address joins', async () => {
    const h = harness({ routes: [LAN], appOrigins: { [ENV]: 'https://desk.example.test' } })
    await connect(h)
    joinRoute(read(linkTo(TUNNEL)), h.controller)
    await h.controller.flush()
    expect(h.storage.document()!.environments[0]!.appOrigin).toBe('https://desk.example.test')
    expect(h.state().status).toBe('connected')
  })

  it('redeems a link for a known address over the phone’s own socket, never at the route', async () => {
    const h = harness({ routes: [LAN], appOrigins: { [ENV]: APP } })
    await h.controller.start()
    await flush()
    h.socket().accept(ENV, ['connection.heartbeat', 'pairing.redeem'])
    await flush()
    const link = read(linkTo(LAN))
    expect(planPairing(link, h.controller)).toEqual({ kind: 'redeem', label: 'Studio' })
    const redeemed = redeemLink(link, h.controller, { timers: h.timers })
    await flush()
    const socket = h.socket()
    expect(socket.last('pairing.redeem').payload).toEqual({ token: PAIRING_TOKEN })
    socket.respond('pairing.redeem', {
      clientId: 'client-phone',
      clientLabel: 'Pixel 9',
      grant: ['read', 'operate'],
      grantChanged: false,
    })
    expect(await redeemed).toEqual({
      ok: true,
      paired: { environmentId: ENV, clientLabel: 'Pixel 9', how: 'redeemed' },
    })
    expect(h.storage.secret(ENV)).toBe(TOKEN)
  })

  it('fills a missing app origin from the link before redeeming, and keeps a saved one', async () => {
    const h = harness({ routes: [LAN] })
    await h.controller.start()
    await flush()
    // Saved before the phone kept app origins: the socket sends the route's own.
    expect(h.socket().origin).toBe(new URL(LAN).origin)
    const redeemed = redeemLink(read(linkTo(LAN)), h.controller, { timers: h.timers })
    await flush()
    expect(h.storage.document()!.environments[0]!.appOrigin).toBe(APP)
    expect(h.socket().origin).toBe(APP)
    expect(h.storage.secret(ENV)).toBe(TOKEN)
    h.socket().accept(ENV, ['connection.heartbeat', 'pairing.redeem'])
    await flush()
    h.socket().respond('pairing.redeem', {
      clientId: 'client-phone',
      clientLabel: 'Pixel 9',
      grant: ['read'],
      grantChanged: false,
    })
    expect((await redeemed).ok).toBe(true)
    expect(
      h.controller.fillAppOrigin({ environmentId: ENV, appOrigin: 'https://other.example.test' }),
    ).toBe(false)
    await h.controller.flush()
    expect(h.storage.document()!.environments[0]!.appOrigin).toBe(APP)
  })

  it('clears a protocol refusal when it fills a missing app origin, and redeems at once', async () => {
    const h = harness({
      routes: [LAN],
      answers: {
        [LAN]: {
          status: 'incompatible_protocol',
          clientProtocolVersion: PROTOCOL_VERSION,
          serverProtocolVersion: PROTOCOL_VERSION + 1,
          environmentId: ENV,
        },
      },
    })
    await h.controller.start()
    await flush()
    expect(h.state().status).toBe('incompatible_protocol')
    // The environment was updated since; the link is scanned once.
    h.answers.set(LAN, ready())
    const redeemed = redeemLink(read(linkTo(LAN)), h.controller, { timers: h.timers })
    await flush()
    expect(h.storage.document()!.environments[0]!.appOrigin).toBe(APP)
    expect(h.socket().origin).toBe(APP)
    h.socket().accept(ENV, ['connection.heartbeat', 'pairing.redeem'])
    await flush()
    h.socket().respond('pairing.redeem', {
      clientId: 'client-phone',
      clientLabel: 'Pixel 9',
      grant: ['read'],
      grantChanged: false,
    })
    expect((await redeemed).ok).toBe(true)
  })

  it('reports a redeem refusal by its reason', async () => {
    const h = harness({ routes: [LAN], appOrigins: { [ENV]: APP } })
    await h.controller.start()
    await flush()
    h.socket().accept(ENV, ['connection.heartbeat', 'pairing.redeem'])
    await flush()
    const redeemed = redeemLink(read(linkTo(LAN)), h.controller, { timers: h.timers })
    await flush()
    const socket = h.socket()
    socket.receive({
      type: 'error',
      requestId: socket.last('pairing.redeem').requestId,
      error: {
        code: 'auth',
        message: 'This pairing link was already used.',
        details: { reason: 'used' },
      },
    })
    expect(await redeemed).toEqual({ ok: false, failure: { kind: 'rejected', reason: 'used' } })
  })

  it('asks a latched connection again before redeeming, rather than reading the old refusal', async () => {
    const h = harness({ routes: [LAN], appOrigins: { [ENV]: APP } })
    await h.controller.start()
    await flush()
    h.socket().drop(4401, 'revoked')
    await flush()
    expect(h.state().status).toBe('unauthorized')
    const sockets = h.sockets().length
    const redeemed = redeemLink(read(linkTo(LAN)), h.controller, { timers: h.timers })
    await flush()
    expect(h.sockets().length).toBeGreaterThanOrEqual(sockets)
    expect(h.probes.length).toBeGreaterThan(1)
    h.timers.advance(20_000)
    expect((await redeemed).ok).toBe(false)
  })

  it('gives up on redeeming when the connection does not come up', async () => {
    const h = harness({ routes: [LAN] })
    await h.controller.start()
    await flush()
    const waiting = connectedClient(h.controller, ENV, { timers: h.timers, timeoutMs: 5000 })
    h.timers.advance(5000)
    expect(await waiting).toBeNull()
    const redeemed = redeemLink(read(linkTo(LAN)), h.controller, {
      timers: h.timers,
      timeoutMs: 5000,
    })
    h.timers.advance(5000)
    expect(await redeemed).toEqual({
      ok: false,
      failure: { kind: 'not_connected', label: 'Studio' },
    })
  })

  it('asks before exchanging for an environment whose token is gone at a new address', async () => {
    const h = harness({ routes: [LAN], credentials: {} })
    await h.controller.start()
    const link = read(linkTo(TUNNEL))
    // The shared rule: no saved token would be sent. The address would still
    // join the record, so the person is asked all the same.
    expect(h.controller.classifyRoute({ environmentId: ENV, endpoint: TUNNEL })).toEqual({
      kind: 'new_route',
      sendsSavedCredential: false,
    })
    expect(planPairing(link, h.controller)).toEqual({
      kind: 'consent',
      label: 'Studio',
      route: TUNNEL,
      then: 'exchange',
      sendsSavedCredential: false,
    })
    // A known address for it needs no question.
    expect(planPairing(read(linkTo(LAN)), h.controller)).toEqual({ kind: 'exchange' })
    const { fetchImpl } = pairFetch(() => json(200, answer()))
    expect((await exchangeLink(link, {}, h.controller, fetchImpl)).ok).toBe(true)
    await h.controller.flush()
    expect(h.storage.secret(ENV)).toBe(PHONE_TOKEN)
    expect(
      h.storage
        .document()!
        .environments[0]!.routes.map((r) => r.endpoint)
        .sort(),
    ).toEqual([LAN, TUNNEL].sort())
    expect(h.storage.document()!.environments[0]!.appOrigin).toBe(APP)
  })

  it('selects a different saved environment to redeem over its connection', async () => {
    const h = harness({
      registry: {
        selectedId: OTHER_ENV,
        environments: [
          ...registryWith([TUNNEL], OTHER_ENV).environments,
          ...registryWith([LAN]).environments,
        ],
      },
      credentials: { [ENV]: TOKEN, [OTHER_ENV]: 'o'.repeat(43) },
      answers: { [LAN]: ready(), [TUNNEL]: ready(OTHER_ENV) },
    })
    await h.controller.start()
    await flush()
    const redeemed = redeemLink(read(linkTo(LAN)), h.controller, { timers: h.timers })
    await flush()
    expect(h.state().selectedId).toBe(ENV)
    h.socket().accept(ENV, ['connection.heartbeat', 'pairing.redeem'])
    await flush()
    h.socket().respond('pairing.redeem', {
      clientId: 'client-phone',
      clientLabel: 'Pixel 9',
      grant: ['read'],
      grantChanged: false,
    })
    expect((await redeemed).ok).toBe(true)
  })
})

async function connect(h: ReturnType<typeof harness>) {
  await h.controller.start()
  await flush()
  h.socket().accept()
  await flush()
  expect(h.state().status).toBe('connected')
}
