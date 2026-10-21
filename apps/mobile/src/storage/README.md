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
  confirmCredentialRejected,
  credentialRefusalOf,
  forgetRejectedCredential,
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

// 4. When a socket report says the credential was refused:
//    report = routeHealthFromConnection(connection), credential = the one that socket carried,
//    endpoint = the route that socket dialled.
//    First the shared latch, exactly as web: routeFailure = credential_rejected, no search, no retry.
//    Then forget the credential only once it is sure its own environment refused it:
const refusal = credentialRefusalOf(report) // 'revoked' | 'unknown' | null
if (await confirmCredentialRejected({ refusal, environmentId, endpoint })) {
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
- **Slots and the manifest.** Every credential write goes to a fresh
  SecureStore slot, `openmanager.credential.<escaped id>.<slot>`. The manifest
  (`openmanager-credential-manifest` in AsyncStorage, keys and IDs only) maps
  each environment to its `active` slot, the slot its current credential is
  being written to as `pending`, and every other slot that may exist as
  `retired`. Boot reads active and pending slots and deletes retired ones.
  - A slot is written only once a saved manifest names it (checked when the
    write runs), so nothing in SecureStore is ever unfindable. A failed
    manifest write is tried again with the next registry write, and the slot
    waits for it.
  - A slot becomes active only after SecureStore confirms it; until then it
    is pending, and boot makes it active if SecureStore has it, so a failed
    confirmation never loses a saved credential. A credential
    the registry drops (removed, revoked, rotated) leaves `active` at once, so
    it is never read again even if deleting its slot fails; the delete is
    tried again at the next write or boot.
  - An earlier install's slots (on iOS the Keychain outlives an uninstall;
    AsyncStorage does not) are named by no manifest and never read, even if
    pairing again is cut short.
- **Order.** New credential: manifest (slot named), SecureStore, registry,
  manifest (slot active). Removed credential: manifest (slot retired),
  SecureStore delete, registry, manifest. Each step runs whatever the
  previous did. A store that keeps failing is retried once per registry write
  or boot, never in a loop.
- **Boot scrubbing.** A registry document that is not a registry, or that
  holds a known credential outside its `credential` field, is removed rather
  than rewritten around it (its credentials go too). So is a legacy record
  holding one.
- **Revocation only.** The credential is dropped only after the revocation
  close (`4401`), which the shared client marks as `credentialRefusal` on the
  connection failure and the route-health report:
  - `revoked`: the server accepted the credential and then revoked it. Only
    the issuing environment knows a credential, so this is certain and the
    phone drops it at once.
  - `unknown`: the server does not know the credential. That is a credential
    revoked while the phone was away, or an address that now leads to a
    different environment. The phone asks that address `/bootstrap` (no
    credential sent) and drops it only if the same environment answers.
    Anything else (no answer, another environment) keeps it.

  The drop is also compare-and-clear: only if the stored credential is still
  the one the refused socket carried. The client's own handshake mismatch is
  an `auth` failure with no refusal, and keeps it. The shared latch stops
  retries whatever the phone keeps.

- **Unreadable credentials.** A SecureStore read that throws at boot (Keychain
  before first unlock) reads as "needs pairing" for this run and is never
  deleted implicitly; removing or re-pairing the environment replaces it.
- **SecureStore options.** `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: readable for
  a background reconnect after the first unlock, never synced to another
  device. The `expo-secure-store` config plugin keeps it out of Android Auto
  Backup.

## Replacing the in-memory seam

The connection work (`src/environment/` on its own branch) runs on an
in-memory `PhoneStorage` with `ready()`, `registry`, `device` and a separate
`credentials` store, and its `persistence.ts` writes the registry with every
credential blanked and the tokens to `credentials`. This module is not a
drop-in for that one line, and must not be wired in behind that persistence:

- **Never hand this adapter a blanked registry.** Here a registry write _is_
  the credential write. A document with every `credential` empty retires every
  slot and deletes every token, as a removal would.
- Load with `await phoneStorage.hydrate()` and then
  `readEnvironmentRegistry(phoneStorage.registry)`: credentials come back
  joined, nothing to fetch per environment.
- Save the whole registry, credentials included, with
  `writeEnvironmentRegistry(next, phoneStorage.registry)`; `flush` is
  `phoneStorage.flush()`. The split, the order and the retries happen here.
- `persistence.ts`'s token split and the `CredentialStore` port go away;
  `ready` maps to `hydrate`.
- Keep passing the one `phoneStorage.device` and `subscribePhonePageExit`
  (fixed identities), and call the credential-rejection helpers after the
  `credential_rejected` latch (step 4 above).

The in-memory store kept nothing across launches, so there is no data to
migrate.

## A new field on a shared record

The adapter strips only `credential`; every other field of an environment or
route is carried through AsyncStorage as the shared code wrote it, so a new
plain field (for example the pairing link's app origin) needs no storage
migration. `ReviewedRegistryFields` will stop compiling when it is added to
the shared type: add its name to the reviewed list there once it is known not
to be a secret.

## Known limit

Dropping a credential takes two writes: the manifest retires its slot, and
SecureStore deletes it. Either one landing is enough. If **both** fail and the
app restarts before any later write retries them, boot reads the slot again
(whether it was active, or pending because its activation write also failed)
and the dropped credential comes back. For a revoked credential the next
connect gets the same refusal and the phone drops it again; nothing is sent
that the environment accepts.

## Tests

`pnpm --filter @openmanager/mobile test` (vitest, Node). `scripts/dump-phone-store.ts`
prints AsyncStorage through a pairing round trip and exits non-zero if a
credential ever appears in it.
