import { describe, expect, it } from 'vitest'
import { resolveSessionProviderId, sessionsForProvider } from './session-provider'

describe('resolveSessionProviderId', () => {
  it('preserves a persisted Cursor provider', () => {
    expect(resolveSessionProviderId('cursor')).toBe('cursor')
  })

  it('keeps legacy and invalid session records on OpenCode', () => {
    expect(resolveSessionProviderId(undefined)).toBe('opencode')
    expect(resolveSessionProviderId('unknown-provider')).toBe('opencode')
  })

  it('keeps mixed-provider hydration on the selected provider', () => {
    const sessions = [
      { externalId: 'legacy' },
      { externalId: 'open', providerId: 'opencode' },
      { externalId: 'cursor', providerId: 'cursor' },
    ]

    expect(sessionsForProvider(sessions, 'cursor').map((session) => session.externalId)).toEqual([
      'cursor',
    ])
    expect(sessionsForProvider(sessions, 'opencode').map((session) => session.externalId)).toEqual([
      'legacy',
      'open',
    ])
  })
})
