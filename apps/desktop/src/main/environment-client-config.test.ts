import { describe, expect, it, vi } from 'vitest'
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

  it('falls back to the default server URL when the configured one is not an http(s) URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const bad of ['localhost:43120', 'ws://127.0.0.1:43120', 'not a url']) {
      expect(resolveEnvironmentClientConfig({ OPENMANAGER_ENVIRONMENT_URL: bad }).serverUrl).toBe(
        DEFAULT_ENVIRONMENT_SERVER_URL,
      )
    }
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('ignores an unknown backend name', () => {
    expect(resolveEnvironmentClientConfig({ OPENMANAGER_ENVIRONMENT_CLIENT: 'grpc' }).backend).toBe(
      'convex',
    )
  })
})
