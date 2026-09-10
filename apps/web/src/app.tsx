import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { RouterProvider, type AnyRouter } from '@tanstack/react-router'
import { ErrorBoundary } from './components/error-boundary'
import { ConnectionProvider } from './providers/connection-provider'
import { WebEnvironmentClientProvider } from './providers/environment-client-provider'
import { ThemeProvider } from './providers/theme-provider'

export function WebApp({ router, queryClient }: { router: AnyRouter; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConnectionProvider>
          <WebEnvironmentClientProvider>
            <ErrorBoundary>
              <RouterProvider router={router} />
            </ErrorBoundary>
          </WebEnvironmentClientProvider>
        </ConnectionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
