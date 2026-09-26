import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { RouterProvider, type AnyRouter } from '@tanstack/react-router'
import type { createWebSocketEnvironmentClient } from '@openmanager/environment-client'
import { FluidProviders } from '@openmanager/app-core/providers/fluid-provider'
import { CommandPalette } from '@openmanager/app-core/components/command/CommandPalette'
import { ErrorBoundary } from './components/error-boundary'
import { ConnectionProvider } from './providers/connection-provider'
import { WebEnvironmentClientProvider } from './providers/environment-client-provider'
import { ThemeProvider } from './providers/theme-provider'

export function WebApp({
  router,
  queryClient,
  createEnvironmentClient,
}: {
  router: AnyRouter
  queryClient: QueryClient
  /** Overrides the WebSocket client factory; tests pass the mock here. */
  createEnvironmentClient?: typeof createWebSocketEnvironmentClient
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <FluidProviders>
          <CommandPalette />
          <ConnectionProvider>
            <WebEnvironmentClientProvider createClient={createEnvironmentClient}>
              <ErrorBoundary>
                <RouterProvider router={router} />
              </ErrorBoundary>
            </WebEnvironmentClientProvider>
          </ConnectionProvider>
        </FluidProviders>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
