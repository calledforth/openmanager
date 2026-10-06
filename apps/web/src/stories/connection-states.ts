import { PROTOCOL_VERSION } from '@openmanager/protocol'
import type {
  ConnectionKind,
  DeriveConnectionInput,
  RouteFailureReason,
} from '../lib/connection-state'

export type ConnectionStory = {
  id: Exclude<ConnectionKind, 'ready'>
  name: string
  summary: string
  input: DeriveConnectionInput
}

const selected = {
  status: 'selected' as const,
  endpoint: 'http://127.0.0.1:43120',
  environmentId: 'env-local',
  label: 'Local environment',
}

export const CONNECTION_STORIES: ConnectionStory[] = [
  {
    id: 'no_environment',
    name: 'No environment',
    summary: 'First run. Nothing is stored yet.',
    input: {
      environment: { status: 'none' },
      bootstrap: { status: 'idle' },
      transport: { phase: 'idle', hasConnected: false, failure: null },
    },
  },
  {
    id: 'confirm_route',
    name: 'Confirm a new route',
    summary:
      'A new address answered as a saved environment. The saved token is not sent until a person agrees.',
    input: {
      environment: { status: 'selected', endpoint: 'https://tunnel.example' },
      bootstrap: {
        status: 'ready',
        environmentId: 'env-local',
        label: 'Local environment',
        protocolVersion: PROTOCOL_VERSION,
      },
      transport: { phase: 'connected', hasConnected: false, failure: null },
      routeOffer: { endpoint: 'https://tunnel.example', label: 'Local environment' },
    },
  },
  {
    id: 'connecting',
    name: 'Connecting',
    summary: 'First bootstrap after an endpoint is chosen. Shell stays mounted.',
    input: {
      environment: selected,
      bootstrap: { status: 'loading' },
      transport: { phase: 'connecting', hasConnected: false, failure: null },
    },
  },
  {
    id: 'reconnecting',
    name: 'Reconnecting',
    summary: 'A live session already existed. Do not replace the whole screen.',
    input: {
      environment: selected,
      bootstrap: { status: 'loading' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: null },
    },
  },
  {
    id: 'offline',
    name: 'Offline',
    summary: 'The device reports no network. Nothing to retry until it returns.',
    input: {
      environment: selected,
      bootstrap: { status: 'loading' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: null },
      network: { online: false },
    },
  },
  {
    id: 'unreachable',
    name: 'Server unreachable',
    summary: 'Bootstrap or transport failed without a protocol or auth error.',
    input: {
      environment: selected,
      bootstrap: {
        status: 'unreachable',
        message:
          'Could not reach http://127.0.0.1:43120. Check that the environment server is running, then retry.',
      },
      transport: {
        phase: 'closed',
        hasConnected: true,
        failure: { code: 'unreachable' },
      },
    },
  },
  {
    id: 'incompatible_protocol',
    name: 'Protocol mismatch',
    summary: 'evaluateBootstrap returned incompatible_protocol.',
    input: {
      environment: selected,
      bootstrap: {
        status: 'incompatible_protocol',
        clientProtocolVersion: 1,
        serverProtocolVersion: 2,
        environmentId: 'env-local',
        label: 'Local environment',
      },
      transport: {
        phase: 'closed',
        hasConnected: false,
        failure: { code: 'protocol_incompatible' },
      },
    },
  },
  {
    id: 'unauthorized',
    name: 'Unauthorized',
    summary: 'Bootstrap or upgrade returned auth. Do not retry in a loop.',
    input: {
      environment: selected,
      bootstrap: {
        status: 'unauthorized',
        message: 'Origin is not allowed.',
      },
      transport: { phase: 'closed', hasConnected: false, failure: { code: 'auth' } },
    },
  },
]

export type RouteFailureStory = {
  /** The reason it shows, or the reason and a variant of it. */
  id: RouteFailureReason | 'route_search' | `${RouteFailureReason}_${string}`
  name: string
  summary: string
  input: DeriveConnectionInput
}

const studio = {
  status: 'selected' as const,
  endpoint: 'https://studio.example.com',
  environmentId: 'env-studio',
  label: 'Studio',
}
const failedTransport = { phase: 'closed' as const, hasConnected: true, failure: null }

