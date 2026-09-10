import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  selectActiveSession,
  selectActiveThread,
  selectActiveTurn,
  selectConnection,
  selectPendingInteractions,
  selectSessionList,
  selectWorkspaces,
  shallowEqualArray,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'

/**
 * The only channel through which visual components read environment data or
 * send commands. Hosts supply a real, mock, or compatibility client; views
 * never learn which.
 */
const EnvironmentClientContext = createContext<EnvironmentClient | null>(null)

export function EnvironmentClientProvider({
  client,
  children,
}: {
  client: EnvironmentClient | null
  children: ReactNode
}) {
  return (
    <EnvironmentClientContext.Provider value={client}>{children}</EnvironmentClientContext.Provider>
  )
}

export function useEnvironmentClient(): EnvironmentClient {
  const client = useContext(EnvironmentClientContext)
  if (!client) {
    throw new Error('useEnvironmentClient must be used within an EnvironmentClientProvider')
  }
  return client
}

/** For components that also render without an environment (Storybook, shells). */
export function useEnvironmentClientOptional(): EnvironmentClient | null {
  return useContext(EnvironmentClientContext)
}

export function useEnvironmentCommands() {
  return useEnvironmentClient().commands
}

type Cache<T> = {
  state: EnvironmentState
  selector: (state: EnvironmentState) => T
  selected: T
}

/**
 * Subscribe to a slice of environment state. The selector runs once per store
 * update; `isEqual` keeps the previous value when the slice is unchanged so
 * list selectors do not re-render on every streamed token. Memoize the
 * selector (or pass `isEqual`) when it returns a fresh object.
 */
export function useEnvironmentState<T>(
  selector: (state: EnvironmentState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const client = useEnvironmentClient()
  const cache = useRef<Cache<T> | null>(null)
  const isEqualRef = useRef(isEqual)
  isEqualRef.current = isEqual
  const getSnapshot = useCallback(() => {
    const state = client.getState()
    const cached = cache.current
    if (cached && cached.state === state && cached.selector === selector) return cached.selected
    const selected = selector(state)
    if (cached && isEqualRef.current(cached.selected, selected)) {
      cache.current = { state, selector, selected: cached.selected }
      return cached.selected
    }
    cache.current = { state, selector, selected }
    return selected
  }, [client, selector])
  return useSyncExternalStore(client.subscribe, getSnapshot, getSnapshot)
}

export function useWorkspaces() {
  return useEnvironmentState(selectWorkspaces, shallowEqualArray)
}

export function useSessionList(workspaceId?: string) {
  const selector = useCallback(
    (state: EnvironmentState) => selectSessionList(state, workspaceId),
    [workspaceId],
  )
  return useEnvironmentState(selector, shallowEqualArray)
}

export function useActiveSession() {
  return useEnvironmentState(selectActiveSession)
}

export function useActiveThread() {
  return useEnvironmentState(selectActiveThread)
}

export function useActiveTurn() {
  return useEnvironmentState(selectActiveTurn)
}

export function usePendingInteractions(threadId?: string | null) {
  const selector = useCallback(
    (state: EnvironmentState) =>
      selectPendingInteractions(state, threadId === undefined ? state.activeThreadId : threadId),
    [threadId],
  )
  return useEnvironmentState(selector, shallowEqualArray)
}

export function useConnectionState() {
  return useEnvironmentState(selectConnection)
}

/** Sessions grouped under their workspace, in workspace order. */
export function useSessionsByWorkspace() {
  const workspaces = useWorkspaces()
  const sessions = useSessionList()
  return useMemo(
    () =>
      workspaces.map((workspace) => ({
        workspace,
        sessions: sessions.filter((session) => session.workspaceId === workspace.workspaceId),
      })),
    [workspaces, sessions],
  )
}
