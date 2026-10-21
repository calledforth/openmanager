# Phone storage

Where the phone keeps its environments: the registry (environments, labels,
routes, route health, the selection) in AsyncStorage, each environment's
credential in SecureStore under its environment ID. The registry logic is
the shared one in `@openmanager/environment-client/connection`; only the
storage differs from web.

## For the connection controller

```ts
import {
  phoneStorage,
  subscribePhonePageExit,
  forgetRejectedCredential,
  isRevokedCredentialReport,
  environmentNeedsPairing,
} from '@/storage'

// 1. At boot, before anything reads the registry (keep the splash up):
await phoneStorage.hydrate()

// 2. Everywhere web passes `browserRegistryStorage`:
readEnvironmentRegistry(phoneStorage.registry)
writeEnvironmentRegistry(next, phoneStorage.registry)
clearEnvironmentRegistry(phoneStorage.registry)

// 3. The device host for app-core (both identities are fixed for the app's life):
<EnvironmentApplicationProviders
  storage={phoneStorage.device}
  subscribePageExit={subscribePhonePageExit}
/>

// 4. When a socket report says the environment refused the credential:
//    report = routeHealthFromConnection(connection), credential = the one that socket carried
if (isRevokedCredentialReport(report)) {
  // the shared latch, exactly as web: routeFailure = credential_rejected, no search, no retry
  update((current) => forgetRejectedCredential(current, environmentId, credential))
}

// 5. The re-pair path: an environment with no credential.
environmentNeedsPairing(findStoredEnvironment(registry.environments, id))
```

`phoneStorage.registry` and `phoneStorage.device` throw until `hydrate()`
resolves. The shared functions read that as an empty registry that is not
saved, so a premature read cannot overwrite the device, but the controller
should not mount before hydration. If `hydrate()` rejects (AsyncStorage
unreadable), call it again; it retries.

`phoneStorage.flush()` resolves once every write so far is on the device. It
is not needed for correctness (writes start at once); it is for tests and for
holding a background task open.

## The decisions

- **Sync interface, hydrated mirror.** The shared `RegistryStorage` stays
  synchronous: web's connection provider reads the registry in a `useState`
  initialiser, inside every `update` (`adoptPersistedCredentials`), and in
  socket-report callbacks, all synchronously. Both stores load once into
  memory; reads come from memory; writes change memory at once and persist
  through one serial queue, in call order. Consecutive writes to the same
  AsyncStorage key collapse into the last; SecureStore writes never collapse.
- **Credential split at the storage seam.** The shared registry document
  embeds `credential` in each environment. At `openmanager-environments` the
  adapter strips it before AsyncStorage, writes it to SecureStore, and joins
  it back on read. A document that cannot be split, or that still contains a
  known credential anywhere after the split, is refused rather than stored. A
  type-level check (`ReviewedRegistryFields`) stops compiling if the shared
  records gain a field, so a new secret cannot slip into AsyncStorage
  unnoticed.
- **Credential index.** `openmanager-credential-index` (AsyncStorage, IDs
  only) lists the environments that may have a SecureStore entry. It is
  written before a credential and trimmed after one is deleted, so nothing in
  SecureStore is ever unfindable, and only indexed IDs are read at boot. On
  iOS a Keychain entry outlives an uninstall; the index does not, so a
  reinstall starts clean.
- **Order.** New credential: index, SecureStore, registry. Removed credential:
  SecureStore, registry, index. Each step runs whatever the previous did. A
  removal whose registry write fails still deletes the credential, leaving an
  environment that needs pairing; a credential whose environment the registry
  dropped is deleted at the next write or boot. A failed SecureStore write is
  retried with the next registry write.
- **Revocation only.** The credential is dropped only on the environment's
  revocation close (`4401`, marked `credentialRevoked` on the connection
  failure and `revoked` on the route-health report), and only if the stored
  credential is still the one the refused socket carried. Other `auth`
  failures (a different environment at the address) keep it.
- **Unreadable credentials.** A SecureStore read that throws at boot (Keychain
  before first unlock) reads as "needs pairing" for this run and is never
  deleted implicitly; removing or re-pairing the environment replaces it.
- **SecureStore options.** `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: readable for
  a background reconnect after the first unlock, never synced to another
  device. The `expo-secure-store` config plugin keeps it out of Android Auto
  Backup.

## Tests

`pnpm --filter @openmanager/mobile test` (vitest, Node). `scripts/dump-phone-store.ts`
prints AsyncStorage through a pairing round trip and exits non-zero if a
credential ever appears in it.