/** Why no saved route reaches an environment, one story per reason. */
export const ROUTE_FAILURE_STORIES: RouteFailureStory[] = [
  {
    id: 'route_search',
    name: 'Trying another route',
    summary: 'The route in use failed; the other saved routes are being asked, local first.',
    input: {
      environment: studio,
      bootstrap: { status: 'unreachable', cause: 'network' },
      transport: { phase: 'reconnecting', hasConnected: true, failure: null },
      routeSearch: { from: 'https://studio.example.com' },
    },
  },
  {
    id: 'route_down',
    name: 'Route unavailable',
    summary:
      "Nothing answers at the address at all: this device's network, or the way to the address, is down.",
    input: {
      environment: studio,
      bootstrap: { status: 'unreachable', cause: 'network' },
      transport: failedTransport,
      routeFailure: {
        reason: 'route_down',
        endpoint: 'https://studio.example.com',
        local: false,
        tried: 2,
      },
    },
  },
  {
    id: 'tunnel_down',
    name: 'Tunnel down',
    summary:
      'Cloudflare answers for the hostname, but the environment does not answer through it: the tunnel is down, or the server behind it is stopped. A browser cannot tell those two apart.',
    input: {
      environment: studio,
      bootstrap: { status: 'unreachable', cause: 'opaque' },
      transport: failedTransport,
      routeFailure: {
        reason: 'tunnel_down',
        endpoint: 'https://studio.example.com',
        local: false,
        tried: 1,
      },
    },
  },
  {
    id: 'environment_offline',
    name: 'Environment offline',
    summary: 'Nothing listens on this device, or a gateway said so in a status this page can read.',
    input: {
      environment: { ...studio, endpoint: 'http://127.0.0.1:43120' },
      bootstrap: { status: 'unreachable', cause: 'network' },
      transport: failedTransport,
      routeFailure: {
        reason: 'environment_offline',
        endpoint: 'http://127.0.0.1:43120',
        local: true,
        tried: 2,
      },
    },
  },
  {
    id: 'local_access_blocked',
    name: 'Local access blocked',
    summary: 'The hosted page was refused the browser permission to reach this device.',
    input: {
      environment: { ...studio, endpoint: 'http://127.0.0.1:43120' },
      bootstrap: { status: 'unreachable', cause: 'blocked' },
      transport: failedTransport,
      routeFailure: {
        reason: 'local_access_blocked',
        endpoint: 'http://127.0.0.1:43120',
        local: true,
        tried: 1,
      },
    },
  },
  {
    id: 'environment_offline_stopped',
    name: 'Environment shut down',
    summary:
      'The environment closed its socket as it shut down, so the silence from its tunnel since means it is still stopped.',
    input: {
      environment: studio,
      bootstrap: { status: 'unreachable', cause: 'opaque' },
      transport: failedTransport,
      routeFailure: {
        reason: 'environment_offline',
        endpoint: 'https://studio.example.com',
        local: false,
        tried: 1,
        stopped: true,
      },
    },
  },
  {
    id: 'route_refused',
    name: 'Route refused access',
    summary: 'The bootstrap was refused: a tunnel sign-in, or the environment origin check.',
    input: {
      environment: studio,
      bootstrap: { status: 'unauthorized', message: 'Forbidden.' },
      transport: failedTransport,
      routeFailure: {
        reason: 'route_refused',
        endpoint: 'https://studio.example.com',
        local: false,
        tried: 1,
        message: 'Forbidden.',
      },
    },
  },
  {
    id: 'route_refused_local',
    name: 'Page not allowed',
    summary:
      "Something answers on this device but will not let this page read it: the environment refusing this page's origin.",
    input: {
      environment: { ...studio, endpoint: 'http://127.0.0.1:43120' },
      bootstrap: { status: 'unreachable', cause: 'opaque' },
      transport: failedTransport,
      routeFailure: {
        reason: 'route_refused',
        endpoint: 'http://127.0.0.1:43120',
        local: true,
        tried: 1,
      },
    },
  },
  {
    id: 'credential_rejected',
    name: 'Token rejected',
    summary: 'The environment refused the client token. No other route is tried.',
    input: {
      environment: studio,
      bootstrap: {
        status: 'ready',
        environmentId: 'env-studio',
        label: 'Studio',
        protocolVersion: PROTOCOL_VERSION,
      },
      transport: failedTransport,
      routeFailure: {
        reason: 'credential_rejected',
        endpoint: 'https://studio.example.com',
        local: false,
        tried: 1,
        message: 'Token not recognized.',
      },
    },
  },
  {
    id: 'wrong_environment',
    name: 'Different environment',
    summary: 'The address now answers as another environment, and no other route reaches this one.',
    input: {
      environment: studio,
      bootstrap: {
        status: 'ready',
        environmentId: 'env-other',
        protocolVersion: PROTOCOL_VERSION,
      },
      transport: failedTransport,
      routeFailure: {
        reason: 'wrong_environment',
        endpoint: 'https://studio.example.com',
        local: false,
        tried: 1,
      },
    },
  },
]

export const READY_CONNECTION_INPUT: DeriveConnectionInput = {
  environment: selected,
  bootstrap: {
    status: 'ready',
    environmentId: 'env-local',
    label: 'Local environment',
    protocolVersion: PROTOCOL_VERSION,
  },
  transport: { phase: 'connected', hasConnected: true, failure: null },
}
