import { describe, expect, it } from 'vitest'
import { encodePairingLink } from '@openmanager/environment-client'
import { createPairingSession } from '../src/pairing/session'
import { ENV, LAN, PAIRING_TOKEN, TUNNEL, flush, harness, ready } from './support'

const APP = 'https://app.example.test'
const link = (route: string) =>
  encodePairingLink(`${APP}/`, { route, environmentId: ENV, token: PAIRING_TOKEN })

const exchangeAnswer = () =>
  new Response(
    JSON.stringify({
      environmentId: ENV,
      label: 'Studio',
      kind: 'paired',
      clientId: 'client-phone',
      clientLabel: 'Pixel 9',
      grant: ['read'],
      credential: 'p'.repeat(43),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

describe('the pairing session', () => {
  it('runs a pairing to the end with no screen attached to watch it, and keeps the result', async () => {
    const h = harness({ registry: { selectedId: null, environments: [] }, credentials: {} })
    await h.controller.start()
    const session = createPairingSession()
    let paired = 0
    session.attach({
      controller: h.controller,
      fetch: (async () => exchangeAnswer()) as typeof fetch,
      onPaired: () => (paired += 1),
    })
    const seen: string[] = []
    const stop = session.subscribe(() => seen.push(session.getSnapshot().phase.kind))
    session.submit(link(LAN), 'scan', 'Pixel 9')
    // A second read of the same code while the first is running does nothing.
    session.submit(link(LAN), 'scan', 'Pixel 9')
    stop()
    await flush()
    expect(session.getSnapshot()).toMatchObject({
      phase: { kind: 'paired', paired: { environmentId: ENV, how: 'exchanged' } },
      source: 'scan',
      route: LAN,
    })
    // The link's route, then connecting; the second read added nothing.
    expect(seen).toEqual(['idle', 'connecting'])
    expect(paired).toBe(1)
    expect(session.active()).toBe(true)
    expect(session.shown()).toBe(false)
    const unmount = session.mountScreen()
    expect(session.shown()).toBe(true)
    unmount()
    session.reset()
    expect(session.getSnapshot()).toEqual({ phase: { kind: 'idle' }, source: null, route: null })
    expect(session.active()).toBe(false)
  })

  it('fails a link it cannot read, and a new link starts over', async () => {
    const h = harness({ registry: { selectedId: null, environments: [] }, credentials: {} })
    await h.controller.start()
    const session = createPairingSession()
    let failed = 0
    session.attach({
      controller: h.controller,
      fetch: (async () => exchangeAnswer()) as typeof fetch,
      onFailed: () => (failed += 1),
    })
    session.submit('hello', 'paste', undefined)
    expect(session.getSnapshot().phase).toEqual({
      kind: 'failed',
      failure: { kind: 'link', problem: 'not_a_link' },
    })
    expect(failed).toBe(1)
    session.reset()
    expect(session.getSnapshot().phase.kind).toBe('idle')
  })

  it('waits for consent before a new address joins, and declining leaves the record alone', async () => {
    const h = harness({ routes: [LAN] })
    h.answers.set(TUNNEL, ready())
    await h.controller.start()
    await flush()
    const session = createPairingSession()
    session.attach({
      controller: h.controller,
      fetch: (async () => exchangeAnswer()) as typeof fetch,
    })
    session.submit(link(TUNNEL), 'paste', undefined)
    await flush()
    expect(session.getSnapshot().phase).toEqual({
      kind: 'consent',
      label: 'Studio',
      route: TUNNEL,
      then: 'redeem',
      sendsSavedCredential: true,
    })
    session.decline()
    expect(session.getSnapshot().phase).toEqual({ kind: 'declined', label: 'Studio' })
    await h.controller.flush()
    expect(h.storage.document()!.environments[0]!.routes.map((r) => r.endpoint)).toEqual([LAN])
    // Declined drops the link: trying again has nothing to use.
    session.retry()
    expect(session.getSnapshot().phase.kind).toBe('idle')
  })
})
