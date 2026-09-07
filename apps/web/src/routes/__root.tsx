import type { QueryClient } from '@tanstack/react-query'
import {
  Link,
  createRootRouteWithContext,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { AppShell } from '../components/app-shell'
import { ErrorFallback } from '../components/error-boundary'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  errorComponent: RouteError,
  notFoundComponent: NotFound,
})

function RootLayout() {
  return (
    <>
      <AppShell />
      {import.meta.env.DEV && import.meta.env.MODE !== 'test' ? (
        <TanStackRouterDevtools position="bottom-right" />
      ) : null}
    </>
  )
}

function RouteError({ error, reset }: ErrorComponentProps) {
  const err = error instanceof Error ? error : new Error(String(error))
  return <ErrorFallback error={err} onRetry={reset} />
}

function NotFound() {
  const router = useRouter()
  return (
    <div className="flex min-h-full flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">Page not found</h1>
        <p className="mt-2 text-ui-sm text-[var(--basis-text-muted)]">
          That route is not part of the OpenManager web shell.
        </p>
        <Link
          to="/"
          className="mt-4 inline-flex rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)]"
          onClick={() => router.invalidate()}
        >
          Back to sessions
        </Link>
      </div>
    </div>
  )
}
