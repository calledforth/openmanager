import { describe, expect, it, vi } from 'vitest'
import { environmentLocalOwnerUrl, isLoopbackEnvironmentEndpoint } from './environment-store'
import { fetchLocalOwner, LOCAL_OWNER_CLAIM_HEADER, parseLocalOwnerClaim } from './local-owner'

const OWNER_CREDENTIAL = `omc1.${'A'.repeat(43)}`
const CLAIM_KEY = 'K'.repeat(43)

describe('loopback environment endpoints', () => {
  it('recognizes loopback HTTP endpoints and joins /local-owner under a path prefix', () => {
    expect(isLoopbackEnvironmentEndpoint('http://127.0.0.1:43120')).toBe(true)
    expect(isLoopbackEnvironmentEndpoint('http://localhost:43120/')).toBe(true)
    expect(isLoopbackEnvironmentEndpoint('https://tunnel.example')).toBe(false)
    expect(environmentLocalOwnerUrl('https://host.example/openmanager')).toBe(
      'https://host.example/openmanager/local-owner',
    )
  })
})

describe('parseLocalOwnerClaim', () => {
  it('accepts an owner credential and rejects anything else', () => {
    expect(
      parseLocalOwnerClaim({
        environmentId: 'env-local',
        kind: 'owner',
        credential: OWNER_CREDENTIAL,
        grant: ['read', 'admin'],
        label: 'Home',
      }),
    ).toEqual({
      environmentId: 'env-local',
      kind: 'owner',
      credential: OWNER_CREDENTIAL,
      grant: ['read', 'admin'],
      label: 'Home',
    })
    expect(parseLocalOwnerClaim({ kind: 'paired', credential: OWNER_CREDENTIAL })).toBeUndefined()
    expect(
      parseLocalOwnerClaim({
        environmentId: 'env-local',
        kind: 'owner',
        credential: 'not-a-credential',
      }),
    ).toBeUndefined()
  })
})

describe('fetchLocalOwner', () => {
  it('does not contact remote endpoints', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchLocalOwner('https://tunnel.example', CLAIM_KEY)).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not contact loopback without the process-scoped claim key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchLocalOwner('http://127.0.0.1:43120', '')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('returns a parsed claim from a loopback environment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          environmentId: 'env-local',
          kind: 'owner',
          credential: OWNER_CREDENTIAL,
          grant: ['read'],
        }),
      })),
    )
    expect(await fetchLocalOwner('http://127.0.0.1:43120', CLAIM_KEY)).toEqual({
      environmentId: 'env-local',
      kind: 'owner',
      credential: OWNER_CREDENTIAL,
      grant: ['read'],
    })
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://127.0.0.1:43120/local-owner',
      expect.objectContaining({
        headers: expect.objectContaining({ [LOCAL_OWNER_CLAIM_HEADER]: CLAIM_KEY }),
      }),
    )
    vi.unstubAllGlobals()
  })
})
