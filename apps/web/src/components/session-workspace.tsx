import { useCallback, useEffect, useRef } from 'react'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '@openmanager/app-core/providers/environment-client'
import { useNavigate } from '@tanstack/react-router'
import { ChatWorkspace } from '@openmanager/app-core/components/chat/ChatWorkspace'
import { isEnvironmentClientError, type EnvironmentState } from '@openmanager/environment-client'

const selectConnected = (state: EnvironmentState) => state.connection.phase === 'connected'

/**
 * The chat pane for a route. With an environment client the shared chat
 * workspace renders; the `/sessions/$sessionId` route additionally opens the
 * session the URL names once the catalog knows it.
 */
export function SessionWorkspace({ sessionId }: { sessionId?: string }) {
  const client = useEnvironmentClientOptional()
  if (!client) return <SessionPlaceholder sessionId={sessionId} />
  return <ConnectedSessionWorkspace sessionId={sessionId} />
}

function ConnectedSessionWorkspace({ sessionId }: { sessionId?: string }) {
  const client = useEnvironmentClientOptional()!
  const selector = useCallback(
    (state: EnvironmentState) => Boolean(sessionId && state.sessions[sessionId]),
    [sessionId],
  )
  const known = useEnvironmentState(selector)
  const connected = useEnvironmentState(selectConnected)
  const navigate = useNavigate()
  const openedSessionRef = useRef<string | null>(null)
  // A session opened before the catalog knew it: the route's own open, on
  // its way or done, so it is not asked for twice.
  const probedSessionRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  // Leaving the chat pane (for Settings, say) while that open is on its way:
  // its late answer must neither select the session nor replace the page the
  // user went to. Only on unmount: a re-run for the same address keeps it.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (probedSessionRef.current === null) return
      probedSessionRef.current = null
      client.setActiveSession(null)
    }
  }, [client])

  useEffect(() => {
    if (probedSessionRef.current !== sessionId) probedSessionRef.current = null
    // Only the route selects a session. Active-session updates must never
    // retrigger an open for a route we are in the process of leaving.
    if (!sessionId) {
      client.setActiveSession(null)
      return
    }
    if (!known) {
      // Deleting the viewed session (including from recovery) removes its
      // catalog entry. Replace that dead URL without observing active state.
      if (openedSessionRef.current === sessionId) {
        void navigate({ to: '/', replace: true })
        return
      }
      // Not loaded: past the catalog's first page, or gone. Asking for it
      // opens one that exists without waiting for the rest of the catalog;
      // one the environment does not have leaves its address for `/`.
      if (!connected || probedSessionRef.current === sessionId) return
      probedSessionRef.current = sessionId
      void client.commands.openSession(sessionId).catch((error: unknown) => {
        if (!mountedRef.current || probedSessionRef.current !== sessionId) return
        probedSessionRef.current = null
        if (isEnvironmentClientError(error) && error.code === 'not_found') {
          void navigate({ to: '/', replace: true })
        }
      })
      return
    }
    openedSessionRef.current = sessionId
    if (probedSessionRef.current === sessionId) {
      // The route's earlier open brought it in.
      probedSessionRef.current = null
    } else {
      void client.commands.openSession(sessionId).catch(() => undefined)
    }
    // Invalidate an in-flight open when leaving for another session or draft.
    return () => client.setActiveSession(null)
  }, [client, connected, sessionId, known, navigate])

  return <ChatWorkspace />
}

function SessionPlaceholder({ sessionId }: { sessionId?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sessionId ? (
        <header className="border-b border-[var(--basis-border-muted)] px-5 py-3">
          <h1 className="text-ui-sm font-medium text-[var(--basis-text-strong)]">Session</h1>
          <p className="mt-0.5 font-mono text-ui-xs text-[var(--basis-text-muted)]">{sessionId}</p>
        </header>
      ) : null}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="max-w-md text-center text-ui-sm leading-ui-normal text-[var(--basis-text-muted)]">
          Connect to an environment to see your sessions here.
        </p>
      </div>
    </div>
  )
}
