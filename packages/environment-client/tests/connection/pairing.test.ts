import { describe, expect, it, vi } from 'vitest'
import { EnvironmentClientError } from '@openmanager/environment-client'
import {
  exchangePairingToken,
  pairingExchangeUrl,
  pairingRejectionReason,
  PairingExchangeError,
  suggestDeviceLabel,
} from './pairing'

const ANSWER = {
  environmentId: 'env-remote',
  label: 'Desk',
  kind: 'paired',
  clientId: 'client-phone',
  clientLabel: 'Chrome on Android',
  grant: ['read'],
  credential: `omc1.${'p'.repeat(43)}`,
}

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('exchangePairingToken', () => {
  it('posts the token and the suggested name, and nothing else, to the route', async () => {
    const fetchImpl = respond(200, ANSWER)
    await expect(
      exchangePairingToken(
        'https://desk.example/om',
        { token: 'ABCDEFGHJKMN', label: 'Chrome on Android' },
        fetchImpl,
      ),
    ).resolves.toEqual(ANSWER)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://desk.example/om/pair')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(JSON.parse(String(init.body))).toEqual({
      token: 'ABCDEFGHJKMN',
      label: 'Chrome on Android',
    })
  })

  it('says why the environment refused the link', async () => {
    const fetchImpl = respond(401, {
      type: 'error',
      requestId: null,
      error: { code: 'auth', message: 'expired', details: { reason: 'expired' } },
    })
    const refused = exchangePairingToken(
      'https://desk.example',
      { token: 'ABCDEFGHJKMN' },
      fetchImpl,
    )
    await expect(refused).rejects.toBeInstanceOf(PairingExchangeError)
    await expect(refused).rejects.toMatchObject({
      reason: 'expired',
      message: expect.stringMatching(/expired/),
    })
  })

  it('tells an unreachable route, a rate limit and a non-pairing answer apart', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(
      exchangePairingToken('https://desk.example', { token: 'ABCDEFGHJKMN' }, down),
    ).rejects.toThrow(/Could not reach https:\/\/desk.example/)
    await expect(
      exchangePairingToken('https://desk.example', { token: 'ABCDEFGHJKMN' }, respond(429, {})),
    ).rejects.toThrow(/Too many pairing attempts/)
    await expect(
      exchangePairingToken(
        'https://desk.example',
        { token: 'ABCDEFGHJKMN' },
        respond(200, { ...ANSWER, credential: undefined }),
      ),
    ).rejects.toThrow(/not a pairing/)
  })
})

describe('pairingRejectionReason', () => {
  it('reads the reason from a socket refusal or an exchange refusal', () => {
    expect(
      pairingRejectionReason(
        new EnvironmentClientError('conflict', 'no', { reason: 'already_authorized' }),
      ),
    ).toBe('already_authorized')
    expect(pairingRejectionReason(new PairingExchangeError('no', 'used'))).toBe('used')
    expect(pairingRejectionReason(new EnvironmentClientError('auth', 'no'))).toBeUndefined()
    expect(pairingRejectionReason(new Error('no'))).toBeUndefined()
  })
})

describe('pairingExchangeUrl', () => {
  it('keeps a route path prefix', () => {
    expect(pairingExchangeUrl('http://127.0.0.1:43120')).toBe('http://127.0.0.1:43120/pair')
    expect(pairingExchangeUrl('https://tunnel.example/env')).toBe('https://tunnel.example/env/pair')
  })
})

describe('suggestDeviceLabel', () => {
  it('names the browser and the platform', () => {
    expect(
      suggestDeviceLabel(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android')
    expect(
      suggestDeviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone')
    expect(
      suggestDeviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      ),
    ).toBe('Edge on Windows')
    expect(suggestDeviceLabel('')).toBe('Web browser')
  })
})
