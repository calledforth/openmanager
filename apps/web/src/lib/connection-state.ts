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
       * `network`: nothing answered. `opaque`: something answered, but
       * without the CORS headers that would let this page read it: a
       * gateway's own error page, or the environment refusing this page's
       * origin. `opaque_redirect`: what answered sent this page elsewhere
       * without letting it read where, as a sign-in gate does. `http`:
       * something answered with an error status, often a gateway in front of
       * the environment. `invalid`: what answered is not an environment.
       * `blocked`: the browser refused to let this page reach its own
       * loopback address (a denied local network access permission). Absent
       * on outcomes built elsewhere.
       */
      cause?: 'network' | 'opaque' | 'opaque_redirect' | 'http' | 'invalid' | 'blocked'
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
  /**
   * The headline. Every failure that waiting resolves reads the same,
   * "Can't reach <environment>"; the cause goes in `detail`.
   */
  title: string
  /** For a banner, the short status beside the title; for a screen, the body. */
  description: string
  /**
   * The specific cause, short, for whoever is debugging: "No answer from
   * studio.example.com". Only on banners, which show it as one muted line.
   */
  detail?: string
  /** The client is retrying on its own, so the banner shows it working. */
  retrying?: boolean
  action?: ConnectionAction
  secondaryAction?: ConnectionAction
  environmentLabel?: string
  endpoint?: string
  clientProtocolVersion?: number
  serverProtocolVersion?: number
  /** Why the environment cannot be reached, when a route failure is the cause. */
  reason?: RouteFailureReason
  /** How many saved routes were tried, when a route failure is the cause. */
  routesTried?: number
  /** The environment said it was shutting down, and no route has answered since. */
  shutDown?: boolean
}

/**
 * Why no saved route reaches the environment, in terms a person can act on.
 *
 * - `route_down`: nothing answers at the address at all. This device's
 *   network, or the way to the address, is down.
 * - `tunnel_down`: a gateway answers at the address but the environment does
 *   not answer through it. Over a Cloudflare tunnel this is the tunnel being
 *   down (`530`), or, since a browser cannot read the gateway's status, the
 *   server behind a working tunnel being stopped.
 * - `environment_offline`: the environment server is not running. Nothing
 *   listens on this device's loopback address, a gateway said so in a status
 *   this page can read, or the environment said it was shutting down.
 * - `local_access_blocked`: the browser refused to let this page reach this
 *   device's loopback address. The environment may well be running.
 * - `route_refused`: `/bootstrap`, which takes no token, was refused: a
 *   tunnel's access gate, a proxy, or the environment's origin check.
 * - `credential_rejected`: the environment itself refused this client's token.
 *   Every route carries the same token, so no other route is tried.
 * - `wrong_environment`: a different environment answers at the address.
 */
export const ROUTE_FAILURE_REASONS = [
  'route_down',
  'tunnel_down',
  'environment_offline',
  'local_access_blocked',
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
  /**
   * The environment said it was shutting down, and no route has answered
   * since. Only with `environment_offline`.
   */
  stopped?: boolean
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
  change_environment: 'Switch environment',
  confirm_route: 'Add route',
  decline_route: 'Cancel',
}

export function connectionActionLabel(action: ConnectionAction): string {
  return ACTION_LABELS[action]
}

/**
 * The one line that names the connection's state, for the sidebar chip and
 * settings: a banner's title, which already names the environment, or a
 * screen's title followed by it.
 */
