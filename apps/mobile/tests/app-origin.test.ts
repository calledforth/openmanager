import { describe, expect, it } from 'vitest'
import { encodePairingLink } from '@openmanager/environment-client'
import {
  ENVIRONMENT_STORAGE_KEY,
  writeEnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import {
  PHONE_APP_ORIGINS_STORAGE_KEY,
  appOriginFromPairingLink,
  parseAppOrigin,
  readAppOrigins,
  serializeAppOrigins,
  withSocketOrigin,
} from '../src/environment/app-origin'
import { createRegistryPersistence } from '../src/environment/persistence'
import { createMemoryPhoneStorage } from '../src/environment/phone-storage'
import {
  ENV,
  LAN,
  OTHER_ENV,
  PAIRING_TOKEN,
  TOKEN,
  TUNNEL,
  FakeSocket,
  flush,
  harness,
  ready,
  registryWith,
} from './support'

const APP = 'https://app.example.test'

const link = (appUrl: string) =>
  encodePairingLink(appUrl, { route: TUNNEL, environmentId: ENV, token: PAIRING_TOKEN })

describe('app origin', () => {
  it('is the origin of the pairing link, wherever the app is served under', () => {
    expect(appOriginFromPairingLink(link('https://app.example.test/'))).toBe(APP)
    expect(appOriginFromPairingLink(link('https://app.example.test/console/'))).toBe(APP)
    expect(appOriginFromPairingLink(link('http://192.168.1.20:5173/'))).toBe(
      'http://192.168.1.20:5173',
    )
  })

  it('is not taken from a bare fragment, a link that is not a pairing link, or another scheme', () => {
    const fragment = new URL(link(`${APP}/`)).hash
    expect(appOriginFromPairingLink(fragment)).toBeNull()
    expect(appOriginFromPairingLink(`${APP}/pair`)).toBeNull()
    expect(appOriginFromPairingLink(link(`${APP}/`).replace('https:', 'openmanager:'))).toBeNull()
    expect(parseAppOrigin('file:///pair')).toBeNull()
    expect(parseAppOrigin('https://user:pw@app.example.test')).toBeNull()
    expect(parseAppOrigin(42)).toBeNull()
  })

  it('reads back only well-formed entries', () => {
    const storage = createMemoryPhoneStorage({
      registry: {
        [PHONE_APP_ORIGINS_STORAGE_KEY]: JSON.stringify({
          version: 1,
          origins: { [ENV]: `${APP}/ignored-path`, [OTHER_ENV]: 'not a url', '': APP },
        }),
      },
    })
    expect([...readAppOrigins(storage.registry)]).toEqual([[ENV, APP]])
    const junk = createMemoryPhoneStorage({ registry: { [PHONE_APP_ORIGINS_STORAGE_KEY]: '{' } })
    expect(readAppOrigins(junk.registry).size).toBe(0)
  })
})

describe('the socket wrapper', () => {
  it("puts the app origin in React Native's headers option and keeps the socket's identity", () => {
    FakeSocket.instances = []
    const Wrapped = withSocketOrigin(FakeSocket, APP)
    const socket = new Wrapped('wss://studio.example.com/ws', ['openmanager.v1'])
    expect(socket).toBeInstanceOf(FakeSocket)
    const fake = socket as unknown as FakeSocket
    expect(fake.options).toEqual({ headers: { origin: APP } })
    expect(fake.protocols).toEqual(['openmanager.v1'])
    expect(fake.origin).toBe(APP)
    expect(FakeSocket.instances).toEqual([fake])
  })

  it("leaves React Native's own default, the route's origin, when unwrapped", () => {
    const socket = new FakeSocket('wss://studio.example.com/ws')
    expect(socket.origin).toBe('https://studio.example.com')
  })
})

describe('app origin in the registry seam', () => {
  it('is saved beside the registry, never in it, and pruned with its environment', async () => {
    const storage = createMemoryPhoneStorage()
    const persistence = createRegistryPersistence(storage)
    await persistence.load()
    const both = registryWith([LAN])
    both.environments.push(registryWith([TUNNEL], OTHER_ENV).environments[0]!)
    persistence.save(
      both,
      new Map([
        [ENV, APP],
        [OTHER_ENV, 'https://other.example.test'],
      ]),
    )
    await persistence.flush()
    expect(storage.registry.getItem(ENVIRONMENT_STORAGE_KEY)).not.toContain(APP)
    expect(readAppOrigins(storage.registry).get(ENV)).toBe(APP)

    persistence.save(
      { ...both, environments: [both.environments[0]!] },
      new Map([
        [ENV, APP],
        [OTHER_ENV, 'https://other.example.test'],
      ]),
    )
    await persistence.flush()
    expect([...readAppOrigins(storage.registry)]).toEqual([[ENV, APP]])

    persistence.save({ selectedId: null, environments: [] }, new Map())
    await persistence.flush()
    expect(storage.registry.getItem(PHONE_APP_ORIGINS_STORAGE_KEY)).toBeNull()
  })

  it('loads an environment saved before the field existed with no app origin', async () => {
    const storage = createMemoryPhoneStorage({ credentials: { [ENV]: TOKEN } })
    writeEnvironmentRegistry(registryWith([LAN]), storage.registry)
    const { registry, appOrigins } = await createRegistryPersistence(storage).load()
    expect(registry.environments).toHaveLength(1)
    expect(appOrigins.size).toBe(0)
  })

  it('writes the same document for the same origins', () => {
    expect(serializeAppOrigins(new Map([[ENV, APP]]))).toBe(
      serializeAppOrigins(new Map([[ENV, APP]])),
    )
  })
})

describe('the controller and the app origin', () => {
  it('dials with the saved app origin and says so', async () => {
    const h = harness({ appOrigins: { [ENV]: APP } })
    await h.controller.start()
    await flush()
    expect(h.socket().origin).toBe(APP)
    expect(h.state().socketOrigin).toEqual({ origin: APP, from: 'app' })
    expect(h.state().environments[0]!.appOrigin).toBe(APP)
    expect(h.warnings).toEqual([])
  })

  it("falls back to the route's origin for an environment paired before the field, visibly and once", async () => {
    const h = harness({ routes: [LAN] })
    await h.controller.start()
    await flush()
    expect(h.socket().options).toBeUndefined()
    expect(h.socket().origin).toBe(LAN)
    expect(h.state().socketOrigin).toEqual({ origin: LAN, from: 'route' })
    expect(h.state().environments[0]!.appOrigin).toBeNull()
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain(ENV)

    h.socket().drop()
    await flush()
    h.timers.advance(1000)
    await flush()
    expect(h.sockets()).toHaveLength(2)
    expect(h.warnings).toHaveLength(1)
  })

  it('records the app origin a pairing brings and dials with it', async () => {
    const h = harness({ routes: [LAN] })
    await h.controller.start()
    await flush()
    expect(h.state().socketOrigin?.from).toBe('route')

    h.controller.saveEnvironment({
      environmentId: ENV,
      endpoint: TUNNEL,
      credential: 'n'.repeat(43),
      appOrigin: appOriginFromPairingLink(link(`${APP}/`)),
    })
    h.answers.set(TUNNEL, ready())
    await flush()
    // The new token's socket, on whichever route answered first in order.
    expect(h.sockets()).toHaveLength(2)
    expect(h.sockets()[0]!.origin).toBe(LAN)
    expect(h.socket().origin).toBe(APP)
    expect(h.state().socketOrigin).toEqual({ origin: APP, from: 'app' })
    await h.controller.flush()
    expect(readAppOrigins(h.storage.registry).get(ENV)).toBe(APP)
  })

  it('keeps the saved app origin when a later save brings none, and forgets it with the environment', async () => {
    const h = harness({ appOrigins: { [ENV]: APP } })
    await h.controller.start()
    await flush()
    h.controller.saveEnvironment({ environmentId: ENV, endpoint: LAN, credential: TOKEN })
    await flush()
    expect(h.state().environments[0]!.appOrigin).toBe(APP)

    h.controller.removeEnvironment(ENV)
    await h.controller.flush()
    expect(h.storage.registry.getItem(PHONE_APP_ORIGINS_STORAGE_KEY)).toBeNull()
  })

  it('retires a connected socket when only the app origin changes', async () => {
    const h = harness({ appOrigins: { [ENV]: 'https://old.example.test' } })
    await h.controller.start()
    await flush()
    h.socket().accept()
    await flush()
    expect(h.state()).toMatchObject({ status: 'connected' })
    const first = h.socket()

    h.controller.saveEnvironment({
      environmentId: ENV,
      endpoint: LAN,
      credential: TOKEN,
      appOrigin: APP,
    })
    await flush()
    expect(first.readyState).toBe(3)
    expect(h.sockets()).toHaveLength(2)
    expect(h.socket().origin).toBe(APP)
    expect(h.state().socketOrigin).toEqual({ origin: APP, from: 'app' })
  })

  it('refuses an app origin that is not an http(s) origin', async () => {
    const h = harness()
    await h.controller.start()
    expect(() =>
      h.controller.saveEnvironment({
        environmentId: ENV,
        endpoint: LAN,
        credential: TOKEN,
        appOrigin: 'javascript:alert(1)',
      }),
    ).toThrow(/app address/)
  })
})
