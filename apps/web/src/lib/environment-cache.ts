import {
  cacheState,
  createEnvironmentStore,
  createInitialState,
  forgetCursors,
  type EnvironmentState,
  type EnvironmentStore,
} from '@openmanager/environment-client'
import { EVENT_FORMAT_VERSION, PROTOCOL_VERSION } from '@openmanager/protocol'

const CACHE_VERSION = 1

/**
 * What the cache stores: the state, and the protocol and event format it was
 * written under. A state from another protocol was folded by other rules (an
 * older build's reducers, events it no longer receives), so it is never
 * resumed: the first load after an upgrade is a fresh one
 * (docs/sync-foundations.md §4.7.7). The event format counts too, less
 * strictly: an additive field leaves the protocol alone, and a build that
 * ignored it still moved its cursor past the event, so resuming that cursor
 * would never bring the field. Such a copy keeps its state and forgets its
 * cursors: it is the only home of unsent drafts and held sends.
 */
interface CachedDocument {
  protocolVersion: number
  eventFormat: number
  state: EnvironmentState
}
const STATE_STORE = 'state'
const writes = new Map<string, Promise<void>>()
/** Removed by the user: nothing is saved for them until they are added again. */
const removed = new Set<string>()

/** URLs and credentials never participate in the cache namespace or payload. */
export function environmentCacheName(environmentId: string): string {
  return `openmanager-environment:${environmentId}`
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
  protocolVersion: number = PROTOCOL_VERSION,
  eventFormat: number = EVENT_FORMAT_VERSION,
): Promise<EnvironmentState | null> {
  await writes.get(environmentId)
  const database = await openCache(environmentId)
  if (!database) return null
  try {
    return await new Promise<EnvironmentState | null>((resolve) => {
      const transaction = database.transaction(STATE_STORE, 'readonly')
      const request = transaction.objectStore(STATE_STORE).get('snapshot')
      request.onsuccess = () => {
        const document = request.result as Partial<CachedDocument> | undefined
        // A document from another protocol, or from before the cache said
        // which, is dropped rather than merged into this build's state.
        const state = document?.protocolVersion === protocolVersion ? document.state : undefined
        const initial = createInitialState()
        // Reject incompatible/corrupt documents rather than leaking another identity.
        if (
          !state ||
          state.environment?.environmentId !== environmentId ||
          // Includes a document from before kept cursors: it has no `cursors`,
          // and the first load after the upgrade is a fresh one.
          Object.keys(initial).some((key) => !(key in state)) ||
          typeof state.cursors?.sessions !== 'object' ||
          !Array.isArray(state.sessionOrder) ||
          !Array.isArray(state.workspaceOrder) ||
          !Array.isArray(state.providerOrder)
        ) {
          resolve(null)
          return
        }
        try {
          const kept = cacheState(state)
          resolve(document?.eventFormat === eventFormat ? kept : forgetCursors(kept))
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
      const document: CachedDocument = {
        protocolVersion: PROTOCOL_VERSION,
        eventFormat: EVENT_FORMAT_VERSION,
        state: cacheState(state),
      }
      transaction.objectStore(STATE_STORE).put(document, 'snapshot')
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
  if (state.environment?.environmentId !== environmentId || removed.has(environmentId)) {
    return Promise.resolve()
  }
  return queue(environmentId, () => persistEnvironmentCache(environmentId, state))
}

function queue(environmentId: string, run: () => Promise<void>): Promise<void> {
  const previous = writes.get(environmentId) ?? Promise.resolve()
  const next = previous.then(run)
  writes.set(environmentId, next)
  void next.finally(() => {
    if (writes.get(environmentId) === next) writes.delete(environmentId)
  })
  return next
}

/**
 * The user removed this environment: delete what this browser kept of it,
 * after any save already on its way. The save its client makes as it goes is
 * skipped, so the copy is not written back. Only for an explicit removal: an
 * environment that cannot be reached keeps its copy, which may hold the only
 * copy of unsent drafts.
 */
export function deleteEnvironmentCache(environmentId: string): Promise<void> {
  removed.add(environmentId)
  return queue(
    environmentId,
    () =>
      new Promise<void>((resolve) => {
        try {
          const request = globalThis.indexedDB.deleteDatabase(environmentCacheName(environmentId))
          request.onsuccess = () => resolve()
          request.onerror = () => resolve()
          // Waits for open connections to close; each operation here closes its own.
          request.onblocked = () => undefined
        } catch {
          // Private mode or an unavailable IndexedDB: there is nothing kept to delete.
          resolve()
        }
      }),
  )
}

/** One store per identity, including while its route is being verified. */
export function createEnvironmentCache() {
  const stores = new Map<string, Promise<EnvironmentStore>>()
  return {
    getStore(environmentId: string): Promise<EnvironmentStore> {
      // Added again after a removal: it starts from nothing, and is saved again.
      if (removed.delete(environmentId)) stores.delete(environmentId)
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
