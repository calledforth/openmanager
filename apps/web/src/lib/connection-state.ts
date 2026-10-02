/**
 * Connection UI is derived from environment selection, the bootstrap
 * response, and transport status. Timeouts never invent a state on their own.
 */

export const CONNECTION_KINDS = [
  'no_environment',
  'confirm_route',
  'connecting',
  'reconnecting',
  'offline',
  'unreachable',
  'incompatible_protocol',
  'unauthorized',
  'ready',
] as const

export type ConnectionKind = (typeof CONNECTION_KINDS)[number]
export type ConnectionSurface = 'screen' | 'banner' | 'none'
export type ConnectionAction =
  | 'connect'
  | 'retry'
  | 'change_environment'
  | 'confirm_route'
  | 'decline_route'

export type EnvironmentSelection =
  | { status: 'none' }
  | {
      status: 'selected'
      endpoint: string
      environmentId?: string
      label?: string
    }

export type BootstrapOutcome =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      environmentId: string
      label?: string
      protocolVersion: number
    }
  | {
      status: 'incompatible_protocol'
      clientProtocolVersion: number
      serverProtocolVersion: number
      environmentId?: string
      label?: string
    }
  | { status: 'unauthorized'; message?: string }
  | {
      status: 'unreachable'
      message?: string
      /**
       * `network`: nothing answered. `http`: something answered with an error
       * status, often a gateway in front of the environment. `invalid`: what
       * answered is not an environment. Absent on outcomes built elsewhere.
       */
      cause?: 'network' | 'http' | 'invalid'
      httpStatus?: number
    }

export type TransportFailureCode = 'auth' | 'protocol_incompatible' | 'unreachable'

export type TransportStatus = {
  phase: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'
  hasConnected: boolean
  failure: { code: TransportFailureCode; message?: string } | null
  /** The client has given up on its own: terminal failure or attempts exhausted. */
  retriesExhausted?: boolean
}

/** What the browser reports about the device's network, not about this app. */
export type NetworkStatus = { online: boolean }

export type ConnectionUiState = {
  kind: ConnectionKind
  surface: ConnectionSurface
  title: string
  description: string
  action?: ConnectionAction
  secondaryAction?: ConnectionAction
  environmentLabel?: string
  endpoint?: string
  clientProtocolVersion?: number
  serverProtocolVersion?: number
  /** Why the environment cannot be reached, when a route failure is the cause. */
  reason?: RouteFailureReason
}

/**
 * Why no saved route reaches the environment, in terms a person can act on.
 *
 * - `route_down`: the route itself does not answer. A tunnel or network path
 *   is down; the environment behind it may well be running.
 * - `environment_offline`: the environment server is not running. Nothing
 *   listens on this device's loopback address, or a gateway answered for an
 *   environment that did not.
 * - `route_refused`: `/bootstrap`, which takes no token, was refused: a
 *   tunnel's access gate, a proxy, or the environment's origin check.
 * - `credential_rejected`: the environment itself refused this client's token.
 *   Every route carries the same token, so no other route is tried.
 * - `wrong_environment`: a different environment answers at the address.
 */
export const ROUTE_FAILURE_REASONS = [
  'route_down',
  'environment_offline',
  'route_refused',
  'credential_rejected',
  'wrong_environment',
] as const
export type RouteFailureReason = (typeof ROUTE_FAILURE_REASONS)[number]

export type RouteFailure = {
  reason: RouteFailureReason
  /** The route the reason was learned on. */
  endpoint: string
  /** The route is this device's loopback address. */
  local: boolean
  /** How many saved routes were tried. */
  tried: number
  /** What the environment said, when it said something. */
  message?: string
}

/** The route in use failed and the environment's other routes are being tried. */
export type RouteSearch = { from: string }

export type DeriveConnectionInput = {
  environment: EnvironmentSelection
  bootstrap: BootstrapOutcome
  transport: TransportStatus
  /** Omitted means "assume a network"; only an explicit offline reads as offline. */
  network?: NetworkStatus
  /** A connect that is waiting for consent before it becomes a route. */
  routeOffer?: RouteOffer
  /** No saved route reaches the selected environment, and why. */
  routeFailure?: RouteFailure
  /** The other saved routes are being tried after the route in use failed. */
  routeSearch?: RouteSearch
}

/**
 * An address that answered as an environment this client already has, but is
 * not yet one of its routes. Using it would send the saved client token there.
 */
export type RouteOffer = {
  endpoint: string
  /** The saved environment's own label, not the one the address answered with. */
  label: string
}

/** Keep a cached bootstrap while a later fetch is in flight. */
export function bootstrapOutcomeFromQuery(
  hasEndpoint: boolean,
  data: BootstrapOutcome | undefined,
): BootstrapOutcome {
  if (!hasEndpoint) return { status: 'idle' }
  if (data === undefined) return { status: 'loading' }
  return data
}

const ACTION_LABELS: Record<ConnectionAction, string> = {
  connect: 'Connect',
  retry: 'Retry',
  change_environment: 'Change environment',
  confirm_route: 'Add route',
  decline_route: 'Cancel',
}

