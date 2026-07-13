import { describe, expect, it } from 'vitest'
import { normalizeConvexUrl, resolveRuntimeConfig } from './convex-config'

describe('normalizeConvexUrl', () => {
  it('normalizes a secure deployment origin', () => {
    expect(normalizeConvexUrl('  https://example.convex.cloud/ ', false)).toBe(
      'https://example.convex.cloud',
    )
  })

  it('rejects insecure remote URLs', () => {
    expect(() => normalizeConvexUrl('http://example.convex.cloud', true)).toThrow('HTTPS')
  })

  it('allows localhost HTTP only in development', () => {
    expect(normalizeConvexUrl('http://127.0.0.1:3210', true)).toBe('http://127.0.0.1:3210')
    expect(() => normalizeConvexUrl('http://127.0.0.1:3210', false)).toThrow('HTTPS')
  })

  it('rejects credentials, paths, queries, and fragments', () => {
    expect(() => normalizeConvexUrl('https://user:pass@example.com', false)).toThrow('Credentials')
    expect(() => normalizeConvexUrl('https://example.com/path', false)).toThrow('origin')
    expect(() => normalizeConvexUrl('https://example.com?x=1', false)).toThrow('query parameters')
  })
})

describe('resolveRuntimeConfig', () => {
  it('prefers a saved setting over the development environment', () => {
    expect(
      resolveRuntimeConfig('https://saved.convex.cloud', 'https://development.convex.cloud', false),
    ).toEqual({
      convexUrl: 'https://saved.convex.cloud',
      convexSource: 'settings',
      environmentUrlAvailable: true,
    })
  })

  it('falls back to the environment and tolerates an invalid saved value', () => {
    expect(resolveRuntimeConfig('not-a-url', 'https://development.convex.cloud', false)).toEqual({
      convexUrl: 'https://development.convex.cloud',
      convexSource: 'environment',
      environmentUrlAvailable: true,
    })
  })

  it('reports an unset deployment', () => {
    expect(resolveRuntimeConfig('', '', false).convexSource).toBe('unset')
  })
})
