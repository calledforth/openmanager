import { describe, it, expect } from 'vitest'
import {
  applyChunkBatch,
  createStreamReconstructionState,
  reduceLatestChunk,
  type StreamChunk,
} from './stream-reconstruction'

function textPart(id: string, text: string): StreamChunk['partUpdate'] {
  return { part: { type: 'text', id, text } }
}

describe('reduceLatestChunk', () => {
  it('applies the first chunk (index 0) sequentially', () => {
    const state = createStreamReconstructionState()
    const outcome = reduceLatestChunk(state, {
      chunkIndex: 0,
      chunkText: 'Hello',
      partUpdate: textPart('p1', 'Hello'),
    })
    expect(outcome.kind).toBe('applied')
    if (outcome.kind !== 'applied') return
    expect(outcome.state.content).toBe('Hello')
    expect(outcome.state.lastChunkIndex).toBe(0)
    expect(outcome.state.parts).toEqual([{ type: 'text', id: 'p1', text: 'Hello', __ordinal: 0 }])
  })

  it('appends consecutive chunks and accumulates content', () => {
    let state = createStreamReconstructionState()
    for (const [index, text] of [
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ] as const) {
      const outcome = reduceLatestChunk(state, { chunkIndex: index, chunkText: text })
      expect(outcome.kind).toBe('applied')
      if (outcome.kind === 'applied') state = outcome.state
    }
    expect(state.content).toBe('abc')
    expect(state.lastChunkIndex).toBe(2)
  })

  it('ignores stale or duplicate chunks at or below lastChunkIndex', () => {
    let state = createStreamReconstructionState()
    const first = reduceLatestChunk(state, { chunkIndex: 0, chunkText: 'a' })
    if (first.kind === 'applied') state = first.state
    const second = reduceLatestChunk(state, { chunkIndex: 1, chunkText: 'b' })
    if (second.kind === 'applied') state = second.state

    expect(reduceLatestChunk(state, { chunkIndex: 1, chunkText: 'dup' }).kind).toBe('ignored')
    expect(reduceLatestChunk(state, { chunkIndex: 0, chunkText: 'old' }).kind).toBe('ignored')
    expect(state.content).toBe('ab')
  })

  it('signals a gap when the next chunk is not sequential', () => {
    let state = createStreamReconstructionState()
    const first = reduceLatestChunk(state, { chunkIndex: 0, chunkText: 'a' })
    if (first.kind === 'applied') state = first.state

    const outcome = reduceLatestChunk(state, { chunkIndex: 5, chunkText: 'f' })
    expect(outcome).toEqual({ kind: 'gap', afterIndex: 0 })
  })

  it('signals a gap with afterIndex -1 on late join (first seen chunk index > 0)', () => {
    const state = createStreamReconstructionState()
    const outcome = reduceLatestChunk(state, { chunkIndex: 3, chunkText: 'x' })
    expect(outcome).toEqual({ kind: 'gap', afterIndex: -1 })
  })

  it('upserts a repeated part id in place rather than duplicating it', () => {
    let state = createStreamReconstructionState()
    const a = reduceLatestChunk(state, { chunkIndex: 0, chunkText: 'He', partUpdate: textPart('p1', 'He') })
    if (a.kind === 'applied') state = a.state
    const b = reduceLatestChunk(state, { chunkIndex: 1, chunkText: 'llo', partUpdate: textPart('p1', 'Hello') })
    if (b.kind === 'applied') state = b.state

    expect(state.parts).toEqual([{ type: 'text', id: 'p1', text: 'Hello', __ordinal: 0 }])
    expect(state.content).toBe('Hello')
  })

  it('preserves part ordinals by first-seen order', () => {
    let state = createStreamReconstructionState()
    const a = reduceLatestChunk(state, { chunkIndex: 0, chunkText: '', partUpdate: textPart('p1', 'one') })
    if (a.kind === 'applied') state = a.state
    const b = reduceLatestChunk(state, { chunkIndex: 1, chunkText: '', partUpdate: textPart('p2', 'two') })
    if (b.kind === 'applied') state = b.state

    expect(state.parts?.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(state.parts?.map((p) => p.__ordinal)).toEqual([0, 1])
  })
})

describe('applyChunkBatch (gap fill / late join)', () => {
  it('sorts unordered chunks, appends text, and advances lastChunkIndex', () => {
    const state = createStreamReconstructionState()
    const next = applyChunkBatch(
      state,
      [
        { chunkIndex: 2, chunkText: 'c' },
        { chunkIndex: 0, chunkText: 'a' },
        { chunkIndex: 1, chunkText: 'b' },
      ],
      null,
    )
    expect(next).not.toBeNull()
    expect(next?.content).toBe('abc')
    expect(next?.lastChunkIndex).toBe(2)
  })

  it('skips chunks at or below the previous floor', () => {
    const state = { ...createStreamReconstructionState(), content: 'a', lastChunkIndex: 0 }
    const next = applyChunkBatch(
      state,
      [
        { chunkIndex: 0, chunkText: 'a-dup' },
        { chunkIndex: 1, chunkText: 'b' },
        { chunkIndex: 2, chunkText: 'c' },
      ],
      0,
    )
    expect(next?.content).toBe('abc')
    expect(next?.lastChunkIndex).toBe(2)
  })

  it('returns null when no chunk advances beyond the floor', () => {
    const state = { ...createStreamReconstructionState(), content: 'ab', lastChunkIndex: 1 }
    const next = applyChunkBatch(state, [{ chunkIndex: 1, chunkText: 'dup' }], 1)
    expect(next).toBeNull()
  })

  it('returns null for an empty batch', () => {
    const state = createStreamReconstructionState()
    expect(applyChunkBatch(state, [], null)).toBeNull()
  })

  it('applies part updates from the batch', () => {
    const state = createStreamReconstructionState()
    const next = applyChunkBatch(
      state,
      [
        { chunkIndex: 0, chunkText: '', partUpdate: textPart('p1', 'a') },
        { chunkIndex: 1, chunkText: '', partUpdate: textPart('p2', 'b') },
      ],
      null,
    )
    expect(next?.parts?.map((p) => p.id)).toEqual(['p1', 'p2'])
  })
})
