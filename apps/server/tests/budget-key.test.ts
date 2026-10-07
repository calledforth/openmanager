import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { clientNetwork, createBudgetKey } from '../src/budget-key.js'

const request = (remoteAddress: string, headers: Record<string, string>) =>
  ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage

describe('failed-attempt budget keys', () => {
  const key = createBudgetKey('om.example.com')

  it('keys tunnel traffic by the address Cloudflare names', () => {
    expect(
      key(request('127.0.0.1', { host: 'om.example.com', 'cf-connecting-ip': '203.0.113.7' })),
    ).toBe('tunnel:203.0.113.7')
    expect(key(request('::1', { host: 'OM.example.com', 'cf-connecting-ip': '2001:db8::1' }))).toBe(
      'tunnel:2001:db8:0:0::/64',
    )
    // No usable header: one tunnel bucket, still apart from local traffic.
    expect(key(request('127.0.0.1', { host: 'om.example.com' }))).toBe('tunnel:unknown')
    expect(
      key(request('127.0.0.1', { host: 'om.example.com', 'cf-connecting-ip': 'nonsense' })),
    ).toBe('tunnel:unknown')
  })

  it('ignores the header everywhere else', () => {
    expect(
      key(request('127.0.0.1', { host: '127.0.0.1:43120', 'cf-connecting-ip': '203.0.113.7' })),
    ).toBe('127.0.0.1')
    expect(
      key(request('192.0.2.4', { host: 'om.example.com', 'cf-connecting-ip': '203.0.113.7' })),
    ).toBe('192.0.2.4')
    expect(
      createBudgetKey(undefined)(
        request('127.0.0.1', { host: 'om.example.com', 'cf-connecting-ip': '203.0.113.7' }),
      ),
    ).toBe('127.0.0.1')
  })

  it('groups IPv6 by /64 and unwraps mapped IPv4', () => {
    expect(clientNetwork('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(clientNetwork('2001:DB8:1:2::abcd')).toBe('2001:db8:1:2::/64')
    expect(clientNetwork('::ffff:198.51.100.4')).toBe('198.51.100.4')
    expect(clientNetwork('::')).toBe('0:0:0:0::/64')
    expect(clientNetwork('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(clientNetwork('1.2.3')).toBeUndefined()
  })
})
