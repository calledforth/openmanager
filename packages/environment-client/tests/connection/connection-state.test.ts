import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { describe, expect, it } from 'vitest'
import {
  bootstrapOutcomeFromQuery,
  connectionStatusLabel,
  deriveConnectionUi,
  environmentIsDown,
  otherEnvironmentsNotice,
  placeConnectionUi,
  sendBlockedReason,
  type ConnectionUiState,
  type DeriveConnectionInput,
  type RouteFailure,
} from '../../src/connection/connection-state'

// The web app's story fixtures (apps/web/src/stories/connection-states.ts)
// are checked against deriveConnectionUi next to them, in
// apps/web/src/stories/connection-states.test.ts.
const READY_CONNECTION_INPUT: DeriveConnectionInput = {
  environment: {
    status: 'selected',
    endpoint: 'http://127.0.0.1:43120',
    environmentId: 'env-local',
    label: 'Local environment',
  },
  bootstrap: {
    status: 'ready',
    environmentId: 'env-local',
    label: 'Local environment',
    protocolVersion: PROTOCOL_VERSION,
  },
  transport: { phase: 'connected', hasConnected: true, failure: null },
}

describe('deriveConnectionUi', () => {
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

  it('does not spin for a typed address that nothing will ask again', () => {
    const ui = deriveConnectionUi({
      environment: { status: 'selected', endpoint: 'http://127.0.0.1:43120' },
      bootstrap: { status: 'unreachable', cause: 'network' },
      transport: { phase: 'closed', hasConnected: false, failure: { code: 'unreachable' } },
      autoRetry: false,
    })
    expect(ui).toMatchObject({
      kind: 'unreachable',
      surface: 'banner',
      title: "Can't reach the environment",
      description: 'Not retrying.',
      detail: 'No answer from 127.0.0.1:43120',
      action: 'retry',
      secondaryAction: 'change_environment',
    })
    expect(ui.retrying).toBeUndefined()
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
      ).toBe('Nothing answers at 127.0.0.1:43120 on this device')
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
        detail: '127.0.0.1:43120 did not work; trying the other saved routes',
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

describe('several environments', () => {
  const refused = deriveConnectionUi({
    ...READY_CONNECTION_INPUT,
    bootstrap: { status: 'unauthorized' },
    transport: { phase: 'closed', hasConnected: true, failure: { code: 'auth' } },
  })
  const mismatched = deriveConnectionUi({
    ...READY_CONNECTION_INPUT,
    bootstrap: {
      status: 'incompatible_protocol',
      clientProtocolVersion: 1,
      serverProtocolVersion: 2,
    },
  })
  const down = deriveConnectionUi({
    ...READY_CONNECTION_INPUT,
    routeFailure: { reason: 'route_down', endpoint: 'http://x:1', local: false, tried: 1 },
  })
  const firstTry = deriveConnectionUi({
    ...READY_CONNECTION_INPUT,
    bootstrap: { status: 'loading' },
    transport: { phase: 'connecting', hasConnected: false, failure: null },
  })
  const ready = deriveConnectionUi(READY_CONNECTION_INPUT)
  const of = (label: string, state: ConnectionUiState) => ({ label, state })

  it('reads as down only once something says so', () => {
    expect(environmentIsDown(down)).toBe(true)
    expect(
      environmentIsDown(
        deriveConnectionUi({ ...READY_CONNECTION_INPUT, network: { online: false } }),
      ),
    ).toBe(true)
    expect(environmentIsDown(ready)).toBe(false)
    expect(environmentIsDown(firstTry)).toBe(false)
    // These two aren't down: they have answered, and said no.
    expect(environmentIsDown(refused)).toBe(false)
    expect(environmentIsDown(mismatched)).toBe(false)
  })

  it('holds a send only while the environment is down, and says which', () => {
    expect(sendBlockedReason(down, 'Laptop')).toBe(
      "Can't send until Laptop is back. What you type here is kept.",
    )
    expect(sendBlockedReason(ready, 'Laptop')).toBeNull()
    expect(sendBlockedReason(firstTry, 'Laptop')).toBeNull()
  })

  it('moves what used to take the page to the banner, named, once others are saved', () => {
    expect(placeConnectionUi(refused, 2)).toMatchObject({
      surface: 'banner',
      title: 'Not authorized · Local environment',
    })
    expect(placeConnectionUi(mismatched, 3)).toMatchObject({
      surface: 'banner',
      title: 'Incompatible protocol · Local environment',
    })
  })

  it('leaves a single environment, and everything a person is asked, where it was', () => {
    expect(placeConnectionUi(refused, 1)).toBe(refused)
    expect(placeConnectionUi(down, 2)).toBe(down)
    const none = deriveConnectionUi({ ...READY_CONNECTION_INPUT, environment: { status: 'none' } })
    expect(placeConnectionUi(none, 2)).toBe(none)
    const offer = deriveConnectionUi({
      ...READY_CONNECTION_INPUT,
      routeOffer: { endpoint: 'http://x:1', label: 'Laptop' },
    })
    expect(placeConnectionUi(offer, 2)).toBe(offer)
  })

  it('says nothing about environments that are fine or on their way', () => {
    expect(otherEnvironmentsNotice([])).toBeNull()
    expect(otherEnvironmentsNotice([of('Desk', ready), of('Laptop', firstTry)])).toBeNull()
  })

  it('names every environment in trouble on one line', () => {
    expect(otherEnvironmentsNotice([of('Laptop', down)])).toEqual({
      text: 'Laptop is offline',
      needsPerson: false,
    })
    expect(
      otherEnvironmentsNotice([of('Laptop', down), of('Desk', ready), of('Phone', down)])?.text,
    ).toBe('Laptop and Phone are offline')
    expect(
      otherEnvironmentsNotice([of('Laptop', down), of('Desk', refused), of('Phone', mismatched)]),
    ).toEqual({
      text: 'Laptop is offline · Desk refused this device · Phone needs a matching version',
      needsPerson: true,
    })
    expect(otherEnvironmentsNotice([of('Laptop', mismatched), of('Phone', mismatched)])?.text).toBe(
      'Laptop and Phone need a matching version',
    )
  })
})

describe('one environment saved', () => {
  const only = { ...READY_CONNECTION_INPUT, onlyEnvironment: true }
  const failure = (reason: RouteFailure['reason']): RouteFailure => ({
    reason,
    endpoint: 'http://127.0.0.1:43120',
    local: true,
    tried: 1,
  })
  const refusedInput: DeriveConnectionInput = {
    ...only,
    bootstrap: { status: 'unauthorized' },
    transport: { phase: 'closed', hasConnected: true, failure: { code: 'auth' } },
  }

  it('offers no other environment beside a fix', () => {
    const states = [
      deriveConnectionUi({ ...only, routeFailure: failure('route_down') }),
      deriveConnectionUi({ ...only, routeFailure: failure('local_access_blocked') }),
      deriveConnectionUi({
        ...only,
        bootstrap: { status: 'loading' },
        transport: { phase: 'reconnecting', hasConnected: true, failure: null },
      }),
      deriveConnectionUi({
        ...only,
        bootstrap: { status: 'loading' },
        transport: { phase: 'closed', hasConnected: true, failure: null, retriesExhausted: true },
      }),
      deriveConnectionUi({
        ...only,
        bootstrap: {
          status: 'incompatible_protocol',
          clientProtocolVersion: 1,
          serverProtocolVersion: 2,
        },
      }),
    ]
    for (const state of states) {
      expect(state.action, state.kind).toBe('retry')
      expect(state.secondaryAction, state.kind).toBeUndefined()
    }
  })

  it('asks to connect again after a refused token, without naming another environment', () => {
    const refused = deriveConnectionUi(refusedInput)
    expect(refused).toMatchObject({
      kind: 'unauthorized',
      surface: 'screen',
      action: 'connect_again',
      description:
        'Local environment rejected this client. Update the credential. Do not keep retrying while access is denied.',
    })
    expect(refused.secondaryAction).toBeUndefined()
    expect(
      deriveConnectionUi({ ...only, routeFailure: failure('credential_rejected') }).action,
    ).toBe('connect_again')
  })

  it('reads as before when others may be saved', () => {
    expect(deriveConnectionUi({ ...refusedInput, onlyEnvironment: undefined })).toMatchObject({
      action: 'change_environment',
      description: expect.stringContaining('or choose another environment'),
    })
    expect(
      deriveConnectionUi({ ...READY_CONNECTION_INPUT, routeFailure: failure('route_down') })
        .secondaryAction,
    ).toBe('change_environment')
  })
})
