/**
 * Connection UI is derived from environment selection, the bootstrap
 * response, and transport status. Timeouts never invent a state on their own.
 */

export const CONNECTION_KINDS = [
  'no_environment',
  'connecting',
  'reconnecting',
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
}

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
      description: `The connection to ${named} dropped. Retrying from the last connection status. Your session stays here.`,
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
