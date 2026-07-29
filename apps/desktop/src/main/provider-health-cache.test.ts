import { describe, expect, it } from 'vitest'
import type { ProviderHealth } from '@openmanager/shared/contracts/provider-health'
import { sanitizeProviderHealthCache, toProviderHealthCache } from './provider-health-cache'

const PROBED_AT = '2026-07-27T10:00:00.000Z'

function health(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    install: { state: 'installed', version: '2026.07.23', command: 'cursor-agent' },
    auth: { state: 'authenticated', methodId: 'cursor_login' },
    runtime: { state: 'running', liveProcesses: 3, activeTurns: 1 },
    models: {
      models: [{ id: 'composer-2.5', displayName: 'Composer 2.5' }],
      refreshedAt: PROBED_AT,
    },
    lastProbe: { outcome: 'ok', at: PROBED_AT, durationMs: 812 },
    update: { state: 'unknown' },
    ...overrides,
  }
}

describe('toProviderHealthCache', () => {
  it('never persists process liveness', () => {
    const cache = toProviderHealthCache({ cursor: { health: health(), refreshing: false } })
    expect(cache.cursor?.runtime).toEqual({
      state: 'never_started',
      liveProcesses: 0,
      activeTurns: 0,
    })
  })

  it('keeps the axes that are still true after a restart', () => {
    const cache = toProviderHealthCache({ cursor: { health: health(), refreshing: true } })
    expect(cache.cursor?.install).toMatchObject({ state: 'installed', version: '2026.07.23' })
    expect(cache.cursor?.auth.state).toBe('authenticated')
    expect(cache.cursor?.lastProbe).toEqual({ outcome: 'ok', at: PROBED_AT, durationMs: 812 })
    expect(cache.cursor?.models.models).toHaveLength(1)
  })

  it('skips providers nothing was ever learned about', () => {
    const cache = toProviderHealthCache({
      opencode: {
        health: health({ install: { state: 'unknown' }, lastProbe: null }),
        refreshing: false,
      },
    })
    expect(cache.opencode).toBeUndefined()
  })

  it('round-trips through the sanitizer', () => {
    const cache = toProviderHealthCache({ cursor: { health: health(), refreshing: false } })
    expect(sanitizeProviderHealthCache(JSON.parse(JSON.stringify(cache)))).toEqual(cache)
  })
})

describe('sanitizeProviderHealthCache', () => {
  it('drops unknown providers and unparseable entries', () => {
    expect(sanitizeProviderHealthCache({ nonsense: health() })).toEqual({})
    expect(sanitizeProviderHealthCache({ cursor: 'not an object' })).toEqual({})
    expect(sanitizeProviderHealthCache(null)).toEqual({})
    expect(sanitizeProviderHealthCache([1, 2, 3])).toEqual({})
  })

  it('rejects a probe with no usable timestamp, so it cannot look infinitely fresh', () => {
    const restored = sanitizeProviderHealthCache({
      cursor: {
        install: { state: 'installed' },
        lastProbe: { outcome: 'ok', at: 'yesterday', durationMs: 1 },
      },
    })
    expect(restored.cursor?.lastProbe).toBeNull()
  })

  it('falls back to unknown for states it does not recognise', () => {
    const restored = sanitizeProviderHealthCache({
      cursor: {
        install: { state: 'healthy', version: 3 },
        auth: { state: 'probably' },
        lastProbe: { outcome: 'ok', at: PROBED_AT, durationMs: -5 },
      },
    })
    expect(restored.cursor?.install).toEqual({ state: 'unknown' })
    expect(restored.cursor?.auth).toEqual({ state: 'unknown' })
    expect(restored.cursor?.lastProbe?.durationMs).toBe(0)
  })

  it('drops model entries that are missing an id or a name', () => {
    const restored = sanitizeProviderHealthCache({
      cursor: {
        install: { state: 'installed' },
        models: {
          models: [
            { id: 'composer-2.5', displayName: 'Composer 2.5' },
            { id: 'no-name' },
            'garbage',
          ],
          refreshedAt: PROBED_AT,
        },
      },
    })
    expect(restored.cursor?.models.models).toEqual([
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
    ])
  })

  it('never restores a runtime axis or an update advisory', () => {
    const restored = sanitizeProviderHealthCache({
      cursor: {
        install: { state: 'installed' },
        runtime: { state: 'running', liveProcesses: 9, activeTurns: 4 },
        update: { state: 'behind', latestVersion: '2099.01.01' },
      },
    })
    expect(restored.cursor?.runtime.liveProcesses).toBe(0)
    expect(restored.cursor?.update).toEqual({ state: 'unknown' })
  })
})
