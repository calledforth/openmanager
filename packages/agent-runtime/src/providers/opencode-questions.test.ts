import { describe, expect, it } from 'vitest'
import { openCodeAnswers, parseOpenCodeQuestionEvent } from './opencode-questions.js'

describe('OpenCode native questions', () => {
  const event = {
    directory: 'C:/workspace',
    payload: {
      type: 'question.asked',
      properties: {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Strategy',
            question: 'Which implementation should we use?',
            options: [
              { label: 'Simple', description: 'Smallest implementation' },
              { label: 'Robust', description: 'Handles every edge case' },
            ],
            multiple: true,
            custom: true,
          },
        ],
      },
    },
  }

  it('maps question.asked into the provider-neutral contract', () => {
    expect(parseOpenCodeQuestionEvent(event)?.request).toEqual({
      requestId: 'request-1',
      sessionId: 'session-1',
      title: 'Strategy',
      questions: [
        {
          questionId: 'q0',
          prompt: 'Which implementation should we use?',
          options: [
            {
              optionId: 'o0',
              label: 'Simple',
              description: 'Smallest implementation',
            },
            {
              optionId: 'o1',
              label: 'Robust',
              description: 'Handles every edge case',
            },
          ],
          allowMultiple: true,
          allowFreeText: true,
        },
      ],
    })
  })

  it('maps option ids and custom text back to ordered OpenCode answers', () => {
    const parsed = parseOpenCodeQuestionEvent(event)!
    expect(
      openCodeAnswers(
        {
          outcome: 'answered',
          answers: [
            {
              questionId: 'q0',
              selectedOptionIds: ['o1'],
              text: 'A staged version',
            },
          ],
        },
        parsed.nativeQuestions,
      ),
    ).toEqual([['Robust', 'A staged version']])
  })

  it('maps cancellation to OpenCode rejection', () => {
    const parsed = parseOpenCodeQuestionEvent(event)!
    expect(
      openCodeAnswers({ outcome: 'cancelled', reason: 'user' }, parsed.nativeQuestions),
    ).toBeUndefined()
  })
})
