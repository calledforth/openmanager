import { describe, expect, it } from 'vitest'
import { environmentSocketUrl } from './environment-socket'

describe('environmentSocketUrl', () => {
  it('swaps http for ws and appends the socket path', () => {
    expect(environmentSocketUrl('http://127.0.0.1:4321')).toBe('ws://127.0.0.1:4321/ws')
  })

  it('keeps a path prefix and upgrades https to wss', () => {
    expect(environmentSocketUrl('https://tunnel.example/env')).toBe(
      'wss://tunnel.example/env/ws',
    )
  })
})
