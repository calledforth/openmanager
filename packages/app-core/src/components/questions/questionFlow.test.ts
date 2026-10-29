import { describe, expect, it } from 'vitest'
import type { Question } from '@agentpack/contract'
import {
  allAnswered,
  buildAnswers,
  emptyDraft,
  firstUnansweredIndex,
  indexForKey,
  isAnswered,
  nextStep,
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

  it('keeps a single-select choice when it is picked again', () => {
    // Picking a single choice moves the flow on, so a re-pick must not clear
    // the answer it is about to move on with.
    const picked = toggleOption(single, emptyDraft, 'a')
    expect(toggleOption(single, picked, 'a').selectedOptionIds).toEqual(['a'])
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

describe('nextStep', () => {
  const tests: Question = { ...single, questionId: 'q3' }
  const set = [single, multi, tests]
  const pickedAll = {
    q1: { selectedOptionIds: ['a'], text: '' },
    q2: { selectedOptionIds: ['x'], text: '' },
    q3: { selectedOptionIds: ['b'], text: '' },
  }

  it('walks forward through the set', () => {
    expect(nextStep(set, {}, 0)).toEqual({ kind: 'goto', index: 1 })
    expect(nextStep(set, pickedAll, 1)).toEqual({ kind: 'goto', index: 2 })
  })

  it('submits from the last question once everything is answered — no review step', () => {
    expect(nextStep(set, pickedAll, 2)).toEqual({ kind: 'submit' })
    expect(nextStep([single], { q1: pickedAll.q1 }, 0)).toEqual({ kind: 'submit' })
  })

  it('sends the user back to the first gap instead of submitting with holes', () => {
    const missingFirst = { q2: pickedAll.q2, q3: pickedAll.q3 }
    expect(nextStep(set, missingFirst, 2)).toEqual({ kind: 'goto', index: 0 })
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
