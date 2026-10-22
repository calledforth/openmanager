import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PAIRING_TOKEN } from './support'

vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }))

/**
 * The shared endpoint helpers under the URL the phone actually has. Node's
 * own URL is swapped out for the polyfill for the length of this file, so a
 * difference between the two shows up here rather than on a device.
 */
const NodeURL = globalThis.URL

beforeAll(async () => {
  const { URL: PolyfillURL } = await import('react-native-url-polyfill')
  globalThis.URL = PolyfillURL as unknown as typeof URL
})

afterAll(() => {
  globalThis.URL = NodeURL
})

describe('shared endpoint helpers on the phone URL', () => {
  it('runs under the polyfill, not Node', () => {
    expect(globalThis.URL).not.toBe(NodeURL)
  })

  it('parses, joins and classifies endpoints as on the web', async () => {
    const connection = await import('@openmanager/environment-client/connection')
    const { isLocalNetworkEndpoint } = await import('../src/environment/route-order')
    expect(connection.parseEnvironmentEndpoint(' http://192.168.1.20:43120/ ')).toBe(
      'http://192.168.1.20:43120',
    )
    expect(connection.parseEnvironmentEndpoint('https://studio.example.com/env/?x=1#y')).toBe(
      'https://studio.example.com/env',
    )
    expect(connection.parseEnvironmentEndpoint('ws://192.168.1.20:43120')).toBeNull()
    expect(connection.environmentBootstrapUrl('https://studio.example.com/env')).toBe(
      'https://studio.example.com/env/bootstrap',
    )
    expect(connection.environmentSocketUrl('http://192.168.1.20:43120')).toBe(
      'ws://192.168.1.20:43120/ws',
    )
    expect(connection.environmentSocketUrl('https://studio.example.com/env')).toBe(
      'wss://studio.example.com/env/ws',
    )
    expect(connection.pairingExchangeUrl('https://studio.example.com/env')).toBe(
      'https://studio.example.com/env/pair',
    )
    expect(connection.isLoopbackEnvironmentEndpoint('http://127.0.0.1:43120')).toBe(true)
    expect(connection.isLoopbackEnvironmentEndpoint('http://[::1]:43120')).toBe(true)
    expect(isLocalNetworkEndpoint('http://192.168.1.20:43120')).toBe(true)
    expect(isLocalNetworkEndpoint('https://studio.example.com')).toBe(false)
  })

  it('reads a pairing link the web encoded', async () => {
    const { encodePairingLink, parsePairingLink } = await import('@openmanager/environment-client')
    const payload = {
      route: 'https://studio.example.com/env',
      environmentId: 'env-studio',
      token: PAIRING_TOKEN,
    }
    const link = encodePairingLink('https://app.example.com', payload)
    expect(parsePairingLink(link)).toEqual({ ok: true, payload })
  })
})
