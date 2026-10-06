import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_STORIES,
  READY_CONNECTION_INPUT,
  ROUTE_FAILURE_STORIES,
} from '../stories/connection-states'
import {
  bootstrapOutcomeFromQuery,
  deriveConnectionUi,
  type DeriveConnectionInput,
  type RouteFailure,
} from './connection-state'

/** Kinds that keep the shell mounted instead of replacing it. */
const BANNER_KINDS = new Set(['connecting', 'reconnecting', 'offline', 'unreachable'])

describe('deriveConnectionUi', () => {
  it('maps each story fixture to its named state and surface', () => {
    for (const story of CONNECTION_STORIES) {
      const ui = deriveConnectionUi(story.input)
      expect(ui.kind, story.id).toBe(story.id)
      expect(ui.surface, story.id).toBe(BANNER_KINDS.has(story.id) ? 'banner' : 'screen')
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
    expect(ui).toMatchObject({ kind: 'reconnecting', surface: 'banner', action: 'retry' })
    expect(ui.description).toContain('session stays here')
  })

  it('reports no network as offline, with no action to take', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120', label: 'Home' },
      bootstrap: { status: 'loading' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: null },
      network: { online: false },
    })
    expect(ui).toMatchObject({ kind: 'offline', surface: 'banner', title: 'No network' })
    expect(ui.action).toBeUndefined()
    expect(ui.secondaryAction).toBeUndefined()
    expect(ui.description).toContain('reconnects')
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
      title: 'Not connected',
      action: 'retry',
      secondaryAction: 'change_environment',
    })
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

    it('gives every reason its own wording and the reason itself', () => {
      const titles = new Set<string>()
      const descriptions = new Set<string>()
      for (const story of ROUTE_FAILURE_STORIES) {
        const ui = deriveConnectionUi(story.input)
        if (story.id !== 'route_search') expect(ui.reason, story.id).toBe(story.id)
        titles.add(ui.title)
        descriptions.add(ui.description)
      }
      expect(descriptions.size).toBe(ROUTE_FAILURE_STORIES.length)
      expect(titles.size).toBeGreaterThanOrEqual(5)
    })

    it('tells a tunnel that is down from an environment that is stopped', () => {
      const down = failed({ reason: 'route_down' })
      expect(down).toMatchObject({
        kind: 'unreachable',
        surface: 'banner',
        title: 'Route unavailable',
      })
      expect(down.description).toContain('studio.example.com is not answering')
      expect(down.description).toContain('may still be running')

      const stoppedHere = failed({
        reason: 'environment_offline',
        endpoint: 'http://127.0.0.1:43120',
        local: true,
      })
      expect(stoppedHere).toMatchObject({ kind: 'unreachable', title: 'Environment offline' })
      expect(stoppedHere.description).toContain('127.0.0.1:43120 on this device')

      const stoppedBehindTunnel = failed({ reason: 'environment_offline' })
      expect(stoppedBehindTunnel.description).toContain('studio.example.com answers')
    })

    it('tells a browser that blocked this device from an environment that is stopped', () => {
      const blocked = failed({
        reason: 'local_access_blocked',
        endpoint: 'http://127.0.0.1:43120',
        local: true,
      })
      expect(blocked).toMatchObject({
        kind: 'unreachable',
        surface: 'banner',
        title: 'Local access blocked',
        action: 'retry',
      })
      expect(blocked.description).toContain('blocked the page from reaching 127.0.0.1:43120')
      expect(blocked.description).toContain("browser's site settings")
    })

    it('tells a refused route from a refused token', () => {
      const refused = failed({ reason: 'route_refused', message: 'Forbidden.' })
      expect(refused).toMatchObject({
        kind: 'unauthorized',
        title: 'Route refused access',
        action: 'retry',
      })
      expect(refused.description).toContain('(forbidden)')

      const rejected = failed({ reason: 'credential_rejected', message: 'Token revoked.' })
      expect(rejected).toMatchObject({
        kind: 'unauthorized',
        title: 'Not authorized',
        action: 'change_environment',
      })
      expect(rejected.description).toContain('another route will not help')
      expect(rejected.description).toContain('(token revoked)')
    })

    it('says when the other routes failed too', () => {
      expect(failed({ tried: 2 }).description).toContain('No other saved route answers either.')
      expect(failed({ tried: 1 }).description).not.toContain('No other saved route')
    })

    it('outranks a stale ready bootstrap, and is outranked by no network', () => {
      expect(failed({}).kind).toBe('unreachable')
      expect(failed({}, { network: { online: false } }).kind).toBe('offline')
      // A refused token still needs a person with no network.
      expect(failed({ reason: 'credential_rejected' }, { network: { online: false } }).kind).toBe(
        'unauthorized',
      )
    })

    it('shows a search for another route as a connection in progress', () => {
      const ui = deriveConnectionUi({
        ...READY_CONNECTION_INPUT,
        bootstrap: { status: 'unauthorized' },
        transport: { phase: 'closed', hasConnected: true, failure: null },
        routeSearch: { from: 'http://127.0.0.1:43120' },
      })
      expect(ui).toMatchObject({
        kind: 'reconnecting',
        surface: 'banner',
        title: 'Trying another route',
      })
    })
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
