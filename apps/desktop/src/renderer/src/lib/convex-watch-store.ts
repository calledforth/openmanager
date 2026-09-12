import type { Watch } from 'convex/react'
import { getConvexClient } from './convex'
import { recordRendererTelemetry } from './convex-telemetry'

export interface ConvexWatchStore<TResult> {
  subscribe(key: string, listener: () => void): () => void
  /** `undefined` until the first result lands (or while nobody subscribes). */
  get(key: string): TResult | undefined
}

interface Entry<TResult> {
  watch: Watch<TResult>
  stop: () => void
  listeners: Set<() => void>
  result: TResult | undefined
}

/**
 * A reactive Convex query per key, exposed as an external store so views
 * subscribe with `useSyncExternalStore` rather than `useQuery`. The watch
 * starts with the first subscriber and stops with the last; telemetry mirrors
 * what `useTrackedQuery` records so the Convex panel still sees the traffic.
 */
export function createConvexWatchStore<TArgs extends Record<string, unknown>, TResult>(options: {
  name: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any
  argsFor: (key: string) => TArgs
  /** Applied to every result before it is stored; return the same reference
   * for unchanged input so subscribers see a stable snapshot. */
  select?: (result: TResult, previous: TResult | undefined) => TResult
}): ConvexWatchStore<TResult> {
  const entries = new Map<string, Entry<TResult>>()

  const start = (key: string): Entry<TResult> | null => {
    const convex = getConvexClient()
    if (!convex) return null
    const args = options.argsFor(key)
    const watch = convex.watchQuery(options.query, args) as Watch<TResult>
    const entry: Entry<TResult> = { watch, stop: () => undefined, listeners: new Set(), result: undefined }
    const publish = () => {
      let raw: TResult | undefined
      try {
        raw = watch.localQueryResult()
      } catch {
        // A query that errored on the server has no result to publish; the
        // watch stays open for the next successful update.
        return
      }
      if (raw === undefined) return
      const next = options.select ? options.select(raw, entry.result) : raw
      if (next === entry.result) return
      entry.result = next
      void recordRendererTelemetry({
        kind: 'query',
        phase: 'update',
        name: options.name,
        details: key,
        ...args,
      })
      for (const listener of [...entry.listeners]) listener()
    }
    entry.stop = watch.onUpdate(publish)
    void recordRendererTelemetry({
      kind: 'query',
      phase: 'subscribe',
      name: options.name,
      details: key,
      ...args,
    })
    entries.set(key, entry)
    // A value already cached in the client is available synchronously.
    publish()
    return entry
  }

  return {
    subscribe(key, listener) {
      const entry = entries.get(key) ?? start(key)
      if (!entry) return () => undefined
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size > 0 || entries.get(key) !== entry) return
        entries.delete(key)
        entry.stop()
        void recordRendererTelemetry({
          kind: 'query',
          phase: 'unsubscribe',
          name: options.name,
          details: key,
        })
      }
    },
    get(key) {
      return entries.get(key)?.result
    },
  }
}
