import { api } from '@openmanager/convex/_generated/api'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import {
  applyChunkBatch,
  createStreamReconstructionState,
  reduceLatestChunk,
  type StreamChunk,
  type StreamReconstructionState,
} from '@openmanager/shared/lib/stream-reconstruction'
import { useConvex, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'

// Faithful port of the desktop `useRemoteStreamingMessage` (plan §3). Subscribe
// to the reactive chunk head; append sequentially on the fast-path, otherwise
// imperatively fetch the missed tail via `getChunksSince`. Local state resets
// whenever the message id changes or streaming is disabled.

export function useRemoteStreamingMessage(
  messageExternalId: string,
  enabled: boolean,
  onUpdate?: () => void,
): { content: string; parts: StreamMessagePart[] | undefined } {
  const convex = useConvex()
  const latest = useQuery(
    api.streamChunks.getLatestChunk,
    enabled ? { messageExternalId } : 'skip',
  )

  const [content, setContent] = useState('')
  const [parts, setParts] = useState<StreamMessagePart[] | undefined>(undefined)
  const stateRef = useRef<StreamReconstructionState>(createStreamReconstructionState())

  useEffect(() => {
    if (!enabled) return
    stateRef.current = createStreamReconstructionState()
    setContent('')
    setParts(undefined)
  }, [enabled, messageExternalId])

  useEffect(() => {
    if (!enabled || !latest) return

    const outcome = reduceLatestChunk(stateRef.current, latest as StreamChunk)
    if (outcome.kind === 'ignored') return

    if (outcome.kind === 'applied') {
      stateRef.current = outcome.state
      setContent(outcome.state.content)
      setParts(outcome.state.parts)
      onUpdate?.()
      return
    }

    // Gap (coalesced updates) or late join: fetch only the missed tail.
    let cancelled = false
    const previousIndex = stateRef.current.lastChunkIndex
    convex
      .query(api.streamChunks.getChunksSince, {
        messageExternalId,
        afterIndex: outcome.afterIndex,
      })
      .then((chunks) => {
        if (cancelled || !chunks || chunks.length === 0) return
        // Bail if a newer sequential chunk already advanced the state.
        if (stateRef.current.lastChunkIndex !== previousIndex) return
        const next = applyChunkBatch(stateRef.current, chunks as StreamChunk[], previousIndex)
        if (!next) return
        stateRef.current = next
        setContent(next.content)
        setParts(next.parts)
        onUpdate?.()
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [latest, enabled, messageExternalId, onUpdate, convex])

  return { content, parts }
}
