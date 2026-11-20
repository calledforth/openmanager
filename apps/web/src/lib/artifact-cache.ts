import type { ArtifactCache } from '@openmanager/environment-client'

/**
 * The images this browser has read from one environment, in IndexedDB, so a
 * chat opened again, or after a reload, shows them without crossing the
 * network (a tunnel can make each read take a second). An artifact's bytes
 * never change, so a kept image is never stale. The environment's own reply
 * stays `no-store`: the browser's HTTP cache keys by URL, not credential, and
 * would outlive a revoked one; this cache is deleted with the environment.
 */
const STORE = 'images'
const SAVED_AT = 'savedAt'
/** What one environment may keep; the oldest images go first past it. */
export const ARTIFACT_CACHE_BUDGET_BYTES = 200 * 1024 * 1024
/** Trimming walks every kept image, so it runs at most this often. */
const TRIM_INTERVAL_MS = 60_000

/** Bytes, not a Blob: every browser's IndexedDB stores an ArrayBuffer alike. */
interface KeptImage {
  bytes: ArrayBuffer
  type: string
  size: number
  savedAt: number
}

/** Removed environments: a write still on its way must not bring them back. */
const forgotten = new Set<string>()

export function artifactCacheName(environmentId: string): string {
  return `openmanager-artifacts:${environmentId}`
}

function open(environmentId: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = globalThis.indexedDB.open(artifactCacheName(environmentId), 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE).createIndex(SAVED_AT, SAVED_AT)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      // Private mode or no IndexedDB: images are read from the environment.
      resolve(null)
    }
  })
}

/** One operation on its own connection, closed after, so deleting never waits on one. */
async function withStore<T>(
  environmentId: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
  fallback: T,
): Promise<T> {
  const database = await open(environmentId)
  if (!database) return fallback
  try {
    return await new Promise<T>((resolve) => {
      let result = fallback
      const transaction = database.transaction(STORE, mode)
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => resolve(fallback)
      transaction.onabort = () => resolve(fallback)
      run(transaction.objectStore(STORE), (value) => {
        result = value
      })
    })
  } catch {
    return fallback
  } finally {
    database.close()
  }
}

/** Drop the oldest images until what is kept fits the budget. */
function trim(environmentId: string, budget: number): Promise<void> {
  return withStore<void>(
    environmentId,
    'readwrite',
    (store) => {
      const sizes = store.index(SAVED_AT).openCursor()
      const order: Array<{ key: IDBValidKey; size: number }> = []
      let total = 0
      sizes.onsuccess = () => {
        const cursor = sizes.result
        if (cursor) {
          const size = (cursor.value as KeptImage).size
          order.push({ key: cursor.primaryKey, size })
          total += size
          cursor.continue()
          return
        }
        for (const { key, size } of order) {
          if (total <= budget) break
          store.delete(key)
          total -= size
        }
      }
    },
    undefined,
  )
}

export function createArtifactCache(
  environmentId: string,
  options: { budgetBytes?: number; now?: () => number } = {},
): ArtifactCache {
  const budget = options.budgetBytes ?? ARTIFACT_CACHE_BUDGET_BYTES
  const now = options.now ?? Date.now
  // Added again after a removal: it keeps images again.
  forgotten.delete(environmentId)
  let lastTrim: number | undefined
  return {
    read: (artifactId) =>
      withStore<Blob | undefined>(
        environmentId,
        'readonly',
        (store, done) => {
          const request = store.get(artifactId)
          request.onsuccess = () => {
            const kept = request.result as KeptImage | undefined
            // By tag, not instanceof: the store may answer from another realm.
            if (Object.prototype.toString.call(kept?.bytes) === '[object ArrayBuffer]') {
              done(new Blob([kept!.bytes], { type: kept!.type }))
            }
          }
        },
        undefined,
      ),
    async write(artifactId, bytes) {
      if (forgotten.has(environmentId) || bytes.size > budget) return
      const kept: KeptImage = {
        bytes: await bytes.arrayBuffer(),
        type: bytes.type,
        size: bytes.size,
        savedAt: now(),
      }
      await withStore<void>(
        environmentId,
        'readwrite',
        (store) => store.put(kept, artifactId),
        undefined,
      )
      if (forgotten.has(environmentId)) {
        await deleteArtifactCache(environmentId)
        return
      }
      const at = now()
      if (lastTrim !== undefined && Math.abs(at - lastTrim) < TRIM_INTERVAL_MS) return
      lastTrim = at
      await trim(environmentId, budget)
    },
  }
}

/** The environment was removed: delete every image kept of it. */
export function deleteArtifactCache(environmentId: string): Promise<void> {
  forgotten.add(environmentId)
  return new Promise((resolve) => {
    try {
      const request = globalThis.indexedDB.deleteDatabase(artifactCacheName(environmentId))
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      // Waits for open connections; each operation here closes its own.
      request.onblocked = () => undefined
    } catch {
      resolve()
    }
  })
}
