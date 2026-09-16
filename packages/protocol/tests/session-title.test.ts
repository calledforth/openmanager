import { describe, expect, it } from 'vitest'
import {
  isPlaceholderTitle,
  shouldReplaceSessionTitle,
  titleFromPrompt,
} from '@openmanager/protocol'

describe('session title precedence', () => {
  it('recognizes generated placeholders', () => {
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle(null)).toBe(true)
    expect(isPlaceholderTitle('   ')).toBe(true)
    expect(isPlaceholderTitle('ACP Session 12345678-abcd')).toBe(true)
    expect(isPlaceholderTitle('New session - 42')).toBe(true)
    expect(isPlaceholderTitle('session-a1b2c3')).toBe(true)
    expect(isPlaceholderTitle('Implement server titles')).toBe(false)
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
    expect(shouldReplaceSessionTitle('Custom name', 'user', 'fallback')).toBe(false)
    expect(shouldReplaceSessionTitle('Provider title', 'provider', 'user')).toBe(true)
  })
})

describe('titleFromPrompt', () => {
  it('collapses whitespace into a single line', () => {
    expect(titleFromPrompt('  Fix   the\n\tsidebar  ')).toBe('Fix the sidebar')
  })

  it('has no title for an empty prompt', () => {
    expect(titleFromPrompt('')).toBeUndefined()
    expect(titleFromPrompt(' \n\t ')).toBeUndefined()
  })

  it('leaves a prompt of exactly the limit alone', () => {
    const exact = 'a'.repeat(80)
    expect(titleFromPrompt(exact)).toBe(exact)
  })

  it('truncates a longer prompt with an ellipsis', () => {
    const long = 'b'.repeat(200)
    expect(titleFromPrompt(long)).toBe(`${'b'.repeat(77)}...`)
    expect(titleFromPrompt(long)).toHaveLength(80)
  })
})