export function connectionStatusLabel(state: ConnectionUiState): string {
  if (state.kind === 'ready') {
    return state.environmentLabel ? `Connected · ${state.environmentLabel}` : 'Connected'
  }
  if (state.surface === 'banner' || !state.environmentLabel) return state.title
  return `${state.title} · ${state.environmentLabel}`
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

/** Who the banner says cannot be reached. */
function whom(label: string | undefined): string {
  return label ?? 'the environment'
}

const TRYING = 'Trying to reconnect…'

/**
 * The one state for every failure that waiting resolves: the environment is
 * named, the client is retrying, and the cause is a single short line.
 */
function reconnectUi(
  { label, endpoint }: Context,
  detail: string,
  extra: Partial<ConnectionUiState> = {},
): ConnectionUiState {
  return {
    kind: 'unreachable',
    surface: 'banner',
    title: `Can't reach ${whom(label)}`,
    description: TRYING,
    detail,
    retrying: true,
    action: 'retry',
    secondaryAction: 'change_environment',
    environmentLabel: label,
    endpoint,
    ...extra,
  }
}

/** How many routes were asked, when it was more than the one named. */
function triedNote(tried: number): string {
  return tried > 1 ? ` (${tried} routes tried)` : ''
}

/**
 * Every reason is placed here on purpose: either it waits it out in the
 * reconnect banner, or it needs a person and gets its own state. A new
 * reason does not compile until it is placed.
 */
function routeFailureUi(failure: RouteFailure, context: Context): ConnectionUiState {
  const { named, label } = context
  const host = hostOf(failure.endpoint)
  const tried = triedNote(failure.tried)
  const said = aside(failure.message)
  const reconnect = (detail: string) =>
    reconnectUi({ ...context, endpoint: failure.endpoint }, detail, {
      reason: failure.reason,
      routesTried: failure.tried,
      shutDown: failure.stopped === true ? true : undefined,
    })
  const reason = failure.reason
  switch (reason) {
    case 'credential_rejected':
      return {
        kind: 'unauthorized',
        surface: 'screen',
        title: 'Not authorized',
        description: `${named} rejected this client's token${said ? ` (${said})` : ''}. Every route sends the same token, so another route will not help. Connect again with a valid token, or pair this device again.`,
        action: 'change_environment',
        environmentLabel: label,
        endpoint: failure.endpoint,
        reason,
        routesTried: failure.tried,
      }
    case 'local_access_blocked':
      // Retrying never helps until the person changes a browser setting, so
      // this is its own strip, with the fix and without a spinner.
      return {
        kind: 'unreachable',
        surface: 'banner',
        title: 'Local access blocked',
        description:
          "Allow this site to reach apps on this device in the browser's site settings, then retry.",
        detail: `This browser blocked the page from reaching ${host}${tried}`,
        action: 'retry',
        secondaryAction: 'change_environment',
        environmentLabel: label,
        endpoint: failure.endpoint,
        reason,
        routesTried: failure.tried,
      }
    case 'route_down':
      return reconnect(`No answer from ${host}${tried}`)
    case 'tunnel_down':
      return reconnect(`${host} answered, but nothing is connected behind it${tried}`)
    case 'environment_offline':
      return reconnect(
        failure.stopped
          ? `${label ?? 'The environment'} shut down`
          : failure.local
            ? `Nothing answers at ${host} on this device`
            : `${host} answered, but the environment behind it is stopped${tried}`,
      )
    case 'route_refused':
      return reconnect(
        failure.local
          ? `${host} refused this page's address${said ? ` (${said})` : ''}`
          : `${host} refused this browser${said ? ` (${said})` : ''}${tried}`,
      )
    case 'wrong_environment':
      return reconnect(`A different environment answers at ${host}${tried}`)
    default: {
      const unplaced: never = reason
      throw new Error(`Route failure reason not placed: ${String(unplaced)}`)
    }
  }
}

/** The cause of an unreachable bootstrap, when no route failure says more. */
function bootstrapDetail(bootstrap: BootstrapOutcome, host: string, message?: string): string {
  if (bootstrap.status === 'unreachable') {
    switch (bootstrap.cause) {
      case 'network':
        return `No answer from ${host}`
      case 'opaque':
        return `${host} answered, but this page cannot read the answer`
      case 'opaque_redirect':
        return `${host} redirected this page, as a sign-in gate does`
      case 'http':
        return bootstrap.httpStatus
          ? `${host} answered HTTP ${bootstrap.httpStatus}`
          : `${host} answered with an error`
      case 'invalid':
        return `${host} answered, but not as an environment`
      case 'blocked':
        return `This browser blocked the page from reaching ${host}`
      case undefined:
        break
    }
  }
  // The first sentence of what was said is the cause; the rest is advice.
  const said = message
    ?.trim()
    .split(/(?<=\.)\s/)[0]
    ?.replace(/\.$/, '')
  return said || `No answer from ${host}`
}

function offlineUi(input: DeriveConnectionInput, { label, endpoint }: Context) {
  if (input.network?.online === false) {
    return {
      kind: 'offline',
      surface: 'banner',
      title: "You're offline",
      description: 'Reconnects when the network is back.',
      environmentLabel: label,
      endpoint,
    } satisfies ConnectionUiState
  }
  // The client gave up on its own (only with a capped retry policy), so a
  // person has to ask again.
  return {
    kind: 'offline',
    surface: 'banner',
    title: `Can't reach ${whom(label)}`,
    description: 'Stopped retrying.',
    action: 'retry',
    secondaryAction: 'change_environment',
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
      const from = input.routeSearch.from
      return reconnectUi(
        { ...context, endpoint: from },
        `No answer from ${hostOf(from)}; trying the other saved routes`,
        { kind: input.transport.hasConnected ? 'reconnecting' : 'connecting' },
      )
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

  const host = endpoint ? hostOf(endpoint) : 'the environment'

  if (
    input.transport.hasConnected &&
    (input.transport.phase === 'reconnecting' || input.transport.phase === 'connecting')
  ) {
    return reconnectUi(context, `The connection to ${host} dropped`, { kind: 'reconnecting' })
  }

  const unreachable =
    input.bootstrap.status === 'unreachable' ||
    input.transport.failure?.code === 'unreachable' ||
    (input.transport.phase === 'closed' && input.transport.hasConnected)
  if (unreachable) {
    const message =
      (input.bootstrap.status === 'unreachable' ? input.bootstrap.message : undefined) ??
      input.transport.failure?.message
    return reconnectUi(context, bootstrapDetail(input.bootstrap, host, message))
  }

  // The first attempt: nothing has failed yet, so nothing is "unreachable".
  return {
    kind: 'connecting',
    surface: 'banner',
    title: `Connecting to ${whom(label)}`,
    description: 'Waiting for an answer…',
    retrying: true,
    environmentLabel: label,
    endpoint,
  }
}
