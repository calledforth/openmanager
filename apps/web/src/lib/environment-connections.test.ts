import { describe, expect, it } from 'vitest'
import type { RouteFailure } from './connection-state'
import {
  connectionOf,
  dropConnection,
  NO_CONNECTIONS,
  patchConnection,
  tokenIsRefused,
} from './environment-connections'

const refused: RouteFailure = {
  reason: 'credential_rejected',
  endpoint: 'http://127.0.0.1:43120',
  local: true,
  tried: 1,
}
const down: RouteFailure = { ...refused, reason: 'route_down' }

describe('environment connections', () => {
  it('keeps each environment to itself', () => {
    const connections = patchConnection(
      patchConnection(NO_CONNECTIONS, 'env-a', { routeFailure: refused }),
      'env-b',
      { hasConnected: true },
    )

    expect(tokenIsRefused(connectionOf(connections, 'env-a'))).toBe(true)
    expect(connectionOf(connections, 'env-a').hasConnected).toBe(false)
    expect(tokenIsRefused(connectionOf(connections, 'env-b'))).toBe(false)
    expect(connectionOf(connections, 'env-b').hasConnected).toBe(true)
  })

  it('reads an environment it has nothing on as idle', () => {
    for (const id of ['env-a', 'constructor', '__proto__', null, undefined]) {
      expect(connectionOf(NO_CONNECTIONS, id)).toEqual({
        hasConnected: false,
        routeFailure: null,
        routeSearch: null,
        socket: null,
      })
    }
  })

  it('returns the same value when nothing changed', () => {
    const connections = patchConnection(NO_CONNECTIONS, 'env-a', {
      socket: { endpoint: 'http://a', connected: true },
    })

    expect(
      patchConnection(connections, 'env-a', { socket: { endpoint: 'http://a', connected: true } }),
    ).toBe(connections)
    expect(patchConnection(connections, 'env-a', { routeFailure: null })).toBe(connections)
    expect(patchConnection(NO_CONNECTIONS, 'env-a', { hasConnected: false })).toBe(NO_CONNECTIONS)
    expect(dropConnection(connections, 'env-b')).toBe(connections)
  })

  it('counts a failure found again as a change', () => {
    const connections = patchConnection(NO_CONNECTIONS, 'env-a', { routeFailure: down })

    expect(patchConnection(connections, 'env-a', { routeFailure: { ...down } })).not.toBe(
      connections,
    )
  })

  it('leaves out a connection that has gone back to idle', () => {
    const connections = patchConnection(NO_CONNECTIONS, 'env-a', { hasConnected: true })

    expect(patchConnection(connections, 'env-a', { hasConnected: false })).toEqual({})
    expect(dropConnection(connections, 'env-a')).toEqual({})
  })

  it('only reads a token as refused for that reason', () => {
    expect(tokenIsRefused(connectionOf(NO_CONNECTIONS, 'env-a'))).toBe(false)
    expect(
      tokenIsRefused(
        connectionOf(patchConnection(NO_CONNECTIONS, 'env-a', { routeFailure: down }), 'env-a'),
      ),
    ).toBe(false)
  })
})
