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
    // Off, and it must stay off. The router's restoration remembers any element
    // that scrolled, by its place in the page, and writes that offset back
    // after every navigation. The chat's scroller is one element across
    // sessions and places its own reader (ChatView), so the router would run
    // last and move every reopened chat, to the top or to another chat's
    // offset.
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createWebRouter>
  }
}
