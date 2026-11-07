import { describe, expect, it } from 'vitest'

import { backgroundSummary } from '../src/session/background-tasks'

describe('background work in words', () => {
  it('reads one task by its words, or its kind, and several by their count', () => {
    expect(backgroundSummary([{ taskId: 't1', kind: 'shell', description: 'pnpm build' }])).toBe(
      'pnpm build',
    )
    expect(backgroundSummary([{ taskId: 't1', kind: 'agent', description: '  ' }])).toBe(
      'Background agent',
    )
    expect(
      backgroundSummary([
        { taskId: 't1', kind: 'shell', description: 'a' },
        { taskId: 't2', kind: 'monitor', description: 'b' },
      ]),
    ).toBe('2 background tasks')
  })
})
