import { describe, expect, it } from 'vitest'
import {
  claudeQuestionAnswers,
  parseAskUserQuestion,
  planFromExitPlanMode,
} from './claude-interactions.js'
import { claudePromptContent } from './claude-prompt.js'

const question = (text: string, labels: string[], multiSelect = false) => ({
  question: text,
  header: 'Choice',
  multiSelect,
  options: labels.map((label) => ({ label, description: `${label} description` })),
})

describe('parseAskUserQuestion', () => {
  it('gives the UI ids that cannot collide and keeps the texts for Claude', () => {
    const parsed = parseAskUserQuestion('req-1', {
      questions: [question('Which library?', ['zod', 'valibot'])],
    })

    // `${requestId}:${index}`, never the question text: the composer keys React
    // rows and the user's selections by questionId.
    expect(parsed?.questions[0]?.questionId).toBe('req-1:0')
    expect(parsed?.questions[0]?.prompt).toBe('Which library?')
    expect(parsed?.questions[0]?.options).toEqual([
      { optionId: 'o0', label: 'zod', description: 'zod description' },
      { optionId: 'o1', label: 'valibot', description: 'valibot description' },
    ])
    // The tool always offers an implicit "Other".
    expect(parsed?.questions[0]?.allowFreeText).toBe(true)
    expect(parsed?.pending.entries[0]).toEqual({
      questionId: 'req-1:0',
      text: 'Which library?',
      labels: ['zod', 'valibot'],
    })
  })

  it('titles a single question with its header and leaves a set untitled', () => {
    expect(parseAskUserQuestion('req-1', { questions: [question('A?', ['x', 'y'])] })?.title).toBe(
      'Choice',
    )
    expect(
      parseAskUserQuestion('req-1', {
        questions: [question('A?', ['x', 'y']), question('B?', ['x', 'y'])],
      })?.title,
    ).toBeUndefined()
  })

  it('reports duplicate question texts rather than letting them silently collide', () => {
    const parsed = parseAskUserQuestion('req-1', {
      questions: [question('Same?', ['a', 'b']), question('Same?', ['c', 'd'])],
    })
    expect(parsed?.questions.map((q) => q.questionId)).toEqual(['req-1:0', 'req-1:1'])
    expect(parsed?.pending.duplicateTexts).toEqual(['Same?'])
  })

  it('declines anything that is not a question set', () => {
    expect(parseAskUserQuestion('req-1', {})).toBeUndefined()
    expect(parseAskUserQuestion('req-1', { questions: [] })).toBeUndefined()
  })
})

describe('claudeQuestionAnswers', () => {
  it('keys answers by the full original question text', () => {
    const parsed = parseAskUserQuestion('req-1', {
      questions: [question('Which library?', ['zod', 'valibot'])],
    })!
    expect(
      claudeQuestionAnswers(parsed.pending, {
        outcome: 'answered',
        answers: [{ questionId: 'req-1:0', selectedOptionIds: ['o1'] }],
      }),
      // The SDK looks the answer up by the question string it sent, so the key
      // is the text and the value is the option LABEL, not our synthetic id.
    ).toEqual({ 'Which library?': 'valibot' })
  })

  it('comma-joins a multi-select answer, which is the documented encoding', () => {
    const parsed = parseAskUserQuestion('req-1', {
      questions: [question('Which features?', ['auth', 'billing', 'search'], true)],
    })!
    expect(
      claudeQuestionAnswers(parsed.pending, {
        outcome: 'answered',
        answers: [{ questionId: 'req-1:0', selectedOptionIds: ['o0', 'o2'], text: 'and logging' }],
      }),
    ).toEqual({ 'Which features?': 'auth, search, and logging' })
  })

  it('merges the answers to duplicate texts instead of dropping one', () => {
    const parsed = parseAskUserQuestion('req-1', {
      questions: [question('Same?', ['a', 'b']), question('Same?', ['c', 'd'])],
    })!
    // One key, two questions: the SDK's shape cannot hold both. Letting the
    // later one win would silently discard an answer the user gave.
    expect(
      claudeQuestionAnswers(parsed.pending, {
        outcome: 'answered',
        answers: [
          { questionId: 'req-1:0', selectedOptionIds: ['o0'] },
          { questionId: 'req-1:1', selectedOptionIds: ['o1'] },
        ],
      }),
    ).toEqual({ 'Same?': 'a, d' })
  })

  it('omits a question the user did not answer', () => {
    const parsed = parseAskUserQuestion('req-1', {
      questions: [question('A?', ['x', 'y']), question('B?', ['x', 'y'])],
    })!
    expect(
      claudeQuestionAnswers(parsed.pending, {
        outcome: 'answered',
        answers: [{ questionId: 'req-1:1', selectedOptionIds: ['o0'] }],
      }),
    ).toEqual({ 'B?': 'x' })
  })
})

describe('planFromExitPlanMode', () => {
  it('derives a document from the markdown without losing the markdown', () => {
    const plan = planFromExitPlanMode({
      plan: [
        '# Refactor the runtime',
        '',
        'Split the transport seam first.',
        '',
        '- [x] Read the code',
        '- Extract the interface',
        '1. Wire it up',
      ].join('\n'),
    })

    expect(plan.name).toBe('Refactor the runtime')
    expect(plan.overview).toBe('Split the transport seam first.')
    expect(plan.todos).toEqual([
      { id: 'plan-0', content: 'Read the code', status: 'completed' },
      // An unchecked box and a plain bullet are both still to do.
      { id: 'plan-1', content: 'Extract the interface', status: 'pending' },
      { id: 'plan-2', content: 'Wire it up', status: 'pending' },
    ])
    expect(plan.markdown).toContain('# Refactor the runtime')
  })

  it('always says the approval releases the same turn', () => {
    // Dispatching a follow-up prompt here would run the whole plan twice.
    expect(planFromExitPlanMode({ plan: 'do it' }).continuation).toBe('same_turn')
    expect(planFromExitPlanMode({}).continuation).toBe('same_turn')
  })

  it('survives a plan with no structure at all', () => {
    expect(planFromExitPlanMode({})).toMatchObject({ markdown: '', todos: [] })
  })
})

describe('claudePromptContent', () => {
  it('sends a text-only prompt as the bare string the CLI writes itself', () => {
    expect(claudePromptContent({ text: 'hello', blocks: [{ type: 'text', text: 'hello' }] })).toBe(
      'hello',
    )
    expect(claudePromptContent({ text: 'hello', blocks: [] })).toBe('hello')
  })

  it('converts an image attachment into a base64 source block', () => {
    expect(
      claudePromptContent({
        text: 'what is this',
        blocks: [
          { type: 'text', text: 'what is this' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        ],
      }),
    ).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
  })

  it('refuses content the API cannot carry, before anything is dispatched', () => {
    // The SDK's input is a stream with no per-message ack: a message it cannot
    // represent is not rejected, it is mistranslated, and the turn silently
    // never does what was asked.
    expect(() =>
      claudePromptContent({
        text: '',
        blocks: [{ type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' }],
      }),
    ).toThrow(/image\/svg\+xml/)
    expect(() =>
      claudePromptContent({
        text: '',
        blocks: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }],
      }),
    ).toThrow(/audio/)
    expect(() =>
      claudePromptContent({ text: '', blocks: [{ type: 'resource_link', uri: 'file:///a.ts' }] }),
    ).toThrow(/resource_link/)
  })
})
