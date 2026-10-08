import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { BootstrapOutcome } from './connection-state'
import type { StoredEnvironment } from './environment-store'
import { routeFailureReason, searchRoutes, summarizeRouteFailures } from './route-fallback'

const LOCAL = 'http://127.0.0.1:43120'
const TUNNEL = 'https://tunnel.example'
const LAN = 'http://box.lan:43120'

const ready = (environmentId = 'env-a'): BootstrapOutcome => ({
  status: 'ready',
  environmentId,
  protocolVersion: PROTOCOL_VERSION,
})
const nothing: BootstrapOutcome = { status: 'unreachable', message: 'Down.', cause: 'network' }

function environment(endpoints: string[]): StoredEnvironment {
  return {
    environmentId: 'env-a',
    label: 'Studio',
    credential: 'token',
    routes: endpoints.map((endpoint, priority) => ({
      type: endpoint === LOCAL ? 'local' : 'remote',
      endpoint,
      priority,
      health: { status: 'unknown' },
    })),
  }
}

describe('routeFailureReason', () => {
  it('finds nothing wrong with a route that reached its environment', () => {
    expect(routeFailureReason(ready(), 'env-a', TUNNEL)).toBeNull()
    expect(
      routeFailureReason(
        { status: 'incompatible_protocol', clientProtocolVersion: 1, serverProtocolVersion: 2 },
        'env-a',
        TUNNEL,
      ),
    ).toBeNull()
  })

  it('reads silence on this device as the environment being stopped', () => {
    expect(routeFailureReason(nothing, 'env-a', LOCAL)).toBe('environment_offline')
  })

  it('reads silence over a network as the route being down', () => {
    expect(routeFailureReason(nothing, 'env-a', TUNNEL)).toBe('route_down')
  })

  it('reads a gateway error as the environment behind a working tunnel being stopped', () => {
    for (const httpStatus of [502, 503, 504]) {
      expect(
        routeFailureReason({ status: 'unreachable', cause: 'http', httpStatus }, 'env-a', TUNNEL),
      ).toBe('environment_offline')
    }
    // Cloudflare's own "tunnel not connected" status is the tunnel's failure.
    expect(
      routeFailureReason(
        { status: 'unreachable', cause: 'http', httpStatus: 530 },
        'env-a',
        TUNNEL,
      ),
    ).toBe('tunnel_down')
    expect(routeFailureReason({ status: 'unreachable', cause: 'invalid' }, 'env-a', TUNNEL)).toBe(
      'route_down',
    )
  })

  it('reads a browser that blocked this device as that, not as the environment being stopped', () => {
    expect(routeFailureReason({ status: 'unreachable', cause: 'blocked' }, 'env-a', LOCAL)).toBe(
      'local_access_blocked',
    )
  })

  it('reads an answer the page may not read as a tunnel down, or on this device a refusal', () => {
    // What a browser gets for Cloudflare's 530 and 502 alike: their error
    // pages carry no CORS headers, so only an opaque answer is seen.
    const opaque: BootstrapOutcome = { status: 'unreachable', cause: 'opaque' }
    expect(routeFailureReason(opaque, 'env-a', TUNNEL)).toBe('tunnel_down')
    // Nothing stands in front of a loopback address: the server answering
    // is refusing this page's origin.
    expect(routeFailureReason(opaque, 'env-a', LOCAL)).toBe('route_refused')
    // A sign-in gate sends the page elsewhere instead of answering.
    const gate: BootstrapOutcome = { status: 'unreachable', cause: 'opaque_redirect' }
    expect(routeFailureReason(gate, 'env-a', TUNNEL)).toBe('route_refused')
  })

  it('keeps a refusal and another environment apart from a route that is down', () => {
    expect(routeFailureReason({ status: 'unauthorized' }, 'env-a', TUNNEL)).toBe('route_refused')
    expect(routeFailureReason(ready('env-b'), 'env-a', TUNNEL)).toBe('wrong_environment')
  })
})

