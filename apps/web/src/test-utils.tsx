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

function createTestEnvironmentClient(options: WebSocketEnvironmentClientOptions) {
  return createMockEnvironmentClient({
    seed: {
      environment: { environmentId: options.environmentId ?? 'env-local', name: 'Environment' },
    },
  })
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
