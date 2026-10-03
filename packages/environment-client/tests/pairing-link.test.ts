import { describe, expect, it } from 'vitest'
import {
  encodePairingLink,
  normalizePairingRoute,
  parsePairingLink,
  type PairingPayload,
} from '../src/index'

const payload: PairingPayload = {
  route: 'https://tunnel.example/openmanager',
  environmentId: 'env-1',
  token: 'ABCDEFGHJKMN',
}

describe('pairing links', () => {
  it('put the payload in the fragment of the app pair page and read it back', () => {
    const link = encodePairingLink('https://app.example', payload)
    const url = new URL(link)
    expect(url.origin + url.pathname).toBe('https://app.example/pair')
    expect(url.search).toBe('')
    expect(url.hash).toContain('token=ABCDEFGHJKMN')
    expect(parsePairingLink(link)).toEqual({ ok: true, payload })
    expect(parsePairingLink(url.hash)).toEqual({ ok: true, payload })
  })

  it('keep an app served under a path', () => {
    const link = encodePairingLink('https://example.com/app/', payload)
    expect(new URL(link).pathname).toBe('/app/pair')
  })

  it('carry any http(s) route: loopback, LAN or tunnel', () => {
    for (const route of [
      'http://127.0.0.1:43120',
      'http://192.168.1.20:43120',
      'https://x.trycloudflare.com',
    ]) {
      const link = encodePairingLink('https://app.example', { ...payload, route })
      expect(parsePairingLink(link)).toMatchObject({ ok: true, payload: { route } })
    }
  })

  it('reject links that are not version 1 or are missing a part', () => {
    const link = encodePairingLink('https://app.example', payload)
    expect(parsePairingLink(link.replace('v=1', 'v=2'))).toEqual({
      ok: false,
      reason: 'unsupported_version',
    })
    expect(parsePairingLink(link.replace(/&token=[^&]+/, ''))).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(parsePairingLink(link.replace('ABCDEFGHJKMN', 'ABCDEFGHJKM0'))).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(parsePairingLink('https://app.example/pair')).toEqual({
      ok: false,
      reason: 'not_a_link',
    })
  })

  it('normalize the token as typed', () => {
    const link = encodePairingLink('https://app.example', payload).replace(
      'ABCDEFGHJKMN',
      'abcd-efgh-jkmn',
    )
    expect(parsePairingLink(link)).toMatchObject({ ok: true, payload: { token: 'ABCDEFGHJKMN' } })
  })
})

describe('pairing routes', () => {
  it('are http(s) URLs without credentials, query or fragment', () => {
    expect(normalizePairingRoute('https://tunnel.example/')).toBe('https://tunnel.example')
    expect(normalizePairingRoute('HTTP://Host.Example:80/a/')).toBe('http://host.example/a')
    expect(normalizePairingRoute('https://user:pw@tunnel.example')).toBeUndefined()
    expect(normalizePairingRoute('https://tunnel.example/?x=1')).toBeUndefined()
    expect(normalizePairingRoute('https://tunnel.example/#x')).toBeUndefined()
    expect(normalizePairingRoute('ftp://tunnel.example')).toBeUndefined()
    expect(normalizePairingRoute('javascript:alert(1)')).toBeUndefined()
    expect(normalizePairingRoute('not a url')).toBeUndefined()
  })

  it('must already be normal inside a payload', () => {
    expect(() =>
      encodePairingLink('https://app.example', { ...payload, route: 'https://tunnel.example/' }),
    ).toThrow()
  })
})
