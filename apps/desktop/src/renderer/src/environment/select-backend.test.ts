import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_CLIENT_STORAGE_KEY,
  environmentSocketUrl,
  readStoredBackendOverride,
  resolveEnvironmentClientSelection,
} from './select-backend'

const config = {
  backend: 'convex' as const,
  serverUrl: 'http://127.0.0.1:43120',
  credential: 'tok',
}

describe('resolveEnvironmentClientSelection', () => {
  it('keeps the main process choice without an override', () => {
    expect(resolveEnvironmentClientSelection(config, null)).toBe(config)
    expect(resolveEnvironmentClientSelection(config, 'grpc')).toBe(config)
  })

  it('lets local storage flip the backend while keeping the server settings', () => {
    expect(resolveEnvironmentClientSelection(config, ' WebSocket ')).toEqual({
      ...config,
      backend: 'websocket',
    })
  })
})

describe('readStoredBackendOverride', () => {
  it('reads the override key and tolerates a broken storage', () => {
    const store = new Map<string, string>([[ENVIRONMENT_CLIENT_STORAGE_KEY, 'websocket']])
    expect(readStoredBackendOverride({ getItem: (key) => store.get(key) ?? null })).toBe(
      'websocket',
    )
    expect(readStoredBackendOverride(undefined)).toBeNull()
    expect(
      readStoredBackendOverride({
        getItem: () => {
          throw new Error('denied')
        },
      }),
    ).toBeNull()
  })
})

describe('environmentSocketUrl', () => {
  it('derives ws and wss endpoints from the HTTP origin', () => {
    expect(environmentSocketUrl('http://127.0.0.1:43120')).toBe('ws://127.0.0.1:43120/ws')
    expect(environmentSocketUrl('https://env.example.com/')).toBe('wss://env.example.com/ws')
  })
})
