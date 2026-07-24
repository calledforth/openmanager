import { describe, expect, it } from 'vitest'
import {
  isPlaceholderTitle,
  providerTitlePatch,
  shouldReplaceSessionTitle,
} from '@openmanager/convex/sessionTitle'

describe('session title precedence', () => {
  it('recognizes current generated placeholders', () => {
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle('ACP Session 12345678-abcd')).toBe(true)
    expect(isPlaceholderTitle('New session - 42')).toBe(true)
    expect(isPlaceholderTitle('Implement Cursor titles')).toBe(false)
  })

  it('keeps the first meaningful fallback title', () => {
    expect(shouldReplaceSessionTitle(undefined, undefined, 'fallback')).toBe(true)
    expect(shouldReplaceSessionTitle('New session - 42', 'fallback', 'fallback')).toBe(true)
    expect(shouldReplaceSessionTitle('First prompt', 'fallback', 'fallback')).toBe(false)
  })

  it('lets provider titles replace fallbacks and provider revisions', () => {
    expect(shouldReplaceSessionTitle('First prompt', 'fallback', 'provider')).toBe(true)
    expect(shouldReplaceSessionTitle('Legacy title', undefined, 'provider')).toBe(true)
    expect(shouldReplaceSessionTitle('Old provider title', 'provider', 'provider')).toBe(true)
  })

  it('keeps user titles above provider titles', () => {
    expect(shouldReplaceSessionTitle('Custom name', 'user', 'provider')).toBe(false)
    expect(shouldReplaceSessionTitle('Provider title', 'provider', 'user')).toBe(true)
  })

  it('patches only matching, existing provider sessions', () => {
    expect(providerTitlePatch(undefined, 'cursor', 'Cursor title')).toBeUndefined()
    expect(
      providerTitlePatch(
        { providerId: 'opencode', title: 'OpenCode title', titleSource: 'provider' },
        'cursor',
        'Cursor title',
      ),
    ).toBeUndefined()
    expect(
      providerTitlePatch(
        { providerId: 'cursor', title: 'First prompt', titleSource: 'fallback' },
        'cursor',
        ' Cursor title ',
      ),
    ).toEqual({ title: 'Cursor title', titleSource: 'provider' })
    expect(
      providerTitlePatch({ title: 'Custom title', titleSource: 'user' }, 'cursor', 'Cursor title'),
    ).toEqual({ providerId: 'cursor' })
  })
})
