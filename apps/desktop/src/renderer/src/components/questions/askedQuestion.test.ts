import { describe, expect, it } from 'vitest'
import { readAskedQuestions } from './askedQuestion'

const input = {
  questions: [
    { question: 'Which library?', header: 'Library', options: [{ label: 'zod' }] },
    { question: 'Ship it?', header: 'Ship', options: [{ label: 'yes' }] },
  ],
}

describe('readAskedQuestions', () => {
  it('pairs each question with the answer keyed by its text', () => {
    const parsed = readAskedQuestions({
      input: { ...input, answers: { 'Which library?': 'zod', 'Ship it?': 'yes' } },
    })
    expect(parsed).toEqual([
      { prompt: 'Which library?', answer: 'zod', header: 'Library' },
      { prompt: 'Ship it?', answer: 'yes', header: 'Ship' },
    ])
  })

  it('marks questions with no answer rather than dropping them', () => {
    const parsed = readAskedQuestions({ input: { ...input, answers: { 'Ship it?': 'yes' } } })
    expect(parsed?.map((question) => question.answer)).toEqual([null, 'yes'])
  })

  it('reads answers stranded in the tool output, object or JSON string', () => {
    const fromObject = readAskedQuestions({
      input,
      output: { answers: { 'Which library?': 'valibot' } },
    })
    expect(fromObject?.[0].answer).toBe('valibot')

    const fromJson = readAskedQuestions({
      input,
      output: JSON.stringify({ answers: { 'Which library?': 'valibot' } }),
    })
    expect(fromJson?.[0].answer).toBe('valibot')
  })

  it('survives an unanswered call and a plain-text output', () => {
    expect(readAskedQuestions({ input })?.[0].answer).toBeNull()
    expect(readAskedQuestions({ input, output: 'cancelled' })?.[0].answer).toBeNull()
  })

  it('accepts the contract shape as well as Claude’s', () => {
    const parsed = readAskedQuestions({ input: { questions: [{ prompt: 'Which?', options: [] }] } })
    expect(parsed).toEqual([{ prompt: 'Which?', answer: null }])
  })

  it('returns null when there is nothing renderable', () => {
    expect(readAskedQuestions(undefined)).toBeNull()
    expect(readAskedQuestions({ input: { questions: [] } })).toBeNull()
    expect(readAskedQuestions({ input: { questions: [{ header: 'no text' }] } })).toBeNull()
  })
})
