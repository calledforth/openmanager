import { describe, expect, it } from 'vitest'
import {
  parseEnvironmentEndpoint,
  readStoredEnvironment,
  writeStoredEnvironment,
} from './environment-store'

describe('parseEnvironmentEndpoint', () => {
  it('accepts http(s) origins and strips a trailing slash', () => {
    expect(parseEnvironmentEndpoint('http://127.0.0.1:43120/')).toBe('http://127.0.0.1:43120')
    expect(parseEnvironmentEndpoint(' https://env.example/path/ ')).toBe('https://env.example/path')
  })

  it('rejects credentials, non-http schemes, and invalid URLs', () => {
    expect(parseEnvironmentEndpoint('')).toBeNull()
    expect(parseEnvironmentEndpoint('not-a-url')).toBeNull()
    expect(parseEnvironmentEndpoint('ws://127.0.0.1:43120')).toBeNull()
    expect(parseEnvironmentEndpoint('http://user:pass@127.0.0.1:43120')).toBeNull()
  })
})

describe('readStoredEnvironment', () => {
  it('returns a sanitized record and ignores corrupt storage', () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          endpoint: 'http://127.0.0.1:43120/',
          environmentId: 'env-local',
          label: 'Local',
        }),
    }
    expect(readStoredEnvironment(storage)).toEqual({
      endpoint: 'http://127.0.0.1:43120',
      environmentId: 'env-local',
      label: 'Local',
    })
    expect(readStoredEnvironment({ getItem: () => 'not-json' })).toBeNull()
    expect(readStoredEnvironment({ getItem: () => JSON.stringify({ endpoint: 'ftp://x' }) })).toBeNull()
  })

  it('returns null when the default storage access throws', () => {
    const original = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    try {
      expect(readStoredEnvironment()).toBeNull()
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: original })
    }
  })

  it('round-trips through writeStoredEnvironment', () => {
    const data = new Map<string, string>()
    writeStoredEnvironment(
      { endpoint: 'http://127.0.0.1:43120', environmentId: 'env-1' },
      { setItem: (key, value) => void data.set(key, value) },
    )
    expect(
      readStoredEnvironment({ getItem: (key) => data.get(key) ?? null }),
    ).toEqual({ endpoint: 'http://127.0.0.1:43120', environmentId: 'env-1' })
  })
})