describe('summarizeRouteFailures', () => {
  it('shows the failure that explains the others', () => {
    const failure = summarizeRouteFailures([
      { endpoint: LOCAL, outcome: nothing, reason: 'environment_offline', known: false },
      { endpoint: TUNNEL, outcome: nothing, reason: 'route_down', known: false },
    ])
    // The client's own words for an unreachable route are not repeated.
    expect(failure).toEqual({
      reason: 'environment_offline',
      endpoint: LOCAL,
      local: true,
      tried: 2,
    })
  })

  it('names a blocked local route when the tunnel is down too', () => {
    const blocked = { status: 'unreachable', cause: 'blocked', message: 'Blocked.' } as const
    expect(
      summarizeRouteFailures([
        { endpoint: LOCAL, outcome: blocked, reason: 'local_access_blocked', known: false },
        { endpoint: TUNNEL, outcome: nothing, reason: 'route_down', known: false },
      ]),
    ).toMatchObject({ reason: 'local_access_blocked', endpoint: LOCAL, local: true })
    // A gateway saying the environment is down still explains everything.
    expect(
      summarizeRouteFailures([
        { endpoint: LOCAL, outcome: blocked, reason: 'local_access_blocked', known: false },
        {
          endpoint: TUNNEL,
          outcome: { status: 'unreachable', cause: 'http', httpStatus: 502 },
          reason: 'environment_offline',
          known: false,
        },
      ]),
    ).toMatchObject({ reason: 'environment_offline', endpoint: TUNNEL })
  })

  it('prefers a gateway answering over silence', () => {
    expect(
      summarizeRouteFailures([
        { endpoint: LAN, outcome: nothing, reason: 'route_down', known: false },
        {
          endpoint: TUNNEL,
          outcome: { status: 'unreachable', cause: 'opaque' },
          reason: 'tunnel_down',
          known: false,
        },
      ]),
    ).toMatchObject({ reason: 'tunnel_down', endpoint: TUNNEL, tried: 2 })
  })

  it('prefers a refusal a person can act on over a route that is down', () => {
    expect(
      summarizeRouteFailures([
        { endpoint: TUNNEL, outcome: nothing, reason: 'route_down', known: false },
        {
          endpoint: LAN,
          outcome: { status: 'unauthorized', message: 'Sign in.' },
          reason: 'route_refused',
          known: false,
        },
      ]),
    ).toMatchObject({ reason: 'route_refused', endpoint: LAN, local: false, message: 'Sign in.' })
  })

  it('says an address leads to another environment over a route that is down', () => {
    expect(
      summarizeRouteFailures([
        { endpoint: LOCAL, outcome: ready('env-b'), reason: 'wrong_environment', known: false },
        { endpoint: TUNNEL, outcome: nothing, reason: 'route_down', known: false },
      ]),
    ).toMatchObject({ reason: 'wrong_environment', endpoint: LOCAL, tried: 2 })
  })

  it('has nothing to say when a route answered', () => {
    expect(
      summarizeRouteFailures([{ endpoint: LOCAL, outcome: ready(), reason: null, known: false }]),
    ).toBeNull()
  })
})

describe('searchRoutes', () => {
  it('tries the local route first, even when it is not the first choice', async () => {
    const probe = vi.fn(async (endpoint: string) => (endpoint === LOCAL ? ready() : nothing))
    const result = await searchRoutes(environment([TUNNEL, LOCAL]), { probe })
    expect(result.found).toBe(LOCAL)
  })

  it('waits for a route ahead in order before choosing one behind it', async () => {
    let answerLocal = (_outcome: BootstrapOutcome): void => undefined
    const probe = vi.fn((endpoint: string) =>
      endpoint === LOCAL
        ? new Promise<BootstrapOutcome>((resolve) => {
            answerLocal = resolve
          })
        : Promise.resolve(ready()),
    )
    const search = searchRoutes(environment([LOCAL, TUNNEL]), { probe })
    // Both are asked at once; the tunnel answering first does not win.
    expect(probe.mock.calls.map(([endpoint]) => endpoint)).toEqual([LOCAL, TUNNEL])
    answerLocal(ready())
    await expect(search).resolves.toMatchObject({ found: LOCAL })
  })

  it('does not ask again for an answer it was handed, and moves on to the next route', async () => {
    const probe = vi.fn(async (_endpoint: string) => ready())
    const result = await searchRoutes(environment([LOCAL, TUNNEL, LAN]), {
      known: { endpoint: LOCAL, outcome: nothing },
      probe,
    })
    expect(result.found).toBe(TUNNEL)
    expect(probe.mock.calls.map(([endpoint]) => endpoint)).toEqual([TUNNEL, LAN])
    expect(result.probes.map((item) => [item.endpoint, item.known])).toEqual([
      [LOCAL, true],
      [TUNNEL, false],
    ])
  })

  it('asks a route that may only have blinked on its own first', async () => {
    const probe = vi.fn(async (_endpoint: string) => ready())
    const result = await searchRoutes(environment([LOCAL, TUNNEL]), { first: TUNNEL, probe })
    expect(result.found).toBe(TUNNEL)
    expect(probe.mock.calls.map(([endpoint]) => endpoint)).toEqual([TUNNEL])
  })

  it('asks the rest when that route has failed', async () => {
    const probe = vi.fn(async (endpoint: string) => (endpoint === TUNNEL ? nothing : ready()))
    const result = await searchRoutes(environment([TUNNEL, LAN]), { first: TUNNEL, probe })
    expect(result.found).toBe(LAN)
    expect(probe.mock.calls.map(([endpoint]) => endpoint)).toEqual([TUNNEL, LAN])
  })

  it('reports why when no route reaches the environment', async () => {
    const probe = vi.fn(async (endpoint: string) =>
      endpoint === LOCAL
        ? nothing
        : ({ status: 'unreachable', cause: 'http', httpStatus: 502 } as const),
    )
    const result = await searchRoutes(environment([TUNNEL, LOCAL]), { probe })
    expect(result).toMatchObject({
      found: null,
      failure: { reason: 'environment_offline', endpoint: LOCAL, tried: 2 },
    })
  })
})
