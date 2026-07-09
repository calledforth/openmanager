import {
  applyPartUpdate,
  createPartOrdinalState,
  type PartOrdinalState,
  type StreamMessagePart,
} from './remote-stream-parts'

// Pure reducer for the append-only stream reconstruction algorithm (plan §3),
// extracted from the desktop `useRemoteStreamingMessage` hook so it can be
// unit-tested without Convex. Both the sequential fast-path and the gap /
// late-join fill are modelled here; the hook wires them to live queries.

export interface StreamChunk {
  chunkIndex: number
  chunkText: string
  partUpdate?: unknown
}

export interface StreamReconstructionState {
  content: string
  parts: StreamMessagePart[] | undefined
  lastChunkIndex: number | null
  ordinal: PartOrdinalState
}

export function createStreamReconstructionState(): StreamReconstructionState {
  return {
    content: '',
    parts: undefined,
    lastChunkIndex: null,
    ordinal: createPartOrdinalState(),
  }
}

function extractPart(partUpdate: unknown): StreamMessagePart | undefined {
  const part = (partUpdate as { part?: StreamMessagePart } | undefined)?.part
  return part?.id ? part : undefined
}

export type LatestChunkOutcome =
  | { kind: 'ignored' }
  | { kind: 'applied'; state: StreamReconstructionState }
  | { kind: 'gap'; afterIndex: number }

// Handle the reactive head of the chunk stream. Returns `applied` for the
// sequential fast-path, `gap` when a fetch of the missed tail is required, and
// `ignored` for stale / duplicate deliveries.
export function reduceLatestChunk(
  state: StreamReconstructionState,
  latest: StreamChunk,
): LatestChunkOutcome {
  if (state.lastChunkIndex !== null && latest.chunkIndex <= state.lastChunkIndex) {
    return { kind: 'ignored' }
  }

  const isSequential =
    state.lastChunkIndex === null
      ? latest.chunkIndex === 0
      : latest.chunkIndex === state.lastChunkIndex + 1

  if (!isSequential) {
    return { kind: 'gap', afterIndex: state.lastChunkIndex ?? -1 }
  }

  const part = extractPart(latest.partUpdate)
  const parts = part ? applyPartUpdate(state.parts, part, state.ordinal) : state.parts
  return {
    kind: 'applied',
    state: {
      ...state,
      content: state.content + latest.chunkText,
      parts,
      lastChunkIndex: latest.chunkIndex,
    },
  }
}

// Apply a batch of chunks fetched via `getChunksSince` (gap fill / late join).
// Chunks are sorted, chunks at or below the floor are dropped, and each
// `partUpdate` is applied in order. Returns `null` when nothing new advanced.
export function applyChunkBatch(
  state: StreamReconstructionState,
  chunks: StreamChunk[],
  previousIndex: number | null,
): StreamReconstructionState | null {
  const floor = previousIndex ?? -1
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
  let appended = ''
  let maxIndex = floor
  let parts = state.parts

  for (const chunk of ordered) {
    if (chunk.chunkIndex <= maxIndex) continue
    appended += chunk.chunkText
    const part = extractPart(chunk.partUpdate)
    if (part) parts = applyPartUpdate(parts, part, state.ordinal)
    maxIndex = chunk.chunkIndex
  }

  if (maxIndex <= floor) return null
  return {
    ...state,
    content: state.content + appended,
    parts,
    lastChunkIndex: maxIndex,
  }
}
