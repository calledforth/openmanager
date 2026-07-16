import { useEffect, useMemo, useRef } from 'react'
import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react'
import { getConvexClient } from './convex'

export interface RendererTelemetryEvent {
  source?: 'renderer'
  kind: 'query' | 'mutation' | 'subscription' | 'trace'
  phase: 'start' | 'success' | 'error' | 'subscribe' | 'update' | 'unsubscribe' | 'mark'
  name: string
  durationMs?: number
  requestBytes?: number
  responseBytes?: number
  sessionExternalId?: string
  workspacePath?: string
  messageExternalId?: string
  traceId?: string
  details?: string
}

function estimateBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length
  } catch {
    return 0
  }
}

function extractContext(args: unknown) {
  if (!args || typeof args !== 'object') return {}
  const record = args as Record<string, unknown>
  const context: Partial<RendererTelemetryEvent> = {}
  if (typeof record.sessionExternalId === 'string') context.sessionExternalId = record.sessionExternalId
  if (typeof record.workspacePath === 'string') context.workspacePath = record.workspacePath
  if (typeof record.messageExternalId === 'string') context.messageExternalId = record.messageExternalId
  else if (typeof record.externalId === 'string') context.messageExternalId = record.externalId

  if (typeof record.payload === 'string') {
    try {
      const payload = JSON.parse(record.payload) as Record<string, unknown>
      if (!context.sessionExternalId && typeof payload.sessionExternalId === 'string') {
        context.sessionExternalId = payload.sessionExternalId
      }
      if (!context.workspacePath && typeof payload.workspacePath === 'string') {
        context.workspacePath = payload.workspacePath
      }
    } catch {
      // Ignore payload parse failure.
    }
  }
  return context
}

export async function recordRendererTelemetry(event: RendererTelemetryEvent): Promise<void> {
  await window.electronAPI.recordTelemetry({
    source: 'renderer',
    ...event,
  })
}

export function useTrackedQuery(
  name: string,
  queryRef: any,
  args: any,
  details?: string,
) {
  const result = useConvexQuery(queryRef, args)
  const subscriptionId = useRef(crypto.randomUUID())
  const argsKey = useMemo(() => JSON.stringify(args ?? null), [args])
  const lastResponse = useRef<string | null>(null)
  const isSkipped = args === 'skip'

  useEffect(() => {
    if (isSkipped) return
    void recordRendererTelemetry({
      kind: 'query',
      phase: 'subscribe',
      name,
      requestBytes: estimateBytes(args),
      details: details ?? subscriptionId.current,
      ...extractContext(args),
    })

    return () => {
      void recordRendererTelemetry({
        kind: 'query',
        phase: 'unsubscribe',
        name,
        details: details ?? subscriptionId.current,
        ...extractContext(args),
      })
    }
  }, [argsKey, details, isSkipped, name])

  // Depend on argsKey (stable string), not the args object: callers pass fresh
  // object literals every render, and keying this effect on identity made it
  // re-run (and re-stringify the full result) on every parent render.
  useEffect(() => {
    if (isSkipped || result === undefined) return
    const serialized = JSON.stringify(result)
    if (serialized === lastResponse.current) return
    lastResponse.current = serialized
    void recordRendererTelemetry({
      kind: 'query',
      phase: 'update',
      name,
      requestBytes: estimateBytes(args),
      responseBytes: serialized.length,
      details: details ?? subscriptionId.current,
      ...extractContext(args),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [argsKey, details, isSkipped, name, result])

  return result
}

export function useTrackedMutation(
  name: string,
  mutationRef: any,
  getContext?: () => Partial<RendererTelemetryEvent>,
) {
  const mutate = useConvexMutation(mutationRef)

  return useMemo(
    () =>
      async (args: any) => {
        const startedAt = performance.now()
        const context = {
          ...extractContext(args),
          ...(getContext ? getContext() : {}),
        }
        await recordRendererTelemetry({
          kind: 'mutation',
          phase: 'start',
          name,
          requestBytes: estimateBytes(args),
          ...context,
        })

        try {
          const result = await mutate(args)
          await recordRendererTelemetry({
            kind: 'mutation',
            phase: 'success',
            name,
            durationMs: Math.round(performance.now() - startedAt),
            requestBytes: estimateBytes(args),
            responseBytes: estimateBytes(result),
            ...context,
          })
          return result
        } catch (error) {
          await recordRendererTelemetry({
            kind: 'mutation',
            phase: 'error',
            name,
            durationMs: Math.round(performance.now() - startedAt),
            requestBytes: estimateBytes(args),
            details: error instanceof Error ? error.message : 'Mutation failed',
            ...context,
          })
          throw error
        }
      },
    [getContext, mutate, name],
  )
}

export async function trackedConvexQuery(name: string, queryRef: any, args: Record<string, unknown>) {
  const convex = getConvexClient()
  if (!convex) return null
  const startedAt = performance.now()
  const context = extractContext(args)
  await recordRendererTelemetry({
    kind: 'query',
    phase: 'start',
    name,
    requestBytes: estimateBytes(args),
    ...context,
  })
  try {
    const result = await convex.query(queryRef, args)
    await recordRendererTelemetry({
      kind: 'query',
      phase: 'success',
      name,
      durationMs: Math.round(performance.now() - startedAt),
      requestBytes: estimateBytes(args),
      responseBytes: estimateBytes(result),
      ...context,
    })
    return result
  } catch (error) {
    await recordRendererTelemetry({
      kind: 'query',
      phase: 'error',
      name,
      durationMs: Math.round(performance.now() - startedAt),
      requestBytes: estimateBytes(args),
      details: error instanceof Error ? error.message : 'Query failed',
      ...context,
    })
    throw error
  }
}
