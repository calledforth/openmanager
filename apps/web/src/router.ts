import { createBrowserHistory, createRouter, type RouterHistory } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import { createQueryClient } from './query-client'

export function createWebRouter(options?: { history?: RouterHistory; queryClient?: QueryClient }) {
  const queryClient = options?.queryClient ?? createQueryClient()
  return createRouter({
    routeTree,
    history: options?.history ?? createBrowserHistory(),
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createWebRouter>
  }
}
