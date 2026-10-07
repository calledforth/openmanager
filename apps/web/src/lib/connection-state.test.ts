import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_STORIES,
  READY_CONNECTION_INPUT,
  ROUTE_FAILURE_STORIES,
} from '../stories/connection-states'
import {
  bootstrapOutcomeFromQuery,
  connectionStatusLabel,
  deriveConnectionUi,
  type DeriveConnectionInput,
  type RouteFailure,
} from './connection-state'

/** Route failures that need a person, so they never show the reconnect strip. */
const PERSON_NEEDED = new Set(['credential_rejected', 'local_access_blocked'])

/** Kinds that keep the shell mounted instead of replacing it. */
const BANNER_KINDS = new Set(['connecting', 'reconnecting', 'offline', 'unreachable'])

describe('deriveConnectionUi', () => {
  it('maps each story fixture to its named state and surface', () => {
    for (const story of CONNECTION_STORIES) {
      const ui = deriveConnectionUi(story.input)
      // A variant's id is its kind followed by what sets it apart.
      expect(story.id.startsWith(ui.kind), story.id).toBe(true)
      expect(ui.surface, story.id).toBe(BANNER_KINDS.has(ui.kind) ? 'banner' : 'screen')
      expect(ui.title.length, story.id).toBeGreaterThan(0)
      expect(ui.description.length, story.id).toBeGreaterThan(0)
    }
  })

  it('treats a successful bootstrap plus connected transport as ready', () => {
    const ui = deriveConnectionUi(READY_CONNECTION_INPUT)
    expect(ui).toMatchObject({ kind: 'ready', surface: 'none' })
  })

  it('prefers protocol mismatch over a later unreachable transport', () => {
    const ui = deriveConnectionUi({
      environment: {
        status: 'selected',
        endpoint: 'http://127.0.0.1:43120',
        label: 'Local environment',
      },
      bootstrap: {
        status: 'incompatible_protocol',
        clientProtocolVersion: 1,
        serverProtocolVersion: 9,
        label: 'Local environment',
      },
      transport: {
        phase: 'closed',
        hasConnected: true,
        failure: { code: 'unreachable' },
      },
    })
    expect(ui.kind).toBe('incompatible_protocol')
    expect(ui.surface).toBe('screen')
    expect(ui.description).toContain('protocol 1')
    expect(ui.description).toContain('protocol 9')
  })

  it('prefers unauthorized over reconnecting', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120' },
      bootstrap: { status: 'unauthorized', message: 'Origin is not allowed.' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: { code: 'auth' } },
    })
    expect(ui.kind).toBe('unauthorized')
    expect(ui.surface).toBe('screen')
    expect(ui.action).toBe('change_environment')
    expect(ui.description).toContain('Origin is not allowed.')
  })

  it('keeps reconnecting as a banner after a successful connection', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: null },
    })
    expect(ui).toMatchObject({
      kind: 'reconnecting',
      surface: 'banner',
      title: "Can't reach Home",
      description: 'Trying to reconnect…',
      detail: 'The connection to 127.0.0.1:43120 dropped',
      retrying: true,
      action: 'retry',
      secondaryAction: 'change_environment',
    })
  })

  it('names the environment, or falls back to "the environment"', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120' },
      bootstrap: { status: 'unreachable', cause: 'network' },
      transport: { phase: 'closed', hasConnected: false, failure: { code: 'unreachable' } },
    })
    expect(ui).toMatchObject({
      kind: 'unreachable',
      title: "Can't reach the environment",
      detail: 'No answer from 127.0.0.1:43120',
      retrying: true,
    })
  })

  it('says what a bare bootstrap failure was, in its first sentence', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: {
        status: 'unreachable',
        message: 'A different environment answers at this address. Use another route.',
      },
      transport: { phase: 'closed', hasConnected: false, failure: { code: 'unreachable' } },
    })
    expect(ui.detail).toBe('A different environment answers at this address')
  })

  it('shows a first connect working, not failing', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: { phase: 'connecting', hasConnected: false, failure: null },
    })
    expect(ui).toMatchObject({
      kind: 'connecting',
      surface: 'banner',
      title: 'Connecting to Home',
      retrying: true,
    })
    expect(ui.action).toBeUndefined()
  })

  it('reports no network as offline, with no action to take', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: null },
      network: { online: false },
    })
    expect(ui).toMatchObject({ kind: 'offline', surface: 'banner', title: "You're offline" })
    expect(ui.action).toBeUndefined()
    expect(ui.secondaryAction).toBeUndefined()
    expect(ui.retrying).toBeUndefined()
    expect(ui.description).toContain('network is back')
  })

  it('reports exhausted retries as offline, with a manual retry', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: {
        phase: 'closed',
        hasConnected: true,
        failure: null,
        retriesExhausted: true,
      },
      network: { online: true },
    })
    expect(ui).toMatchObject({
      kind: 'offline',
      surface: 'banner',
      title: "Can't reach Home",
      description: 'Stopped retrying.',
      action: 'retry',
      secondaryAction: 'change_environment',
    })
    // Nothing is retrying any more, so nothing spins.
    expect(ui.retrying).toBeUndefined()
  })

  it('separates connecting, reconnecting and offline', () => {
    const environment = { status: 'selected' as const, endpoint: 'http://127.0.0.1:43120' }
    const first = deriveConnectionUi({
      environment,
      bootstrap: { status: 'loading' },
      transport: { phase: 'connecting', hasConnected: false, failure: null },
      network: { online: true },
    })
    const retrying = deriveConnectionUi({
      environment,
      bootstrap: { status: 'loading' },
      transport: { phase: 'connecting', hasConnected: true, failure: null },
      network: { online: true },
    })
    const gone = deriveConnectionUi({
      environment,
      bootstrap: { status: 'loading' },
      transport: { phase: 'connecting', hasConnected: true, failure: null },
      network: { online: false },
    })
    expect([first.kind, retrying.kind, gone.kind]).toEqual([
      'connecting',
      'reconnecting',
      'offline',
    ])
  })

  it('outranks a stale ready bootstrap when offline, but never an auth failure', () => {
    // The bootstrap succeeded before the network went away, so it proves nothing.
    expect(deriveConnectionUi({ ...READY_CONNECTION_INPUT, network: { online: false } }).kind).toBe(
      'offline',
    )
    expect(deriveConnectionUi({ ...READY_CONNECTION_INPUT, network: { online: true } }).kind).toBe(
      'ready',
    )
    expect(
      deriveConnectionUi({
        environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120' },
        bootstrap: { status: 'unauthorized' },
        transport: { phase: 'closed', hasConnected: false, retriesExhausted: true, failure: null },
        network: { online: false },
      }).kind,
    ).toBe('unauthorized')
  })

  it('asks before a new address joins a saved environment, ahead of anything it reports', () => {
    const routeOffer = { endpoint: 'https://tunnel.example', label: 'Home lab' }
    const environment = { status: 'selected' as const, endpoint: routeOffer.endpoint }
    const ui = deriveConnectionUi({
      environment,
      bootstrap: {
        status: 'ready',
        environmentId: 'env-local',
        label: 'Renamed',
        protocolVersion: 1,
      },
      transport: { phase: 'connected', hasConnected: true, failure: null },
      routeOffer,
    })
    expect(ui).toMatchObject({
      kind: 'confirm_route',
      surface: 'screen',
      title: 'Add a route to Home lab?',
      action: 'confirm_route',
      secondaryAction: 'decline_route',
    })
    expect(ui.description).toContain('https://tunnel.example')
    expect(ui.description).toContain('saved client token')

    for (const input of [
      { network: { online: false } },
      {
        bootstrap: {
          status: 'incompatible_protocol' as const,
          clientProtocolVersion: 1,
          serverProtocolVersion: 2,
        },
      },
    ]) {
      expect(
        deriveConnectionUi({
          environment,
          bootstrap: { status: 'loading' },
          transport: { phase: 'connecting', hasConnected: false, failure: null },
          routeOffer,
          ...input,
        }).kind,
      ).toBe('confirm_route')
    }
  })

  it('keeps a cached bootstrap while a later fetch is in flight', () => {
    const ready = {
      status: 'ready' as const,
      environmentId: 'env-local',
      label: 'Local environment',
      protocolVersion: PROTOCOL_VERSION,
    }
    expect(bootstrapOutcomeFromQuery(false, ready)).toEqual({ status: 'idle' })
    expect(bootstrapOutcomeFromQuery(true, undefined)).toEqual({ status: 'loading' })
    expect(bootstrapOutcomeFromQuery(true, ready)).toEqual(ready)
  })

  describe('route failures', () => {
    const failed = (failure: Partial<RouteFailure>, extra: Partial<DeriveConnectionInput> = {}) =>
      deriveConnectionUi({
        ...READY_CONNECTION_INPUT,
        routeFailure: {
          reason: 'route_down',
          endpoint: 'https://studio.example.com',
          local: false,
          tried: 1,
          ...failure,
        },
        ...extra,
      })

    it('shows every reason that waiting resolves as the same reconnect state', () => {
      const details = new Set<string>()
      const waiting = ROUTE_FAILURE_STORIES.filter((story) => !PERSON_NEEDED.has(story.id))
      for (const story of waiting) {
        const ui = deriveConnectionUi(story.input)
        expect(ui, story.id).toMatchObject({
          surface: 'banner',
          title: "Can't reach Rajku's laptop",
          description: 'Trying to reconnect…',
          retrying: true,
          action: 'retry',
          secondaryAction: 'change_environment',
        })
        // The reason itself is kept for debugging. A variant's id is its
        // reason followed by what sets it apart.
        if (story.id !== 'route_search') {
          expect(story.id.startsWith(ui.reason!), story.id).toBe(true)
        }
        details.add(ui.detail!)
      }
      // Each cause still says something different on its one line.
      expect(details.size).toBe(waiting.length)
    })

    it('places every reason explicitly, so a new one cannot slip into the strip', () => {
      expect(() => failed({ reason: 'not_a_reason' as unknown as RouteFailure['reason'] })).toThrow(
        /not placed/,
      )
    })

    it('keeps the cause as a short detail line', () => {
      expect(failed({ reason: 'route_down' }).detail).toBe('No answer from studio.example.com')
      expect(failed({ reason: 'tunnel_down' }).detail).toBe(
        'studio.example.com answered, but nothing is connected behind it',
      )
      expect(failed({ reason: 'environment_offline', stopped: true })).toMatchObject({
        detail: 'Local environment shut down',
        reason: 'environment_offline',
        shutDown: true,
      })
      expect(
        failed({ reason: 'environment_offline', endpoint: 'http://127.0.0.1:43120', local: true })
          .detail,
      ).toBe('Nothing is listening at 127.0.0.1:43120 on this device')
      expect(failed({ reason: 'environment_offline' }).detail).toBe(
        'studio.example.com answered, but the environment behind it is stopped',
      )
      expect(
        failed({ reason: 'route_refused', endpoint: 'http://127.0.0.1:43120', local: true }).detail,
      ).toBe("127.0.0.1:43120 refused this page's address")
      expect(failed({ reason: 'route_refused', message: 'Forbidden.' }).detail).toBe(
        'studio.example.com refused this browser (forbidden)',
      )
      expect(failed({ reason: 'wrong_environment' }).detail).toBe(
        'A different environment answers at studio.example.com',
      )
    })

    it('keeps a browser that blocked this device its own strip, with the fix', () => {
      const blocked = failed({
        reason: 'local_access_blocked',
        endpoint: 'http://127.0.0.1:43120',
        local: true,
      })
      expect(blocked).toMatchObject({
        kind: 'unreachable',
        surface: 'banner',
        title: 'Local access blocked',
        detail: 'This browser blocked the page from reaching 127.0.0.1:43120',
        action: 'retry',
        secondaryAction: 'change_environment',
      })
      expect(blocked.description).toContain("browser's site settings")
      // Waiting does not fix a browser setting, so nothing spins.
      expect(blocked.retrying).toBeUndefined()
    })

    it('keeps a refused token its own screen', () => {
      const rejected = failed({ reason: 'credential_rejected', message: 'Token revoked.' })
      expect(rejected).toMatchObject({
        kind: 'unauthorized',
        surface: 'screen',
        title: 'Not authorized',
        action: 'change_environment',
      })
      expect(rejected.retrying).toBeUndefined()
      expect(rejected.description).toContain('another route will not help')
      expect(rejected.description).toContain('(token revoked)')
    })

    it('says when the other routes failed too', () => {
      const ui = failed({ tried: 2 })
      expect(ui.detail).toBe('No answer from studio.example.com (2 routes tried)')
      expect(ui.routesTried).toBe(2)
      expect(failed({ tried: 1 }).detail).not.toContain('routes tried')
    })

    it('outranks a stale ready bootstrap, and is outranked by no network', () => {
      expect(failed({}).kind).toBe('unreachable')
      expect(failed({}, { network: { online: false } }).kind).toBe('offline')
      // A refused token still needs a person with no network.
      expect(failed({ reason: 'credential_rejected' }, { network: { online: false } }).kind).toBe(
        'unauthorized',
      )
    })

    it('shows a search for another route as reconnecting', () => {
      const ui = deriveConnectionUi({
        ...READY_CONNECTION_INPUT,
        bootstrap: { status: 'unauthorized' },
        transport: { phase: 'closed', hasConnected: true, failure: null },
        routeSearch: { from: 'http://127.0.0.1:43120' },
      })
      expect(ui).toMatchObject({
        kind: 'reconnecting',
        surface: 'banner',
        title: "Can't reach Local environment",
        description: 'Trying to reconnect…',
        detail: 'No answer from 127.0.0.1:43120; trying the other saved routes',
      })
    })
  })

  it('names the state in one line for the chip and settings', () => {
    expect(connectionStatusLabel(deriveConnectionUi(READY_CONNECTION_INPUT))).toBe(
      'Connected · Local environment',
    )
    expect(
      connectionStatusLabel(
        deriveConnectionUi({ ...READY_CONNECTION_INPUT, routeSearch: { from: 'http://x:1' } }),
      ),
    ).toBe("Can't reach Local environment")
    expect(
      connectionStatusLabel(
        deriveConnectionUi({
          ...READY_CONNECTION_INPUT,
          bootstrap: { status: 'unauthorized' },
          transport: { phase: 'closed', hasConnected: true, failure: { code: 'auth' } },
        }),
      ),
    ).toBe('Not authorized · Local environment')
  })

  it('does not invent a failure from idle transport without an environment', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'none' },
      bootstrap: { status: 'unreachable' },
      transport: { phase: 'closed', hasConnected: false, failure: { code: 'unreachable' } },
    })
    expect(ui.kind).toBe('no_environment')
  })
})
