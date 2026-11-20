import { describe, expect, it } from 'vitest'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { assistantCopyText, partitionSettledTurnParts, settledTurnLabel } from './turn-work-group'

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

  it('keeps a failure in view after a call that was declined', () => {
    const partition = partitionSettledTurnParts([
      { type: 'tool', id: 'edit', tool: 'Edit', state: { status: 'declined' } },
      { type: 'failure', id: 'failure:t1' },
    ])

    expect(partition.workParts.map((part) => part.id)).toEqual(['edit'])
    expect(partition.finalParts.map((part) => part.id)).toEqual(['failure:t1'])
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

describe('settled turn grouping by message phase', () => {
  const text = (id: string, phase?: string) => ({
    type: 'text',
    id,
    text: `${id}.`,
    ...(phase ? { phase } : {}),
  })
  const tool = (id: string) => ({ type: 'tool', id, tool: 'Read', state: { status: 'completed' } })
  const split = (parts: StreamMessagePart[]) => {
    const partition = partitionSettledTurnParts(parts)
    return {
      work: partition.workParts.map((part) => part.id),
      answer: partition.finalParts.map((part) => part.id),
    }
  }

  it('folds commentary into the work and shows the final answer', () => {
    expect(
      split([text('looking', 'commentary'), tool('read'), text('answer', 'final_answer')]),
    ).toEqual({ work: ['looking', 'read'], answer: ['answer'] })
  })

  it('keeps commentary that runs straight into the answer out of it', () => {
    // Without phases the two would read as one run, and both as the answer.
    expect(split([tool('read'), text('looking'), text('answer')])).toEqual({
      work: ['read'],
      answer: ['looking', 'answer'],
    })
    expect(
      split([tool('read'), text('looking', 'commentary'), text('answer', 'final_answer')]),
    ).toEqual({ work: ['read', 'looking'], answer: ['answer'] })
  })

  // A turn stopped or failed while it narrated marks nothing as its answer.
  // Folding all of it away would leave the reader nothing but "Worked".
  it('shows the last text of a turn that ended on commentary, as before phases', () => {
    expect(split([tool('read'), text('still looking', 'commentary')])).toEqual({
      work: ['read'],
      answer: ['still looking'],
    })
    expect(split([tool('read'), text('review'), text('aside', 'commentary')])).toEqual({
      work: ['read'],
      answer: ['review', 'aside'],
    })
    expect(assistantCopyText('', true, [text('only', 'commentary')])).toBe('only.')
  })

  it('takes partial answers as answer text, wherever they stand', () => {
    expect(
      split([
        text('first part', 'partial_answer'),
        tool('read'),
        text('checking', 'commentary'),
        text('second part', 'partial_answer'),
        text('rest', 'final_answer'),
      ]),
    ).toEqual({ work: ['read', 'checking'], answer: ['first part', 'second part', 'rest'] })
  })

  it('takes a final answer the provider marked, even with commentary after it', () => {
    expect(
      split([tool('read'), text('answer', 'final_answer'), text('aside', 'commentary')]),
    ).toEqual({ work: ['read', 'aside'], answer: ['answer'] })
  })

  it('keeps the last run of unmarked text as the answer beside marked commentary', () => {
    // A review's output carries no phase, inside a turn whose narration does.
    expect(split([text('reviewing', 'commentary'), tool('read'), text('review')])).toEqual({
      work: ['reviewing', 'read'],
      answer: ['review'],
    })
  })

  it('copies only the answer of a phased turn', () => {
    expect(
      assistantCopyText('', true, [
        text('looking', 'commentary'),
        tool('read'),
        text('noted', 'commentary'),
        text('answer', 'final_answer'),
      ]),
    ).toBe('answer.')
  })
})
