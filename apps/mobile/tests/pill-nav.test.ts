import { describe, expect, it } from 'vitest'

import { backgroundSummary } from '../src/session/background-tasks'
import { pillOffset, TAB_GAP, TAB_WIDTH, tabEmphasis } from '../src/ui/pill-nav'

describe('the pill highlight', () => {
  it('sits one tab and one gap further per tab', () => {
    expect(pillOffset(0)).toBe(0)
    expect(pillOffset(1)).toBe(TAB_WIDTH + TAB_GAP)
    expect(pillOffset(2)).toBe(2 * (TAB_WIDTH + TAB_GAP))
  })

  it('brightens an icon as the highlight reaches it, and no further than a tab away', () => {
    expect(tabEmphasis(1, 1)).toBe(1)
    expect(tabEmphasis(0.5, 1)).toBeCloseTo(0.5)
    expect(tabEmphasis(0, 1)).toBe(0)
    expect(tabEmphasis(2.4, 1)).toBe(0)
  })
})

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
