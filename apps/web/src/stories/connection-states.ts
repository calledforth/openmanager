import type { ConnectionKind, DeriveConnectionInput } from '../lib/connection-state'

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
    id: 'unreachable',
    name: 'Server unreachable',
    summary: 'Bootstrap or transport failed without a protocol or auth error.',
    input: {
      environment: selected,
      bootstrap: {
        status: 'unreachable',
        message: 'Could not reach http://127.0.0.1:43120. Check that the environment server is running, then retry.',
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
      transport: { phase: 'closed', hasConnected: false, failure: { code: 'protocol_incompatible' } },
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

export const READY_CONNECTION_INPUT: DeriveConnectionInput = {
  environment: selected,
  bootstrap: {
    status: 'ready',
    environmentId: 'env-local',
    label: 'Local environment',
    protocolVersion: 1,
  },
  transport: { phase: 'connected', hasConnected: true, failure: null },
}
