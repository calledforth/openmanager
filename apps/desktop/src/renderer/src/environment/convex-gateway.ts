import type { ConvexReactClient } from 'convex/react'
import type { FunctionReference } from 'convex/server'
import type { ConvexGateway } from './convex-environment-client'

/**
 * TEMPORARY — deleted with the Convex adapter (see docs/compatibility-adapters.md).
 *
 * Adapts the renderer's `ConvexReactClient` (the one `ConvexProvider` holds)
 * to the three operations the adapter needs. Subscriptions use `watchQuery`
 * rather than `useQuery` because the adapter is a plain object, not a hook.
 */
export function createConvexGateway(client: ConvexReactClient): ConvexGateway {
  type AnyQuery = FunctionReference<'query', 'public', Record<string, unknown>, unknown>
  type AnyMutation = FunctionReference<'mutation', 'public', Record<string, unknown>, unknown>
  return {
    query: <T>(reference: FunctionReference<'query'>, args: Record<string, unknown>) =>
      client.query(reference as AnyQuery, args) as Promise<T>,
    mutation: <T>(reference: FunctionReference<'mutation'>, args: Record<string, unknown>) =>
      client.mutation(reference as AnyMutation, args) as Promise<T>,
    subscribe<T>(
      reference: FunctionReference<'query'>,
      args: Record<string, unknown>,
      onUpdate: (value: T) => void,
    ) {
      const watch = client.watchQuery(reference as AnyQuery, args)
      const emit = () => {
        let value: unknown
        try {
          value = watch.localQueryResult()
        } catch {
          // A query that errored on the server has no result to fold in; the
          // subscription stays open for the next successful update.
          return
        }
        if (value !== undefined) onUpdate(value as T)
      }
      const unsubscribe = watch.onUpdate(emit)
      emit()
      return unsubscribe
    },
  }
}
