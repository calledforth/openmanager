import type { EnvironmentScope } from '@openmanager/app-core/providers/environment-scope'

/**
 * Each connected environment's scope: what its providers serve, published
 * from inside them (`PhoneEnvironmentProvider`) for its pages and the home
 * to read. Kept by environment, so one environment's update tells only the
 * readers of that one.
 */
export function createScopeRegistry() {
  const scopes = new Map<string, EnvironmentScope>()
  const listeners = new Map<string, Set<() => void>>()
  const anyListeners = new Set<() => void>()
  let version = 0
  const tell = (environmentId: string) => {
    version += 1
    for (const listener of [...(listeners.get(environmentId) ?? [])]) listener()
    for (const listener of [...anyListeners]) listener()
  }
  return {
    get: (environmentId: string): EnvironmentScope | null => scopes.get(environmentId) ?? null,
    /** The environments with a scope now. */
    ids: (): string[] => [...scopes.keys()],
    set(environmentId: string, scope: EnvironmentScope) {
      if (scopes.get(environmentId) === scope) return
      scopes.set(environmentId, scope)
      tell(environmentId)
    },
    delete(environmentId: string, scope: EnvironmentScope) {
      // Only its own: a host that remounted has already published the next.
      if (scopes.get(environmentId) !== scope) return
      scopes.delete(environmentId)
      tell(environmentId)
    },
    subscribe(environmentId: string, listener: () => void) {
      let set = listeners.get(environmentId)
      if (!set) {
        set = new Set()
        listeners.set(environmentId, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    /** Told of a change to any environment's scope. */
    subscribeAll(listener: () => void) {
      anyListeners.add(listener)
      return () => {
        anyListeners.delete(listener)
      }
    },
    /** Changes with every change to any scope. */
    version: () => version,
  }
}

export type ScopeRegistry = ReturnType<typeof createScopeRegistry>