export function connectionActionLabel(action: ConnectionAction): string {
  return ACTION_LABELS[action]
}

function environmentContext(input: DeriveConnectionInput) {
  const endpoint = input.environment.status === 'selected' ? input.environment.endpoint : undefined
  const label =
    (input.bootstrap.status === 'ready' || input.bootstrap.status === 'incompatible_protocol'
      ? input.bootstrap.label
      : undefined) ??
    (input.environment.status === 'selected' ? input.environment.label : undefined)
  return { endpoint, label, named: label ?? endpoint ?? 'this environment' }
}

const RETRYING = 'OpenManager keeps trying every saved route and reconnects on its own.'

/** `host:port` reads better in a sentence than the full URL. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}

type Context = { named: string; label?: string; endpoint?: string }

/**
 * What the environment said, shaped to sit in parentheses mid-sentence:
 * "Client token revoked." becomes "client token revoked". Acronyms and
 * proper nouns that open the message keep their capitals.
 */
function aside(message: string | undefined): string | undefined {
  const trimmed = message?.trim().replace(/\.$/, '')
  if (!trimmed) return undefined
  return /^[A-Z][a-z]/.test(trimmed) ? trimmed[0]!.toLowerCase() + trimmed.slice(1) : trimmed
}

function routeFailureUi(failure: RouteFailure, { named, label }: Context): ConnectionUiState {
  const host = hostOf(failure.endpoint)
  const others = failure.tried > 1 ? ' No other saved route answers either.' : ''
  const base = { environmentLabel: label, endpoint: failure.endpoint, reason: failure.reason }
  switch (failure.reason) {
    case 'credential_rejected': {
      const said = aside(failure.message)
      return {
        ...base,
        kind: 'unauthorized',
        surface: 'screen',
        title: 'Not authorized',
        description: `${named} rejected this client's token${said ? ` (${said})` : ''}. Every route sends the same token, so another route will not help. Connect again with a valid token, or pair this device again.`,
        action: 'change_environment',
      }
    }
    case 'route_refused': {
      const said = aside(failure.message)
      return {
        ...base,
        kind: 'unauthorized',
        surface: 'screen',
        title: 'Route refused access',
        description: `${host} refused this browser${said ? ` (${said})` : ''}, so ${named} cannot be reached through it.${others} If the address sits behind a sign-in, open it in a tab and sign in, then retry. ${RETRYING}`,
        action: 'retry',
        secondaryAction: 'change_environment',
      }
    }
    case 'environment_offline':
      return {
        ...base,
        kind: 'unreachable',
        surface: 'banner',
        title: 'Environment offline',
        description: failure.local
          ? `Nothing is answering at ${host} on this device, so ${named} looks stopped. Start the environment server; if it is already running, check that it allows this page's address. ${RETRYING}`
          : `${host} answers, but ${named} is not running behind it. Start the environment server. ${RETRYING}`,
        action: 'retry',
        secondaryAction: 'change_environment',
      }
    case 'wrong_environment':
      return {
        ...base,
        kind: 'unreachable',
        surface: 'banner',
        title: 'Environment unreachable',
        description: `A different environment now answers at ${host}.${others} Connect to the address again to add what answers there, or add another route to ${named}. ${RETRYING}`,
        action: 'retry',
        secondaryAction: 'change_environment',
      }
    case 'route_down':
      return {
        ...base,
        kind: 'unreachable',
        surface: 'banner',
        title: 'Route unavailable',
        description: `${host} is not answering. The tunnel or network path to ${named} may be down; the environment itself may still be running.${others} ${RETRYING}`,
        action: 'retry',
        secondaryAction: 'change_environment',
      }
  }
}

function offlineUi(input: DeriveConnectionInput, { named, label, endpoint }: Context) {
  const deviceOffline = input.network?.online === false
  return {
    kind: 'offline',
    surface: 'banner',
    title: deviceOffline ? 'No network' : 'Not connected',
    description: deviceOffline
      ? `This device is offline. OpenManager reconnects to ${named} as soon as the network is back. Your session stays here.`
      : `Retries to reach ${named} have stopped. Your session stays here until you retry.`,
    action: deviceOffline ? undefined : 'retry',
    secondaryAction: deviceOffline ? undefined : 'change_environment',
    environmentLabel: label,
    endpoint,
  } satisfies ConnectionUiState
}

