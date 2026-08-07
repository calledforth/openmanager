import { describe, expect, it } from 'vitest'
import type { Question } from '@agentpack/contract'
import {
  allAnswered,
  buildAnswers,
  emptyDraft,
  firstUnansweredIndex,
  indexForKey,
  isAnswered,
  optionKey,
  summarizeAnswer,
  toggleOption,
} from './questionFlow'

const single: Question = {
  questionId: 'q1',
  prompt: 'Pick one',
  options: [
    { optionId: 'a', label: 'Alpha' },
    { optionId: 'b', label: 'Beta' },
  ],
}

const multi: Question = {
  questionId: 'q2',
  prompt: 'Pick many',
  allowMultiple: true,
  allowFreeText: true,
  options: [
    { optionId: 'x', label: 'Ex' },
    { optionId: 'y', label: 'Why' },
  ],
}

describe('toggleOption', () => {
  it('replaces the selection for single-select questions', () => {
    const first = toggleOption(single, emptyDraft, 'a')
    expect(first.selectedOptionIds).toEqual(['a'])
    expect(toggleOption(single, first, 'b').selectedOptionIds).toEqual(['b'])
  })

  it('clears a single-select choice when it is picked again', () => {
    const picked = toggleOption(single, emptyDraft, 'a')
    expect(toggleOption(single, picked, 'a').selectedOptionIds).toEqual([])
  })

  it('accumulates and removes for multi-select questions', () => {
    const one = toggleOption(multi, emptyDraft, 'x')
    const both = toggleOption(multi, one, 'y')
    expect(both.selectedOptionIds).toEqual(['x', 'y'])
    expect(toggleOption(multi, both, 'x').selectedOptionIds).toEqual(['y'])
  })

  it('keeps free text when the selection changes', () => {
    const typed = { selectedOptionIds: [], text: 'custom' }
    expect(toggleOption(single, typed, 'a').text).toBe('custom')
  })
})

describe('answered state', () => {
  it('counts a selection or non-blank text as an answer', () => {
    expect(isAnswered(single, emptyDraft)).toBe(false)
    expect(isAnswered(single, { selectedOptionIds: ['a'], text: '' })).toBe(true)
    expect(isAnswered(single, { selectedOptionIds: [], text: 'hi' })).toBe(true)
  })

  it('does not count whitespace-only text', () => {
    expect(isAnswered(single, { selectedOptionIds: [], text: '   \n' })).toBe(false)
  })

  it('reports the first gap across a question set', () => {
    const drafts = { q2: { selectedOptionIds: ['x'], text: '' } }
    expect(allAnswered([single, multi], drafts)).toBe(false)
    expect(firstUnansweredIndex([single, multi], drafts)).toBe(0)
    const full = { ...drafts, q1: { selectedOptionIds: ['a'], text: '' } }
    expect(allAnswered([single, multi], full)).toBe(true)
    expect(firstUnansweredIndex([single, multi], full)).toBe(-1)
  })
})

describe('buildAnswers', () => {
  it('omits blank text but always sends the selection array', () => {
    const answers = buildAnswers([single, multi], {
      q1: { selectedOptionIds: ['a'], text: '  ' },
      q2: { selectedOptionIds: ['x'], text: '  more  ' },
    })
    expect(answers).toEqual([
      { questionId: 'q1', selectedOptionIds: ['a'] },
      { questionId: 'q2', selectedOptionIds: ['x'], text: 'more' },
    ])
  })

  it('emits an entry for questions left untouched', () => {
    expect(buildAnswers([single], {})).toEqual([{ questionId: 'q1', selectedOptionIds: [] }])
  })
})

describe('summarizeAnswer', () => {
  it('joins labels and appends free text', () => {
    expect(summarizeAnswer(multi, { selectedOptionIds: ['x', 'y'], text: 'other' })).toBe(
      'Ex, Why, other',
    )
  })

  it('returns null when nothing is chosen', () => {
    expect(summarizeAnswer(single, emptyDraft)).toBeNull()
  })

  it('falls back to the id when an option is unknown', () => {
    expect(summarizeAnswer(single, { selectedOptionIds: ['ghost'], text: '' })).toBe('ghost')
  })
})

describe('option keys', () => {
  it('maps positions to the digit you press', () => {
    expect(optionKey(0)).toBe('1')
    expect(optionKey(2)).toBe('3')
    expect(indexForKey('3')).toBe(2)
  })

  it('offers no shortcut past nine', () => {
    expect(optionKey(9)).toBeNull()
    expect(indexForKey('0')).toBe(-1)
  })

  it('ignores keys that are not digits', () => {
    expect(indexForKey('c')).toBe(-1)
    expect(indexForKey(' ')).toBe(-1)
  })
})
