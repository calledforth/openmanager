/**
 * Connection UI is derived from environment selection, the bootstrap
 * response, and transport status. Timeouts never invent a state on their own.
 */

export const CONNECTION_KINDS = [
  'no_environment',
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
export type ConnectionAction = 'connect' | 'retry' | 'change_environment'

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
  | { status: 'unreachable'; message?: string }

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
}

export type DeriveConnectionInput = {
  environment: EnvironmentSelection
  bootstrap: BootstrapOutcome
  transport: TransportStatus
  /** Omitted means "assume a network"; only an explicit offline reads as offline. */
  network?: NetworkStatus
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

export function deriveConnectionUi(input: DeriveConnectionInput): ConnectionUiState {
  const { named, label, endpoint } = environmentContext(input)

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
  if (deviceOffline || stoppedRetrying) {
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
    }
  }

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