export function deriveConnectionUi(input: DeriveConnectionInput): ConnectionUiState {
  const context = environmentContext(input)
  const { named, label, endpoint } = context

  if (input.environment.status === 'none') {
    return {
      kind: 'no_environment',
      surface: 'screen',
      title: 'No environment configured',
      description:
        'OpenManager needs an environment server before it can open sessions. Add an endpoint to continue.',
      action: 'connect',
    }
  }

  // Waiting on a person outranks everything the address itself reports:
  // nothing is sent to it, and nothing is saved, until they answer.
  if (input.routeOffer) {
    const offer = input.routeOffer
    return {
      kind: 'confirm_route',
      surface: 'screen',
      title: `Add a route to ${offer.label}?`,
      description: `${offer.endpoint} claims to be a route to ${offer.label}, an environment you already have. Adding it sends the saved client token to that address, so only add an address you trust.`,
      action: 'confirm_route',
      secondaryAction: 'decline_route',
      endpoint: offer.endpoint,
    }
  }

  const protocolMismatch =
    input.bootstrap.status === 'incompatible_protocol' ||
    input.transport.failure?.code === 'protocol_incompatible'
  if (protocolMismatch) {
    const clientProtocolVersion =
      input.bootstrap.status === 'incompatible_protocol'
        ? input.bootstrap.clientProtocolVersion
        : undefined
    const serverProtocolVersion =
      input.bootstrap.status === 'incompatible_protocol'
        ? input.bootstrap.serverProtocolVersion
        : undefined
    const versions =
      clientProtocolVersion !== undefined && serverProtocolVersion !== undefined
        ? ` This client speaks protocol ${clientProtocolVersion}; ${named} speaks protocol ${serverProtocolVersion}.`
        : ''
    return {
      kind: 'incompatible_protocol',
      surface: 'screen',
      title: 'Incompatible protocol',
      description: `The client and environment cannot talk to each other.${versions} Upgrade one of them, then retry.`,
      action: 'retry',
      secondaryAction: 'change_environment',
      environmentLabel: label,
      endpoint,
      clientProtocolVersion,
      serverProtocolVersion,
    }
  }

  // A route failure is worked out from every saved route, so it says more
  // than the single bootstrap answer read below. A token the environment
  // refused needs a person whatever the network does; the rest wait it out.
  const failure = input.routeFailure
  if (failure?.reason === 'credential_rejected') return routeFailureUi(failure, context)
  if (failure || input.routeSearch) {
    if (input.network?.online === false) return offlineUi(input, context)
    if (input.routeSearch) {
      return {
        kind: input.transport.hasConnected ? 'reconnecting' : 'connecting',
        surface: 'banner',
        title: 'Trying another route',
        description: `${named} cannot be reached through ${hostOf(input.routeSearch.from)}. Trying its other saved routes.`,
        environmentLabel: label,
        endpoint: input.routeSearch.from,
      }
    }
    return routeFailureUi(failure!, context)
  }

  const unauthorized =
    input.bootstrap.status === 'unauthorized' || input.transport.failure?.code === 'auth'
  if (unauthorized) {
    const detail =
      (input.bootstrap.status === 'unauthorized' ? input.bootstrap.message : undefined) ??
      input.transport.failure?.message
    return {
      kind: 'unauthorized',
      surface: 'screen',
      title: 'Not authorized',
      description:
        detail ??
        `${named} rejected this client. Update the credential or choose another environment. Do not keep retrying while access is denied.`,
      action: 'change_environment',
      environmentLabel: label,
      endpoint,
    }
  }

  // "Offline" is the one state where waiting will not help on its own: the
  // device has no network, or the client has stopped retrying. Everything
  // between a drop and that point is `reconnecting`. It outranks a ready
  // bootstrap because that bootstrap was answered before the network went
  // away; the socket behind it cannot still be alive.
  const deviceOffline = input.network?.online === false
  const stoppedRetrying = input.transport.retriesExhausted === true
  if (deviceOffline || stoppedRetrying) return offlineUi(input, context)

  if (input.transport.phase === 'connected' && input.bootstrap.status === 'ready') {
    return {
      kind: 'ready',
      surface: 'none',
      title: 'Connected',
      description: `Connected to ${named}.`,
      environmentLabel: label ?? input.bootstrap.label,
      endpoint,
    }
  }

  if (
    input.transport.hasConnected &&
    (input.transport.phase === 'reconnecting' || input.transport.phase === 'connecting')
  ) {
    return {
      kind: 'reconnecting',
      surface: 'banner',
      title: 'Reconnecting',
      description: `The connection to ${named} dropped. Retrying automatically with a growing delay. Your session stays here.`,
      action: 'retry',
      environmentLabel: label,
      endpoint,
    }
  }

  const unreachable =
    input.bootstrap.status === 'unreachable' ||
    input.transport.failure?.code === 'unreachable' ||
    (input.transport.phase === 'closed' && input.transport.hasConnected)
  if (unreachable) {
    const detail =
      (input.bootstrap.status === 'unreachable' ? input.bootstrap.message : undefined) ??
      input.transport.failure?.message
    return {
      kind: 'unreachable',
      surface: 'banner',
      title: 'Environment unreachable',
      description:
        detail ??
        `Could not reach ${named}. Check that the environment server is running, then retry.`,
      action: 'retry',
      secondaryAction: 'change_environment',
      environmentLabel: label,
      endpoint,
    }
  }

  return {
    kind: 'connecting',
    surface: 'banner',
    title: 'Connecting',
    description: `Reaching ${named} for bootstrap and connection status.`,
    environmentLabel: label,
    endpoint,
  }
}
