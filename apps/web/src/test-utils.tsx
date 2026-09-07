import { createMemoryHistory } from '@tanstack/react-router'
import { render, type RenderOptions } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { WebApp } from './app'
import { ErrorBoundary } from './components/error-boundary'
import { ThemeProvider } from './providers/theme-provider'
import { createQueryClient } from './query-client'
import { createWebRouter } from './router'

export function renderWebApp(path = '/', options?: RenderOptions) {
  const queryClient = createQueryClient()
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createWebRouter({ history, queryClient })
  const result = render(<WebApp router={router} queryClient={queryClient} />, options)
  return { ...result, router, queryClient }
}

export function renderWithTheme(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>)
}

export function renderWithinBoundary(children: ReactNode) {
  return render(<ErrorBoundary>{children}</ErrorBoundary>)
}
