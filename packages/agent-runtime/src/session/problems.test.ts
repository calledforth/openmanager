import { describe, expect, it } from 'vitest'
import { problemFromMessage } from './problems.js'

describe('problemFromMessage', () => {
  it.each([
    ["This model's maximum context length is 200000 tokens", 'context_window_exceeded'],
    ['Prompt is too long', 'context_window_exceeded'],
    ['You have reached your usage limit for this month', 'usage_limit'],
    ['Quota exceeded for this account', 'usage_limit'],
    ['429 Too Many Requests', 'rate_limited'],
    ['Rate limit reached', 'rate_limited'],
    ['The model is overloaded, try again', 'overloaded'],
  ])('types %j as %s', (message, code) => {
    expect(problemFromMessage(message)).toEqual({ code })
  })

  it('leaves anything else untyped', () => {
    expect(problemFromMessage('Session not found')).toBeUndefined()
    expect(problemFromMessage('')).toBeUndefined()
  })
})
