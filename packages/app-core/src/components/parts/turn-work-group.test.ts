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

  it('keeps a generated image beside the final answer instead of inside work', () => {
    const partition = partitionSettledTurnParts([
      { type: 'tool', id: 'generate', tool: 'Generate Image', state: { status: 'completed' } },
      { type: 'image', id: 'image', generated: true, url: 'https://example.test/image.png' },
      { type: 'text', id: 'final', text: 'Here is the result.' },
    ])

    expect(partition.workParts.map((part) => part.id)).toEqual(['generate'])
    expect(partition.finalParts.map((part) => part.id)).toEqual(['image', 'final'])
  })

  it('keeps a failure in view after the work it ended', () => {
    const partition = partitionSettledTurnParts([
      { type: 'tool', id: 'read', tool: 'Read', state: { status: 'completed' } },
      { type: 'failure', id: 'failure:t1' },
    ])

    expect(partition.workParts.map((part) => part.id)).toEqual(['read'])
    expect(partition.finalParts.map((part) => part.id)).toEqual(['failure:t1'])
  })

  it('does not fold the answer away behind a notice that followed it', () => {
    const partition = partitionSettledTurnParts([
      { type: 'tool', id: 'read', tool: 'Read', state: { status: 'completed' } },
      { type: 'text', id: 'final', text: 'Done.' },
      { type: 'notice', id: 'notice:n1', notice: { kind: 'warning' } },
    ])

    expect(partition.workParts.map((part) => part.id)).toEqual(['read'])
    expect(partition.finalParts.map((part) => part.id)).toEqual(['final', 'notice:n1'])
  })

  it('keeps notices that change how to read the answer beside it', () => {
    const partition = partitionSettledTurnParts([
      { type: 'notice', id: 'notice:info', notice: { kind: 'info' } },
      { type: 'notice', id: 'notice:fallback', notice: { kind: 'model_fallback' } },
      { type: 'tool', id: 'read', tool: 'Read', state: { status: 'completed' } },
      { type: 'text', id: 'final', text: 'Here it is.' },
    ])

    expect(partition.workParts.map((part) => part.id)).toEqual(['notice:info', 'read'])
    expect(partition.finalParts.map((part) => part.id)).toEqual(['notice:fallback', 'final'])
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

  it('introduces a turn nobody prompted in place of the usual label', () => {
    expect(settledTurnLabel({ unprompted: true })).toBe('Resumed after background work')
    expect(settledTurnLabel({ startedAt: 1_000, completedAt: 3_000, unprompted: true })).toBe(
      'Resumed after background work · 2s',
    )
    expect(settledTurnLabel({ finishReason: 'cancelled', unprompted: true })).toBe('Stopped')
  })
})
