import { createMemoryHistory } from '@tanstack/react-router'
import { render, type RenderOptions } from '@testing-library/react'
import {
  createMockEnvironmentClient,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { WebApp } from './app'
import { ErrorBoundary } from './components/error-boundary'
import { ThemeProvider } from './providers/theme-provider'
import { createQueryClient } from './query-client'
import { createWebRouter } from './router'

type MockEnvironmentClient = ReturnType<typeof createMockEnvironmentClient>

/**
 * The mock reads as connected from the moment it exists. A real client has
 * nothing to say until it dials, so this one waits for `connect()` too, and
 * calls `onDial` the first time it comes.
 */
export function idleUntilDialled(client: MockEnvironmentClient, onDial?: () => void) {
  const { connect, getState, subscribe } = client
  const listeners = new Set<() => void>()
  let dialled = false
  let idle: ReturnType<typeof getState> | undefined
  client.getState = () => {
    if (dialled) return getState()
    idle ??= {
      ...getState(),
      environment: null,
      connection: { ...getState().connection, phase: 'idle' },
    }
    return idle
  }
  client.subscribe = (listener) => {
    listeners.add(listener)
    const unsubscribe = subscribe(listener)
    return () => {
      listeners.delete(listener)
      unsubscribe()
    }
  }
  client.connect = () => {
    if (!dialled) onDial?.()
    dialled = true
    connect()
    for (const listener of listeners) listener()
  }
  return client
}

function createTestEnvironmentClient(options: WebSocketEnvironmentClientOptions) {
  return idleUntilDialled(
    createMockEnvironmentClient({
      seed: {
        environment: { environmentId: options.environmentId ?? 'env-local', name: 'Environment' },
      },
    }),
  )
}

export function renderWebApp(
  path = '/',
  options?: RenderOptions & {
    createEnvironmentClient?: ComponentProps<typeof WebApp>['createEnvironmentClient']
  },
) {
  const { createEnvironmentClient, ...renderOptions } = options ?? {}
  const queryClient = createQueryClient()
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createWebRouter({ history, queryClient })
  const result = render(
    <WebApp
      router={router}
      queryClient={queryClient}
      createEnvironmentClient={createEnvironmentClient ?? createTestEnvironmentClient}
    />,
    renderOptions,
  )
  return { ...result, router, queryClient }
}

export function renderWithTheme(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>)
}

export function renderWithinBoundary(children: ReactNode) {
  return render(<ErrorBoundary>{children}</ErrorBoundary>)
}
