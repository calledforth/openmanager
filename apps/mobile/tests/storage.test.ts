import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_STORAGE_KEY,
  writeEnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import { createRegistryPersistence } from '../src/environment/persistence'
import { createMemoryPhoneStorage, type CredentialStore } from '../src/environment/phone-storage'
import { isLocalNetworkEndpoint, phoneSearchOrder } from '../src/environment/route-order'
import { ENV, LAN, OTHER_ENV, TOKEN, TUNNEL, registryWith } from './support'

describe('registry persistence', () => {
  it('fills each environment token from the credential store', async () => {
    const storage = createMemoryPhoneStorage({ credentials: { [ENV]: TOKEN } })
    writeEnvironmentRegistry(registryWith([LAN]), storage.registry)
    const registry = await createRegistryPersistence(storage).load()
    expect(registry.environments[0]).toMatchObject({ environmentId: ENV, credential: TOKEN })
  })

  it('moves a token found in the registry document into the credential store', async () => {
    const storage = createMemoryPhoneStorage()
    const registry = registryWith([LAN])
    registry.environments[0]!.credential = TOKEN
    writeEnvironmentRegistry(registry, storage.registry)

    const loaded = await createRegistryPersistence(storage).load()
    expect(loaded.environments[0]!.credential).toBe(TOKEN)
    expect(storage.credentials.snapshot()).toEqual({ [ENV]: TOKEN })
    expect(storage.registry.getItem(ENVIRONMENT_STORAGE_KEY)).not.toContain(TOKEN)
  })

  it('saves in order, deletes a forgotten environment token, and never writes one to the document', async () => {
    const storage = createMemoryPhoneStorage()
    const persistence = createRegistryPersistence(storage)
    await persistence.load()
    const both = registryWith([LAN])
    both.environments[0]!.credential = TOKEN
    both.environments.push({
      ...registryWith([TUNNEL], OTHER_ENV).environments[0]!,
      credential: 'o'.repeat(43),
    })
    persistence.save(both)
    persistence.save({ ...both, environments: [both.environments[0]!] })
    await persistence.flush()
    expect(storage.credentials.snapshot()).toEqual({ [ENV]: TOKEN })
    const document = storage.registry.getItem(ENVIRONMENT_STORAGE_KEY)!
    expect(document).not.toContain(TOKEN)
    expect(JSON.parse(document).environments).toHaveLength(1)
  })

  it('repeats a credential write that failed on the next save', async () => {
    const storage = createMemoryPhoneStorage()
    const real = storage.credentials
    let failNext = true
    const flaky: CredentialStore = {
      ...real,
      setCredential: async (id, credential) => {
        if (failNext) {
          failNext = false
          throw new Error('keychain locked')
        }
        await real.setCredential(id, credential)
      },
    }
    const persistence = createRegistryPersistence({ ...storage, credentials: flaky })
    await persistence.load()
    const registry = registryWith([LAN])
    registry.environments[0]!.credential = TOKEN
    persistence.save(registry)
    await persistence.flush()
    expect(real.snapshot()).toEqual({})
    persistence.save(registry)
    await persistence.flush()
    expect(real.snapshot()).toEqual({ [ENV]: TOKEN })
  })
})

describe('phone route order', () => {
  it('counts private, link-local and mDNS addresses as the local network', () => {
    for (const endpoint of [
      'http://10.0.0.4:43120',
      'http://172.16.0.9:43120',
      'http://172.31.255.1',
      'http://192.168.1.20:43120',
      'http://169.254.10.2',
      'http://studio.local:43120',
      'http://studio.home.arpa',
      'http://[fd12:3456::1]:43120',
      'http://[fe80::1]:43120',
    ]) {
      expect(isLocalNetworkEndpoint(endpoint), endpoint).toBe(true)
    }
    for (const endpoint of [
      'https://studio.example.com',
      'http://172.32.0.1',
      'http://100.64.0.7:43120',
      'http://8.8.8.8',
      'http://[2001:db8::1]',
      'not a url',
    ]) {
      expect(isLocalNetworkEndpoint(endpoint), endpoint).toBe(false)
    }
  })

  it('puts local-network routes ahead of the rest, each group in the person order', () => {
    const environment = registryWith([
      TUNNEL,
      'https://backup.example.com',
      LAN,
      'http://10.0.0.4:43120',
    ]).environments[0]!
    expect(phoneSearchOrder(environment).routes.map((route) => route.endpoint)).toEqual([
      LAN,
      'http://10.0.0.4:43120',
      TUNNEL,
      'https://backup.example.com',
    ])
    // The saved record is left as it was.
    expect(environment.routes[0]!.endpoint).toBe(TUNNEL)
  })

  it('hands the record back unchanged when there is nothing to reorder', () => {
    const environment = registryWith([TUNNEL]).environments[0]!
    expect(phoneSearchOrder(environment)).toBe(environment)
  })
})
