import { describe, expect, it } from 'vitest'
import { encodePairingLink } from '@openmanager/environment-client'
import type { BootstrapOutcome } from '@openmanager/environment-client/connection'

import { phoneConnectionView } from '../src/environment/connection-ui'
import {
  credentialRefused,
  mayRedeem,
  planPairing,
  redeemLink,
  type PairingIntent,
} from '../src/pairing/flow'
import { readPairingLink, type PairingLinkRead } from '../src/pairing/link'
import { createPairingSession } from '../src/pairing/session'
import {
  ENV,
  LAN,
  OTHER_ENV,
  PAIRING_TOKEN,
  TOKEN,
  TUNNEL,
  deferred,
  flush,
  harness,
  ready,
} from './support'

const APP = 'https://app.example.test'
const FRESH = 'f'.repeat(43)
const REPAIR: PairingIntent = { kind: 'repair', environmentId: ENV }

const linkTo = (route: string) =>
  encodePairingLink(`${APP}/`, { route, environmentId: ENV, token: PAIRING_TOKEN })

function read(text: string): PairingLinkRead {
  const result = readPairingLink(text)
  if (!result.ok) throw new Error('not a link')
  return result.link
}

const exchangeAnswer = (environmentId = ENV) =>
  new Response(
    JSON.stringify({
      environmentId,
      label: 'Studio',
      kind: 'paired',
      clientId: 'client-phone',
      clientLabel: 'Pixel 9',
      grant: ['read', 'operate', 'agent'],
      credential: FRESH,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

/** The token each socket the phone dialled carried. */
const tokensDialled = (h: ReturnType<typeof harness>) =>
  h.sockets().map((socket) => {
    const protocols = ([] as string[]).concat(socket.protocols ?? [])
    return protocols.find((item) => item.startsWith('openmanager.auth.'))?.slice(17) ?? null
  })

/**
 * Connected, then refused with an `unknown` refusal (what answered did not
 * know the token). The phone asks the same route which environment it is
 * before forgetting the token: `confirmation` is that answer, held as long
 * as the test likes. Until it says "this environment", the token stays saved
 * and the environment still reads as paired.
 */
async function refusedUnconfirmed(confirmation: Promise<BootstrapOutcome>) {
  const h = harness({ routes: [LAN], appOrigins: { [ENV]: APP } })
  await h.controller.start()
  await flush()
  h.socket().accept()
  await flush()
  expect(h.state().status).toBe('connected')
  h.answers.set(LAN, confirmation)
  h.socket().drop(4401, 'unauthorized')
  await flush()
  expect(h.state().status).toBe('unauthorized')
  expect(h.state().environments[0]!.paired).toBe(true)
  expect(h.storage.secret(ENV)).toBe(TOKEN)
  return h
}

const pending = () => deferred<BootstrapOutcome>().promise
const failing = () => Promise.resolve(ready(OTHER_ENV))

describe.each([
  ['pending', pending],
  ['answered by another environment', failing],
])('pairing again while the refusal is unconfirmed (%s)', (_name, confirmation) => {
  it('plans an exchange, with or without the intent, and never a redeem', async () => {
    const h = await refusedUnconfirmed(confirmation())
    const link = read(linkTo(LAN))
    expect(credentialRefused(h.controller, ENV)).toBe(true)
    expect(mayRedeem(h.controller, ENV, REPAIR)).toBe(false)
    expect(planPairing(link, h.controller, REPAIR)).toEqual({ kind: 'exchange' })
    expect(planPairing(link, h.controller)).toEqual({ kind: 'exchange' })
    // The next step the panel offers carries that environment.
    expect(phoneConnectionView(h.state())).toMatchObject({
      environmentId: ENV,
      next: ['pair_again'],
    })
  })

  it('exchanges the fresh link without dialling the refused token, then connects on the new one', async () => {
    const h = await refusedUnconfirmed(confirmation())
    const socketsAtRefusal = h.sockets().length
    const calls: string[] = []
    const session = createPairingSession()
    session.attach({
      controller: h.controller,
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        // Nothing redialled while the link was being used.
        expect(h.sockets().length).toBe(socketsAtRefusal)
        return exchangeAnswer()
      }) as typeof fetch,
    })
    // The route answers again once the new token is saved.
    h.answers.set(LAN, ready())
    session.submit(linkTo(LAN), 'paste', 'Pixel 9', REPAIR)
    await flush()
    expect(calls).toEqual([`${LAN}/pair`])
    expect(session.getSnapshot().phase).toMatchObject({
      kind: 'paired',
      paired: { environmentId: ENV, how: 'exchanged' },
    })
    await h.controller.flush()
    expect(h.storage.secret(ENV)).toBe(FRESH)
    h.socket().accept()
    await flush()
    expect(h.state().status).toBe('connected')
    // Every socket after the refusal carried the new token; the refused one
    // was never sent again.
    expect(tokensDialled(h).slice(socketsAtRefusal)).not.toContain(TOKEN)
    expect(tokensDialled(h).at(-1)).toBe(FRESH)
  })

  it('keeps the saved token when the link’s route answers as another environment', async () => {
    const h = await refusedUnconfirmed(confirmation())
    const session = createPairingSession()
    session.attach({
      controller: h.controller,
      fetch: (async () => exchangeAnswer(OTHER_ENV)) as typeof fetch,
    })
    session.submit(linkTo(LAN), 'paste', 'Pixel 9', REPAIR)
    await flush()
    expect(session.getSnapshot().phase).toMatchObject({
      kind: 'failed',
      failure: { kind: 'environment_mismatch' },
    })
    await h.controller.flush()
    // Nothing the route said replaced or cleared it, and nothing redialled.
    expect(h.storage.secret(ENV)).toBe(TOKEN)
    expect(h.state().status).toBe('unauthorized')
  })

  it('a redeem reached anyway gives up at once instead of redialling', async () => {
    const h = await refusedUnconfirmed(confirmation())
    const sockets = h.sockets().length
    const probes = h.probes.length
    expect(await redeemLink(read(linkTo(LAN)), h.controller, { timers: h.timers })).toEqual({
      ok: false,
      failure: { kind: 'not_connected', label: 'Studio' },
    })
    await flush()
    expect(h.sockets().length).toBe(sockets)
    expect(h.probes.length).toBe(probes)
    expect(h.state().status).toBe('unauthorized')
  })
})

describe('pairing again, otherwise', () => {
  it('a refusal that lands while the new-address question is open turns the agreed redeem into an exchange', async () => {
    const h = harness({
      routes: [LAN],
      appOrigins: { [ENV]: APP },
      answers: { [LAN]: ready(), [TUNNEL]: ready() },
    })
    await h.controller.start()
    await flush()
    h.socket().accept()
    await flush()
    const calls: string[] = []
    const session = createPairingSession()
    session.attach({
      controller: h.controller,
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return exchangeAnswer()
      }) as typeof fetch,
    })
    session.submit(linkTo(TUNNEL), 'paste', 'Pixel 9')
    await flush()
    expect(session.getSnapshot().phase).toMatchObject({ kind: 'consent', then: 'redeem' })
    h.answers.set(LAN, pending())
    h.socket().drop(4401, 'unauthorized')
    await flush()
    const sockets = h.sockets().length
    session.accept()
    await flush()
    expect(calls).toEqual([`${TUNNEL}/pair`])
    expect(tokensDialled(h).slice(sockets)).not.toContain(TOKEN)
    expect(session.getSnapshot().phase).toMatchObject({ kind: 'paired' })
  })

  it('the intent redeems only over a connection that is up right now', async () => {
    const h = harness({ routes: [LAN], appOrigins: { [ENV]: APP } })
    await h.controller.start()
    await flush()
    // Not connected yet: pairing again exchanges.
    expect(planPairing(read(linkTo(LAN)), h.controller, REPAIR)).toEqual({ kind: 'exchange' })
    // Without the intent, a paired environment redeems as before.
    expect(planPairing(read(linkTo(LAN)), h.controller)).toEqual({
      kind: 'redeem',
      label: 'Studio',
    })
    h.socket().accept()
    await flush()
    expect(planPairing(read(linkTo(LAN)), h.controller, REPAIR)).toEqual({
      kind: 'redeem',
      label: 'Studio',
    })
  })
})
