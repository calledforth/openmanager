import {
  EMPTY_REGISTRY,
  parseEnvironmentCredential,
  readEnvironmentRegistry,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
} from '@openmanager/environment-client/connection'
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

export interface RegistryPersistence {
  /** The saved registry with each environment's token filled in. */
  load(): Promise<EnvironmentRegistry>
  /** Save in the background, in order. Never rejects. */
  save(registry: EnvironmentRegistry): void
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
 */
export function createRegistryPersistence(storage: PhoneStorage): RegistryPersistence {
  /** What the credential store holds, as far as this process knows. */
  const savedCredentials = new Map<string, string>()
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

  return {
    async load() {
      await storage.ready()
      const document = readEnvironmentRegistry(storage.registry)
      if (document === EMPTY_REGISTRY) return EMPTY_REGISTRY
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
      return registry
    },
    save(registry) {
      queue = queue
        .then(async () => {
          // Token first: a document that names an environment whose token is
          // not saved yet would read as unpaired after a crash in between.
          await writeCredentials(registry)
          writeEnvironmentRegistry(withoutCredentials(registry), storage.registry)
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
