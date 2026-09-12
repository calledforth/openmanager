import { api } from '@openmanager/convex/_generated/api'
import {
  applyPartUpdate,
  createPartOrdinalState,
  type PartOrdinalState,
  type StreamMessagePart,
} from '@openmanager/shared/lib/remote-stream-parts'
import type { LocalStreamingMessage } from '@openmanager/app-core/lib/streaming-messages-store'
import type { StreamingMessageSource } from '@openmanager/app-core/providers/active-thread-provider'
import { createConvexWatchStore } from './convex-watch-store'
import { trackedConvexQuery } from './convex-telemetry'

type LatestChunk = {
  chunkIndex: number
  chunkText: string
  partUpdate?: unknown
} | null

type Cursor = {
  content: string
  parts: StreamMessagePart[] | undefined
  lastChunkIndex: number | null
  ordinals: PartOrdinalState
  snapshot: LocalStreamingMessage
  /** A gap fetch in flight; its resolution is ignored if the cursor moved. */
  pending: boolean
}

function applyChunkPart(cursor: Cursor, partUpdate: unknown) {
  const part = (partUpdate as { part?: StreamMessagePart } | undefined)?.part
  if (!part?.id) return
  cursor.parts = applyPartUpdate(cursor.parts, part, cursor.ordinals)
}

function publish(cursor: Cursor): LocalStreamingMessage {
  cursor.snapshot = {
    content: cursor.content,
    parts: cursor.parts ?? [],
    hasCompleteHistory: true,
  }
  return cursor.snapshot
}

/**
 * Unfinished assistant messages of sessions another host drives: the Convex
 * chunk stream is the only channel that reaches this client. Watches the
 * newest chunk per message; a sequential chunk is appended, a gap (coalesced
 * updates or a late join) fetches only the missed tail.
 */
export function createRemoteStreamingStore(): StreamingMessageSource {
  const cursors = new Map<string, Cursor>()
  const listeners = new Map<string, Set<() => void>>()

  const emit = (messageId: string) => {
    for (const listener of [...(listeners.get(messageId) ?? [])]) listener()
  }

  const cursorFor = (messageId: string): Cursor => {
    let cursor = cursors.get(messageId)
    if (!cursor) {
      cursor = {
        content: '',
        parts: undefined,
        lastChunkIndex: null,
        ordinals: createPartOrdinalState(),
        pending: false,
        snapshot: { content: '', parts: [], hasCompleteHistory: true },
      }
      cursors.set(messageId, cursor)
    }
    return cursor
  }

  const fillGap = (messageId: string, cursor: Cursor, previousIndex: number | null) => {
    if (cursor.pending) return
    cursor.pending = true
    const afterIndex = previousIndex ?? -1
    trackedConvexQuery('streamChunks.getChunksSince', api.streamChunks.getChunksSince, {
      messageExternalId: messageId,
      afterIndex,
    })
      .then((chunks: Array<{ chunkIndex: number; chunkText: string; partUpdate?: unknown }> | null) => {
        cursor.pending = false
        if (cursors.get(messageId) !== cursor || !chunks?.length) return
        if (cursor.lastChunkIndex !== previousIndex) return
        const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
        let appended = ''
        let maxIndex = afterIndex
        for (const chunk of ordered) {
          if (chunk.chunkIndex <= maxIndex) continue
          appended += chunk.chunkText
          applyChunkPart(cursor, chunk.partUpdate)
          maxIndex = chunk.chunkIndex
        }
        if (maxIndex <= afterIndex) return
        cursor.lastChunkIndex = maxIndex
        cursor.content += appended
        publish(cursor)
        emit(messageId)
        // A chunk that landed while this fetch was in flight was ignored
        // because the cursor was pending; pick it up now.
        absorb(messageId)
      })
      .catch(() => {
        cursor.pending = false
      })
  }

  const latestChunks = createConvexWatchStore<{ messageExternalId: string }, LatestChunk>({
    name: 'streamChunks.getLatestChunk',
    query: api.streamChunks.getLatestChunk,
    argsFor: (messageId) => ({ messageExternalId: messageId }),
  })

  const absorb = (messageId: string) => {
    const latest = latestChunks.get(messageId)
    if (!latest) return
    const cursor = cursorFor(messageId)
    const previousIndex = cursor.lastChunkIndex
    if (previousIndex !== null && latest.chunkIndex <= previousIndex) return
    const isSequential =
      previousIndex === null ? latest.chunkIndex === 0 : latest.chunkIndex === previousIndex + 1
    if (isSequential) {
      cursor.lastChunkIndex = latest.chunkIndex
      cursor.content += latest.chunkText
      applyChunkPart(cursor, latest.partUpdate)
      publish(cursor)
      emit(messageId)
      return
    }
    fillGap(messageId, cursor, previousIndex)
  }

  return {
    subscribe(messageId, listener) {
      const set = listeners.get(messageId) ?? new Set()
      set.add(listener)
      listeners.set(messageId, set)
      const stop = latestChunks.subscribe(messageId, () => absorb(messageId))
      absorb(messageId)
      return () => {
        stop()
        const current = listeners.get(messageId)
        current?.delete(listener)
        if (current && current.size === 0) {
          listeners.delete(messageId)
          // Nobody is watching; the next subscriber rebuilds from the stream.
          cursors.delete(messageId)
        }
      }
    },
    get(messageId) {
      return cursors.get(messageId)?.snapshot
    },
    ensureHydrated() {},
  }
}
