import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  probeRouteHealth,
  routeHealthFromBootstrap,
  routeHealthFromConnection,
  routeHealthLabel,
  WRONG_ENVIRONMENT_MESSAGE,
} from './route-health'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('routeHealthFromBootstrap', () => {
  it('reads an answer from the expected environment as available', () => {
    expect(
      routeHealthFromBootstrap(
        { status: 'ready', environmentId: 'env-a', protocolVersion: PROTOCOL_VERSION },
        'env-a',
      ),
    ).toEqual({ status: 'available' })
  })

  it('still counts a protocol mismatch as available: the route reached the environment', () => {
    expect(
      routeHealthFromBootstrap(
        {
          status: 'incompatible_protocol',
          clientProtocolVersion: 1,
          serverProtocolVersion: 2,
          environmentId: 'env-a',
        },
        'env-a',
      ),
    ).toEqual({ status: 'available' })
  })

  it('reads an answer from another environment as a route that no longer leads here', () => {
    expect(
      routeHealthFromBootstrap(
        { status: 'ready', environmentId: 'env-b', protocolVersion: PROTOCOL_VERSION },
        'env-a',
      ),
    ).toEqual({ status: 'unreachable', message: WRONG_ENVIRONMENT_MESSAGE })
  })

  it('keeps a refusal apart from a route that does not answer', () => {
    expect(
      routeHealthFromBootstrap({ status: 'unauthorized', message: 'Denied.' }, 'env-a'),
    ).toEqual({ status: 'unauthorized', message: 'Denied.' })
    expect(routeHealthFromBootstrap({ status: 'unreachable', message: 'Down.' }, 'env-a')).toEqual({
      status: 'unreachable',
      message: 'Down.',
    })
  })

  it('says nothing before there is an answer', () => {
    expect(routeHealthFromBootstrap({ status: 'loading' }, 'env-a')).toBeNull()
    expect(routeHealthFromBootstrap({ status: 'idle' }, 'env-a')).toBeNull()
  })
})

describe('routeHealthFromConnection', () => {
  it('reports a live socket as available', () => {
    expect(routeHealthFromConnection({ phase: 'connected', failure: null })).toEqual({
      status: 'available',
    })
  })

  it('reports a refused credential and a dropped connection differently', () => {
    expect(
      routeHealthFromConnection({
        phase: 'closed',
        failure: { code: 'auth', message: 'Token revoked.' },
      }),
    ).toEqual({ status: 'unauthorized', message: 'Token revoked.' })
    expect(
      routeHealthFromConnection({
        phase: 'reconnecting',
        failure: { code: 'unavailable', message: 'Connection closed.' },
      }),
    ).toEqual({ status: 'unreachable', message: 'Connection closed.' })
  })

  it('says nothing while connecting or when the failure is not about the route', () => {
    expect(routeHealthFromConnection({ phase: 'connecting', failure: null })).toBeNull()
    expect(
      routeHealthFromConnection({
        phase: 'closed',
        failure: { code: 'protocol_incompatible', message: 'Upgrade.' },
      }),
    ).toBeNull()
  })
})

describe('probeRouteHealth', () => {
  it('reports a route that does not answer as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(probeRouteHealth('env-a', 'https://tunnel.example')).resolves.toMatchObject({
      status: 'unreachable',
    })
  })

  it('checks that the answer comes from the environment the route belongs to', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          environmentId: 'env-b',
          capabilities: [],
        }),
      })),
    )
    await expect(probeRouteHealth('env-b', 'http://127.0.0.1:43120')).resolves.toEqual({
      status: 'available',
    })
    await expect(probeRouteHealth('env-a', 'http://127.0.0.1:43120')).resolves.toEqual({
      status: 'unreachable',
      message: WRONG_ENVIRONMENT_MESSAGE,
    })
  })
})

describe('routeHealthLabel', () => {
  it('names every status in plain words', () => {
    expect(routeHealthLabel('unknown')).toBe('Not checked')
    expect(routeHealthLabel('available')).toBe('Available')
    expect(routeHealthLabel('unreachable')).toBe('Unavailable')
    expect(routeHealthLabel('unauthorized')).toBe('Not authorized')
  })
})
