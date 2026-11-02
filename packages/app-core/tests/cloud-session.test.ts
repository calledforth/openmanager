import { describe, expect, it } from 'vitest'
import { cloudSessionUrl } from '../src/lib/cloud-session'

describe('cloudSessionUrl', () => {
  it('prefills the prompt', () => {
    const url = new URL(cloudSessionUrl('Fix the login bug & add tests')!)
    expect(url.origin + url.pathname).toBe('https://claude.ai/code')
    expect(url.searchParams.get('prompt')).toBe('Fix the login bug & add tests')
  })

  it('refuses a prompt too long for a query string', () => {
    expect(cloudSessionUrl('x'.repeat(10_000))).toBeNull()
  })
})
