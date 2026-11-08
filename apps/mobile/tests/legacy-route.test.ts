import { describe, expect, it, vi } from 'vitest'

// The redirect component needs expo-router and the phone's providers; the
// pure decision is what is tested here.
vi.mock('expo-router', () => ({ Redirect: () => null }))
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({ usePhoneConnection: () => null }))
vi.mock('../src/home/source', () => ({ useHomeSource: () => null }))
const { LEGACY_WAIT_MS, legacyEnvironmentOf } = await import('../src/environment/legacy-route')

const DESK = { environmentId: 'env-1' }
const LAPTOP = { environmentId: 'env-2' }

const decide = (input: Partial<Parameters<typeof legacyEnvironmentOf>[0]> = {}) =>
  legacyEnvironmentOf({
    loaded: true,
    environments: [DESK, LAPTOP],
    selectedId: DESK.environmentId,
    holders: [],
    late: false,
    ...input,
  })

describe('which environment an old address opens in', () => {
  it('waits while the phone is still reading what it saved', () => {
    expect(decide({ loaded: false, environments: [DESK], late: true })).toBe('wait')
  })

  it('is nobody’s with nothing saved', () => {
    expect(decide({ environments: [], selectedId: null })).toBeNull()
    expect(decide({ environments: [], selectedId: null, late: true })).toBeNull()
  })

  it('is the one environment at once when only one is saved, whatever its listing says', () => {
    expect(decide({ environments: [DESK] })).toBe('env-1')
    expect(decide({ environments: [LAPTOP], selectedId: null })).toBe('env-2')
    // Its listing has not caught up yet: still that one, without waiting.
    expect(decide({ environments: [LAPTOP], selectedId: 'env-2', holders: [], late: false })).toBe(
      'env-2',
    )
  })

  it('is the environment whose listing holds the id, with several saved', () => {
    expect(decide({ holders: ['env-2'] })).toBe('env-2')
    expect(decide({ holders: ['env-1'] })).toBe('env-1')
    // Known at once: no wait, however early.
    expect(decide({ holders: ['env-2'], late: false })).toBe('env-2')
  })

  it('prefers the default environment when both hold the id', () => {
    expect(decide({ holders: ['env-1', 'env-2'], selectedId: 'env-2' })).toBe('env-2')
    expect(decide({ holders: ['env-2', 'env-1'], selectedId: 'env-1' })).toBe('env-1')
    // The default does not hold it: the first holder in the saved order.
    expect(decide({ holders: ['env-2'], selectedId: 'env-1' })).toBe('env-2')
  })

  it('waits for the listings while none holds it, then falls back to the default', () => {
    expect(decide({ holders: [] })).toBe('wait')
    expect(decide({ holders: [], late: true })).toBe('env-1')
    expect(decide({ holders: [], late: true, selectedId: 'env-2' })).toBe('env-2')
    // No default saved: the first saved environment.
    expect(decide({ holders: [], late: true, selectedId: null })).toBe('env-1')
    expect(LEGACY_WAIT_MS).toBe(4000)
  })
})
