import {
  EMPTY_REGISTRY,
  parseEnvironmentCredential,
  readEnvironmentRegistry,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import {
  PHONE_APP_ORIGINS_STORAGE_KEY,
  readAppOrigins,
  serializeAppOrigins,
  type AppOrigins,
} from './app-origin'
import type { PhoneStorage } from './phone-storage'

/** The registry as written to plain storage: every token left out. */
export function withoutCredentials(registry: EnvironmentRegistry): EnvironmentRegistry {
  if (registry.environments.every((environment) => environment.credential === '')) return registry
  return {
    ...registry,
    environments: registry.environments.map((environment) =>
      environment.credential === '' ? environment : { ...environment, credential: '' },
    ),
  }
}

/** What the phone saved: the shared registry, and its own app origins beside it. */
export type PhoneSaved = {
  registry: EnvironmentRegistry
  /** Each environment's app origin by ID, for the environments that have one. */
  appOrigins: AppOrigins
}

export interface RegistryPersistence {
  /** The saved registry with each environment's token filled in, and the app origins. */
  load(): Promise<PhoneSaved>
  /**
   * Save in the background, in order. Never rejects. App origins of
   * environments the registry no longer has are left out.
   */
  save(registry: EnvironmentRegistry, appOrigins?: AppOrigins): void
  /** Resolves once every save handed in so far has finished. */
  flush(): Promise<void>
}

/**
 * One registry, kept in two places: the document the shared registry
 * functions read and write goes to `storage.registry` with no token in it, and
 * each environment's token goes to `storage.credentials` under its ID. A
 * token removed from the registry (the environment forgotten, or its token
 * cleared) is deleted from the credential store.
 *
 * A registry document that still carries a token (written by a build before
 * tokens moved out) has the token moved to the credential store on load and
 * the document rewritten without it.
 *
 * App origins go to their own document in `storage.registry`
 * (`PHONE_APP_ORIGINS_STORAGE_KEY`). An environment saved before the phone
 * kept one simply has none; nothing is migrated or guessed.
 */
export function createRegistryPersistence(storage: PhoneStorage): RegistryPersistence {
  /** What the credential store holds, as far as this process knows. */
  const savedCredentials = new Map<string, string>()
  /** The app origins document as last read or written. */
  let savedOrigins: string | null = null
  let queue: Promise<void> = Promise.resolve()

  const writeCredentials = async (registry: EnvironmentRegistry) => {
    const next = new Map<string, string>()
    for (const environment of registry.environments) {
      if (environment.credential) next.set(environment.environmentId, environment.credential)
    }
    for (const [environmentId, credential] of next) {
      if (savedCredentials.get(environmentId) === credential) continue
      await storage.credentials.setCredential(environmentId, credential)
      savedCredentials.set(environmentId, credential)
    }
    for (const environmentId of [...savedCredentials.keys()]) {
      if (next.has(environmentId)) continue
      await storage.credentials.deleteCredential(environmentId)
      savedCredentials.delete(environmentId)
    }
  }

  const writeAppOrigins = (registry: EnvironmentRegistry, appOrigins: AppOrigins) => {
    const kept = new Map(
      [...appOrigins].filter(([environmentId]) =>
        registry.environments.some((environment) => environment.environmentId === environmentId),
      ),
    )
    const document = serializeAppOrigins(kept)
    if (document === savedOrigins) return
    if (kept.size === 0) storage.registry.removeItem(PHONE_APP_ORIGINS_STORAGE_KEY)
    else storage.registry.setItem(PHONE_APP_ORIGINS_STORAGE_KEY, document)
    savedOrigins = document
  }

  return {
    async load() {
      await storage.ready()
      const appOrigins = readAppOrigins(storage.registry)
      savedOrigins = serializeAppOrigins(appOrigins)
      const document = readEnvironmentRegistry(storage.registry)
      if (document === EMPTY_REGISTRY) return { registry: EMPTY_REGISTRY, appOrigins }
      let stale = false
      const environments = await Promise.all(
        document.environments.map(async (environment) => {
          const kept = parseEnvironmentCredential(
            (await storage.credentials.getCredential(environment.environmentId)) ?? '',
          )
          if (kept) savedCredentials.set(environment.environmentId, kept)
          if (environment.credential) stale = true
          return { ...environment, credential: kept || environment.credential }
        }),
      )
      const registry = { ...document, environments }
      if (stale) {
        await writeCredentials(registry)
        writeEnvironmentRegistry(withoutCredentials(registry), storage.registry)
      }
      return { registry, appOrigins }
    },
    save(registry, appOrigins) {
      queue = queue
        .then(async () => {
          // Token first: a document that names an environment whose token is
          // not saved yet would read as unpaired after a crash in between.
          await writeCredentials(registry)
          writeEnvironmentRegistry(withoutCredentials(registry), storage.registry)
          if (appOrigins) writeAppOrigins(registry, appOrigins)
        })
        .catch(() => {
          // A failed write keeps the in-memory registry. `savedCredentials`
          // only records writes that finished, so the next save repeats
          // whatever this one did not get to.
        })
    },
    flush: () => queue,
  }
}
