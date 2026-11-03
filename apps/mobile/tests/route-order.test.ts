import { describe, expect, it } from 'vitest'
import { isLocalNetworkEndpoint, phoneSearchOrder } from '../src/environment/route-order'
import { LAN, TUNNEL, registryWith } from './support'

describe('phone route order', () => {
  it('counts private, link-local and mDNS addresses as the local network', () => {
    for (const endpoint of [
      'http://10.0.0.4:43120',
      'http://172.16.0.9:43120',
      'http://172.31.255.1',
      'http://192.168.1.20:43120',
      'http://169.254.10.2',
      'http://studio.local:43120',
      'http://studio.home.arpa',
      'http://[fd12:3456::1]:43120',
      'http://[fe80::1]:43120',
    ]) {
      expect(isLocalNetworkEndpoint(endpoint), endpoint).toBe(true)
    }
    for (const endpoint of [
      'https://studio.example.com',
      'http://172.32.0.1',
      'http://100.64.0.7:43120',
      'http://8.8.8.8',
      'http://[2001:db8::1]',
      'not a url',
    ]) {
      expect(isLocalNetworkEndpoint(endpoint), endpoint).toBe(false)
    }
  })

  it('puts local-network routes ahead of the rest, each group in the person order', () => {
    const environment = registryWith([
      TUNNEL,
      'https://backup.example.com',
      LAN,
      'http://10.0.0.4:43120',
    ]).environments[0]!
    expect(phoneSearchOrder(environment).routes.map((route) => route.endpoint)).toEqual([
      LAN,
      'http://10.0.0.4:43120',
      TUNNEL,
      'https://backup.example.com',
    ])
    // The saved record is left as it was.
    expect(environment.routes[0]!.endpoint).toBe(TUNNEL)
  })

  it('hands the record back unchanged when there is nothing to reorder', () => {
    const environment = registryWith([TUNNEL]).environments[0]!
    expect(phoneSearchOrder(environment)).toBe(environment)
  })
})
