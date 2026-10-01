import {
  createEnvironmentStore,
  createInitialState,
  type EnvironmentState,
  type EnvironmentStore,
} from '@openmanager/environment-client'

const CACHE_VERSION = 1
const STATE_STORE = 'state'
const writes = new Map<string, Promise<void>>()

/** URLs and credentials never participate in the cache namespace or payload. */
export function environmentCacheName(environmentId: string): string {
  return `openmanager-environment:${environmentId}`
}

function cacheState(state: EnvironmentState): EnvironmentState {
  return {
    ...state,
    connection: createInitialState().connection,
    sessionOpenFailure: null,
    // A send cut off by the reload has an outcome this page never learns, and
    // its edit holds the cleared composer, not what was sent. Dropped, so the
    // environment's copy stands: gone with the session if the send happened,
    // listed again if it did not.
    draftEdits: Object.fromEntries(
      Object.entries(state.draftEdits).filter(([, edit]) => !edit.launching),
    ),
    threads: Object.fromEntries(
      Object.entries(state.threads).map(([id, thread]) => [
        id,
        {
          ...thread,
          // Pending commands belong to the old transport and are never replayed.
          outbox: [],
          hydration: thread.hydration === 'loading' ? 'idle' : thread.hydration,
        },
      ]),
    ),
  }
}

function openCache(environmentId: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = globalThis.indexedDB.open(environmentCacheName(environmentId), CACHE_VERSION)
      let finished = false
      const finish = (database: IDBDatabase | null) => {
        if (finished) {
          database?.close()
          return
        }
        finished = true
        resolve(database)
      }
      request.onupgradeneeded = () => request.result.createObjectStore(STATE_STORE)
      request.onsuccess = () => finish(request.result)
      request.onerror = () => finish(null)
      request.onblocked = () => finish(null)
    } catch {
      // Private mode or an unavailable IndexedDB must not prevent connecting.
      resolve(null)
    }
  })
}

export async function readEnvironmentCache(
  environmentId: string,
): Promise<EnvironmentState | null> {
  await writes.get(environmentId)
  const database = await openCache(environmentId)
  if (!database) return null
  try {
    return await new Promise<EnvironmentState | null>((resolve) => {
      const transaction = database.transaction(STATE_STORE, 'readonly')
      const request = transaction.objectStore(STATE_STORE).get('snapshot')
      request.onsuccess = () => {
        const state = request.result as EnvironmentState | undefined
        const initial = createInitialState()
        // Reject incompatible/corrupt documents rather than leaking another identity.
        if (
          !state ||
          state.environment?.environmentId !== environmentId ||
          Object.keys(initial).some((key) => !(key in state)) ||
          !Array.isArray(state.sessionOrder) ||
          !Array.isArray(state.workspaceOrder) ||
          !Array.isArray(state.providerOrder)
        ) {
          resolve(null)
          return
        }
        try {
          resolve(cacheState(state))
        } catch {
          resolve(null)
        }
      }
      request.onerror = () => resolve(null)
      transaction.onabort = () => resolve(null)
    })
  } catch {
    return null
  } finally {
    database.close()
  }
}

async function persistEnvironmentCache(
  environmentId: string,
  state: EnvironmentState,
): Promise<void> {
  if (state.environment?.environmentId !== environmentId) return
  const database = await openCache(environmentId)
  if (!database) return
  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(STATE_STORE, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
      transaction.objectStore(STATE_STORE).put(cacheState(state), 'snapshot')
    })
  } catch {
    // A quota or serialization failure leaves the in-memory store usable.
  } finally {
    database.close()
  }
}

/** Serialize snapshots per identity, including writes from transport cleanup. */
export function writeEnvironmentCache(
  environmentId: string,
  state: EnvironmentState,
): Promise<void> {
  if (state.environment?.environmentId !== environmentId) return Promise.resolve()
  const previous = writes.get(environmentId) ?? Promise.resolve()
  const next = previous.then(() => persistEnvironmentCache(environmentId, state))
  writes.set(environmentId, next)
  void next.finally(() => {
    if (writes.get(environmentId) === next) writes.delete(environmentId)
  })
  return next
}

/** One store per identity, including while its route is being verified. */
export function createEnvironmentCache() {
  const stores = new Map<string, Promise<EnvironmentStore>>()
  return {
    getStore(environmentId: string): Promise<EnvironmentStore> {
      let store = stores.get(environmentId)
      if (!store) {
        store = readEnvironmentCache(environmentId).then((state) =>
          createEnvironmentStore(state ?? undefined),
        )
        stores.set(environmentId, store)
      }
      return store
    },
  }
}
