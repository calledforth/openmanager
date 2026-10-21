import { describe, expect, it } from 'vitest'
import { ENVIRONMENT_STORAGE_KEY } from '@openmanager/environment-client/connection'
import { createPhoneStorage } from '../src/storage/phone-storage'
import {
  ENV,
  LAN,
  OTHER_ENV,
  TOKEN,
  flush,
  harness,
  ready,
  registryWith,
  relaunchedStorage,
} from './support'

const APP = 'https://app.example.test'

describe("the controller on the phone's storage", () => {
  it('waits for the storage to load before reading or writing the registry', async () => {
    const h = harness()
    let loaded = false
    const hydrate = h.storage.hydrate
    h.storage.hydrate = async () => {
      await hydrate()
      loaded = true
    }
    const starting = h.controller.start()
    expect(h.state().status).toBe('starting')
    await starting
    expect(loaded).toBe(true)
    expect(h.state().environments.map((environment) => environment.environmentId)).toEqual([ENV])
  })

  it('asks the storage to load again on the retry delays when it fails, then connects', async () => {
    const h = harness({ options: { retryDelaysMs: [1000, 2000] } })
    const hydrate = h.storage.hydrate
    let failures = 2
    h.storage.hydrate = async () => {
      if (failures > 0) {
        failures -= 1
        throw new Error('AsyncStorage unreadable')
      }
      await hydrate()
    }
    const starting = h.controller.start()
    await flush()
    expect(h.state().status).toBe('starting')
    expect(h.warnings).toHaveLength(1)
    h.timers.advance(1000)
    await flush()
    expect(h.warnings).toHaveLength(2)
    h.timers.advance(2000)
    await starting
    await flush()
    expect(h.state().status).toBe('connecting')
  })

  it('saves a pairing whole: token to SecureStore, app origin and routes to AsyncStorage', async () => {
    const h = harness({ registry: { selectedId: null, environments: [] }, credentials: {} })
    await h.controller.start()
    h.controller.saveEnvironment({
      environmentId: ENV,
      endpoint: LAN,
      label: 'Studio',
      credential: TOKEN,
      appOrigin: APP,
    })
    await h.controller.flush()
    expect(h.storage.secret(ENV)).toBe(TOKEN)
    expect(JSON.stringify(h.storage.asyncStore.dump())).not.toContain(TOKEN)
    expect(h.storage.document()!.environments[0]).toMatchObject({
      environmentId: ENV,
      appOrigin: APP,
    })

    // The next launch reads both back, joined.
    const next = createPhoneStorage(h.storage)
    await next.hydrate()
    expect(
      JSON.parse(next.registry.getItem(ENVIRONMENT_STORAGE_KEY)!).environments[0],
    ).toMatchObject({ environmentId: ENV, credential: TOKEN, appOrigin: APP })
  })

  it('keeps every token when the registry changes for reasons of its own (health, label)', async () => {
    const registry = registryWith([LAN])
    registry.environments.push({ ...registryWith([LAN], OTHER_ENV).environments[0]!, label: 'B' })
    const h = harness({
      registry,
      credentials: { [ENV]: TOKEN, [OTHER_ENV]: 'o'.repeat(43) },
      answers: { [LAN]: ready(ENV, 'Office tower') },
    })
    await h.controller.start()
    await flush()
    h.socket().accept()
    await flush()
    await h.controller.flush()
    expect(h.storage.document()!.environments[0]!.label).toBe('Office tower')
    expect(h.storage.secret(ENV)).toBe(TOKEN)
    expect(h.storage.secret(OTHER_ENV)).toBe('o'.repeat(43))
  })
})

describe('a refused token', () => {
  it('is forgotten at once when the environment revoked it, and the latch holds', async () => {
    const h = harness()
    await h.controller.start()
    await flush()
    h.socket().accept()
    await flush()
    h.socket().drop(4401, 'revoked')
    await flush()
    await h.controller.flush()
    expect(h.state()).toMatchObject({
      status: 'unauthorized',
      routeFailure: { reason: 'credential_rejected' },
    })
    expect(h.state().environments[0]).toMatchObject({ environmentId: ENV, paired: false })
    expect(h.storage.secret(ENV)).toBeNull()
    // The environment stays, with its routes, to pair again.
    expect(h.storage.document()!.environments[0]!.routes[0]!.endpoint).toBe(LAN)
  })

  it('is forgotten when an unknown refusal comes from an address that is still this environment', async () => {
    const h = harness()
    await h.controller.start()
    await flush()
    h.socket().open()
    h.socket().drop(4401, 'unknown_client')
    await flush()
    await h.controller.flush()
    // One confirmation probe, at the address that refused it.
    expect(h.probes).toEqual([LAN, LAN])
    expect(h.storage.secret(ENV)).toBeNull()
    expect(h.state().status).toBe('unauthorized')
  })

  it('is kept when an unknown refusal comes from an address that is now another environment', async () => {
    const h = harness()
    await h.controller.start()
    await flush()
    h.answers.set(LAN, ready(OTHER_ENV, 'Someone else'))
    h.socket().open()
    h.socket().drop(4401, 'unknown_client')
    await flush()
    await h.controller.flush()
    expect(h.storage.secret(ENV)).toBe(TOKEN)
    expect(h.state()).toMatchObject({ status: 'unauthorized' })
    expect(h.state().environments[0]!.paired).toBe(true)
  })

  it('is kept when a new token was saved before the confirmation answered', async () => {
    const h = harness()
    await h.controller.start()
    await flush()
    let answer!: (outcome: ReturnType<typeof ready>) => void
    h.answers.set(LAN, new Promise((resolve) => (answer = resolve)))
    h.socket().open()
    h.socket().drop(4401, 'unknown_client')
    await flush()
    const fresh = 'n'.repeat(43)
    h.answers.set(LAN, ready())
    h.controller.saveEnvironment({ environmentId: ENV, endpoint: LAN, credential: fresh })
    answer(ready())
    await flush()
    await h.controller.flush()
    expect(h.storage.secret(ENV)).toBe(fresh)
  })

  it('is kept on a handshake auth refusal that is not the revocation close', async () => {
    const h = harness()
    await h.controller.start()
    await flush()
    const socket = h.socket()
    socket.open()
    socket.receive({
      type: 'error',
      requestId: socket.last('protocol.handshake').requestId,
      error: { code: 'auth', message: 'Not authorized.' },
    })
    await flush()
    await h.controller.flush()
    expect(h.state().status).toBe('unauthorized')
    expect(h.storage.secret(ENV)).toBe(TOKEN)
  })
})

describe('relaunched storage', () => {
  it('reads back a registry an earlier launch wrote', async () => {
    const registry = registryWith([LAN])
    registry.environments[0]!.credential = TOKEN
    const storage = relaunchedStorage(registry)
    await storage.hydrate()
    expect(storage.secret(ENV)).toBe(TOKEN)
    expect(storage.document()!.environments[0]!.environmentId).toBe(ENV)
  })
})
