import { describe, expect, it } from 'vitest'
import { partitionSettledTurnParts, settledTurnLabel } from './turn-work-group'

describe('settled turn work grouping', () => {
  it('keeps only the trailing assistant text outside the work group', () => {
    const parts = [
      { type: 'text', id: 'commentary', text: 'I will inspect it.' },
      { type: 'tool', id: 'read', tool: 'Read', state: { status: 'completed' } },
      { type: 'reasoning', id: 'thought', text: 'checking', time: { start: 1, end: 2 } },
      { type: 'text', id: 'final', text: 'Everything checks out.' },
    ]

    const partition = partitionSettledTurnParts(parts)

    expect(partition.workParts.map((part) => part.id)).toEqual(['commentary', 'read', 'thought'])
    expect(partition.finalParts.map((part) => part.id)).toEqual(['final'])
  })

  it('does not create work for a text-only response', () => {
    const partition = partitionSettledTurnParts([
      { type: 'text', id: 'final', text: 'A direct answer.' },
    ])

    expect(partition.workParts).toEqual([])
    expect(partition.finalParts.map((part) => part.id)).toEqual(['final'])
  })

  it('puts a tool-only response entirely in the work group', () => {
    const partition = partitionSettledTurnParts([
      { type: 'tool', id: 'read', tool: 'Read', state: { status: 'completed' } },
    ])

    expect(partition.workParts.map((part) => part.id)).toEqual(['read'])
    expect(partition.finalParts).toEqual([])
  })

  it('formats successful duration and stopped outcomes', () => {
    expect(
      settledTurnLabel({
        startedAt: 1_000,
        completedAt: 126_000,
        finishReason: 'end_turn',
      }),
    ).toBe('Worked for 2m 5s')
    expect(
      settledTurnLabel({
        startedAt: 1_000,
        completedAt: 126_000,
        finishReason: 'cancelled',
      }),
    ).toBe('Stopped')
    expect(settledTurnLabel({ finishReason: 'error' })).toBe('Stopped')
  })
})
