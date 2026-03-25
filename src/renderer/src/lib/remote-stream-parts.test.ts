import { describe, expect, it } from 'vitest'
import {
  applyPartUpdate,
  createPartOrdinalState,
  normalizeSnapshotParts,
} from './remote-stream-parts'

describe('remote-stream-parts', () => {
  it('preserves existing order when updating same part id', () => {
    const state = createPartOrdinalState()
    let parts = applyPartUpdate(
      undefined,
      { type: 'tool', id: 'tool-a', state: { status: 'running' } },
      state,
    )
    parts = applyPartUpdate(
      parts,
      { type: 'tool', id: 'tool-b', state: { status: 'running' } },
      state,
    )
    parts = applyPartUpdate(
      parts,
      { type: 'tool', id: 'tool-a', state: { status: 'completed' } },
      state,
    )

    expect(parts.map((part) => part.id)).toEqual(['tool-a', 'tool-b'])
    expect((parts[0].state as { status?: string } | undefined)?.status).toBe('completed')
  })

  it('hydrates snapshot with ordinals and applies later delta without reordering', () => {
    const state = createPartOrdinalState()
    const snapshot = normalizeSnapshotParts(
      [
        { type: 'reasoning', id: 'r-1', text: 'thinking' },
        { type: 'tool', id: 't-1', state: { status: 'running' } },
      ],
      state,
    )

    const merged = applyPartUpdate(
      snapshot,
      { type: 'tool', id: 't-1', state: { status: 'completed' } },
      state,
    )

    expect(merged.map((part) => part.id)).toEqual(['r-1', 't-1'])
    expect((merged[1].state as { status?: string } | undefined)?.status).toBe('completed')
  })

  it('assigns deterministic ordinals to out-of-order ids by first-seen order', () => {
    const state = createPartOrdinalState()
    let parts = applyPartUpdate(undefined, { type: 'tool', id: 'b' }, state)
    parts = applyPartUpdate(parts, { type: 'tool', id: 'a' }, state)

    expect(parts.map((part) => part.id)).toEqual(['b', 'a'])
    expect(parts[0].__ordinal).toBe(0)
    expect(parts[1].__ordinal).toBe(1)
  })
})
