import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENVIRONMENT_SERVER_URL,
  resolveEnvironmentClientConfig,
} from './environment-client-config'

describe('resolveEnvironmentClientConfig', () => {
  it('defaults to the Convex adapter against the local environment server', () => {
    expect(resolveEnvironmentClientConfig({})).toEqual({
      backend: 'convex',
      serverUrl: DEFAULT_ENVIRONMENT_SERVER_URL,
      credential: '',
    })
  })

  it('selects the WebSocket client and carries the server URL and token', () => {
    expect(
      resolveEnvironmentClientConfig({
        OPENMANAGER_ENVIRONMENT_CLIENT: ' WebSocket ',
        OPENMANAGER_ENVIRONMENT_URL: 'http://localhost:5000 ',
        OPENMANAGER_CLIENT_TOKEN: 'abc',
      }),
    ).toEqual({ backend: 'websocket', serverUrl: 'http://localhost:5000', credential: 'abc' })
  })

  it('ignores an unknown backend name', () => {
    expect(resolveEnvironmentClientConfig({ OPENMANAGER_ENVIRONMENT_CLIENT: 'grpc' }).backend).toBe(
      'convex',
    )
  })
})
