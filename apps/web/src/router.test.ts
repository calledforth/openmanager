import { createMemoryHistory } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { createWebRouter } from './router'

describe('the web router', () => {
  it('leaves scroll positions alone: the chat places its own reader', () => {
    const router = createWebRouter({ history: createMemoryHistory() })
    expect(router.options.scrollRestoration ?? false).toBe(false)
  })
})
