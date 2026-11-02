import { describe, expect, it } from 'vitest'
import { readAskedQuestions } from './askedQuestion'

const input = {
  questions: [
    { question: 'Which library?', header: 'Library', options: [{ label: 'zod' }] },
    { question: 'Ship it?', header: 'Ship', options: [{ label: 'yes' }] },
  ],
}

describe('readAskedQuestions', () => {
  it('stays on the plain row while a question waits for its answer', () => {
    expect(readAskedQuestions({ status: 'running', input })).toBeNull()
    expect(readAskedQuestions({ status: 'pending', input })).toBeNull()
  })

  it('does not call a completed question skipped without being told so', () => {
    expect(readAskedQuestions({ status: 'completed', input })).toBeNull()
  })

  it.each(['error', 'declined', 'cancelled'])('says skipped when the call ended %s', (status) => {
    const parsed = readAskedQuestions({ status, input })
    expect(parsed?.map((question) => question.answer)).toEqual([null, null])
  })

  it('reads what a reload holds: the answers the environment stated on the input', () => {
    const parsed = readAskedQuestions({
      status: 'completed',
      input: { ...input, answers: { 'Which library?': 'zod', 'Ship it?': 'yes' } },
    })
    expect(parsed?.map((question) => question.answer)).toEqual(['zod', 'yes'])
  })

  it('reads the prompts Cursor states with its answers', () => {
    const parsed = readAskedQuestions({
      status: 'in_progress',
      input: { questions: [{ prompt: 'Which one?' }], answers: { 'Which one?': 'A' } },
    })
    expect(parsed).toEqual([{ prompt: 'Which one?', answer: 'A' }])
  })

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
    const ended = { status: 'cancelled', input }
    expect(readAskedQuestions(ended)?.[0].answer).toBeNull()
    expect(readAskedQuestions({ ...ended, output: 'cancelled' })?.[0].answer).toBeNull()
  })

  it('accepts the contract shape as well as Claude’s', () => {
    const parsed = readAskedQuestions({
      status: 'declined',
      input: { questions: [{ prompt: 'Which?', options: [] }] },
    })
    expect(parsed).toEqual([{ prompt: 'Which?', answer: null }])
  })

  it('returns null when there is nothing renderable', () => {
    expect(readAskedQuestions(undefined)).toBeNull()
    expect(readAskedQuestions({ input: { questions: [] } })).toBeNull()
    expect(readAskedQuestions({ input: { questions: [{ header: 'no text' }] } })).toBeNull()
  })
})
