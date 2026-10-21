/**
 * Pair, use, rotate, revoke and remove an environment through the phone's
 * storage and the shared registry code, printing what AsyncStorage holds after
 * each step. Exits non-zero if any credential ever appears in it.
 *
 * AsyncStorage is the package's own Jest mock (its in-memory store); SecureStore
 * is an in-memory stand-in. From the repo root:
 *
 *     pnpm exec jiti apps/mobile/scripts/dump-phone-store.ts
 */
import { createRequire } from 'node:module'
import {
  exchangePairingToken,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  setStoredCredential,
  setStoredRouteHealth,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import { forgetRejectedCredential } from '../src/storage/credential-rejection'
import { createPhoneStorage } from '../src/storage/phone-storage'
import type { AsyncKeyValueStore, SecureKeyValueStore } from '../src/storage/ports'

// The mock is written for Jest; a pass-through `fn` is all it needs.
;(globalThis as { jest?: unknown }).jest = { fn: <T>(impl: T) => impl }
const require = createRequire(import.meta.url)
const asyncStore =
  require('@react-native-async-storage/async-storage/jest/async-storage-mock') as AsyncKeyValueStore & {
    __INTERNAL_MOCK_STORAGE__: Record<string, string>
  }

const secrets = new Map<string, string>()
const secureStore: SecureKeyValueStore = {
  getItemAsync: async (key) => secrets.get(key) ?? null,
  setItemAsync: async (key, value) => void secrets.set(key, value),
  deleteItemAsync: async (key) => void secrets.delete(key),
}

const ENDPOINT = 'https://studio.example.com'
const PAIRED = 'cred_' + 'Zx8Qm2Lp'.repeat(8)
const ROTATED = 'cred_' + 'Hk4Tn7Wc'.repeat(8)
const tokens = [PAIRED, ROTATED]
let leaked = false

function dump(step: string) {
  const store = asyncStore.__INTERNAL_MOCK_STORAGE__
  const text = JSON.stringify(store)
  const found = tokens.filter((token) => text.includes(token))
  if (found.length > 0) leaked = true
  console.log(`\n## ${step}`)
  console.log('AsyncStorage:')
  for (const [key, value] of Object.entries(store)) console.log(`  ${key} = ${value}`)
  console.log(`SecureStore keys: ${[...secrets.keys()].join(', ') || '(none)'}`)
  console.log(`credential in AsyncStorage: ${found.length > 0 ? `YES (${found.length})` : 'no'}`)
}

async function main() {
  const storage = createPhoneStorage({ asyncStore, secureStore })
  await storage.hydrate()
  dump('fresh install')

  // POST /pair, answered the way the environment answers it.
  const answer = await exchangePairingToken(
    ENDPOINT,
    { token: 'pairing-token-from-qr', label: 'Pixel 9' },
    (async () =>
      new Response(
        JSON.stringify({
          environmentId: 'env-studio',
          label: 'Studio',
          kind: 'paired',
          clientId: 'client-pixel',
          clientLabel: 'Pixel 9',
          grant: ['read', 'operate'],
          credential: PAIRED,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
  )
  let registry = upsertStoredEnvironment(readEnvironmentRegistry(storage.registry), {
    environmentId: answer.environmentId,
    endpoint: ENDPOINT,
    label: answer.label,
    credential: answer.credential,
  })!
  writeEnvironmentRegistry(registry, storage.registry)
  await storage.flush()
  dump('after pairing')

  registry = setStoredRouteHealth(registry, answer.environmentId, ENDPOINT, { status: 'available' })
  writeEnvironmentRegistry(registry, storage.registry)
  await storage.flush()
  dump('after a route-health update')

  const relaunched = createPhoneStorage({ asyncStore, secureStore })
  await relaunched.hydrate()
  const reread = readEnvironmentRegistry(relaunched.registry)
  console.log(
    `\nrelaunch reads the credential back from SecureStore: ${reread.environments[0]?.credential === PAIRED}`,
  )

  registry = setStoredCredential(reread, answer.environmentId, ROTATED)
  writeEnvironmentRegistry(registry, relaunched.registry)
  await relaunched.flush()
  dump('after the environment rotated the credential')

  registry = forgetRejectedCredential(registry, answer.environmentId, ROTATED)
  writeEnvironmentRegistry(registry, relaunched.registry)
  await relaunched.flush()
  dump('after the environment revoked it (4401)')

  registry = removeStoredEnvironment(registry, answer.environmentId)
  writeEnvironmentRegistry(registry, relaunched.registry)
  await relaunched.flush()
  dump('after removing the environment')

  console.log(
    `\nRESULT: ${leaked ? 'a credential reached AsyncStorage' : 'no credential ever reached AsyncStorage'}`,
  )
  process.exitCode = leaked ? 1 : 0
}

void main()
