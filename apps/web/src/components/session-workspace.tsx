import { useCallback, useEffect, useRef } from 'react'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '@openmanager/app-core/providers/environment-client'
import { useNavigate } from '@tanstack/react-router'
import { ChatWorkspace } from '@openmanager/app-core/components/chat/ChatWorkspace'
import { isEnvironmentClientError, type EnvironmentState } from '@openmanager/environment-client'
import { useAddressLookup, type AddressLookup } from '../providers/address-environment'

const selectConnected = (state: EnvironmentState) => state.connection.phase === 'connected'

/**
 * The chat pane for a route. With an environment client the shared chat
 * workspace renders; the `/sessions/$sessionId` route additionally opens the
 * session the URL names once the catalog knows it.
 */
export function SessionWorkspace({ sessionId }: { sessionId?: string }) {
  const client = useEnvironmentClientOptional()
  const lookup = useAddressLookup()
  if (!client) return <SessionPlaceholder sessionId={sessionId} lookup={lookup} />
  return <ConnectedSessionWorkspace sessionId={sessionId} />
}

function ConnectedSessionWorkspace({ sessionId }: { sessionId?: string }) {
  // Its commands, not the client: the same environment's client is handed over
  // under this page as it connects, and that is no reason to open the chat again.
  const { commands, setActiveSession } = useEnvironmentClientOptional()!
  const selector = useCallback(
    (state: EnvironmentState) => Boolean(sessionId && state.sessions[sessionId]),
    [sessionId],
  )
  const known = useEnvironmentState(selector)
  const connected = useEnvironmentState(selectConnected)
  const lookup = useAddressLookup()
  const { reportAbsent, status } = lookup
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
      setActiveSession(null)
    }
  }, [setActiveSession])

  useEffect(() => {
    if (probedSessionRef.current !== sessionId) probedSessionRef.current = null
    // Only the route selects a session. Active-session updates must never
    // retrigger an open for a route we are in the process of leaving.
    if (!sessionId) {
      setActiveSession(null)
      return
    }
    if (!known) {
      // Deleting the viewed session (including from recovery) removes its
      // catalog entry. Replace that dead URL without observing active state.
      if (openedSessionRef.current === sessionId) {
        void navigate({ to: '/', replace: true })
        return
      }
      // Not loaded: past the catalog's first page, gone, or another
      // environment's. Asking for it opens one that exists without waiting for
      // the rest of the catalog; one this environment does not have is looked
      // for in the others.
      if (!connected || probedSessionRef.current === sessionId) return
      probedSessionRef.current = sessionId
      void commands.openSession(sessionId).catch((error: unknown) => {
        if (!mountedRef.current || probedSessionRef.current !== sessionId) return
        if (isEnvironmentClientError(error) && error.code === 'not_found') {
          reportAbsent(sessionId)
          return
        }
        probedSessionRef.current = null
      })
      return
    }
    openedSessionRef.current = sessionId
    if (probedSessionRef.current === sessionId) {
      // The route's earlier open brought it in.
      probedSessionRef.current = null
    } else {
      void commands.openSession(sessionId).catch(() => undefined)
    }
    // Invalidate an in-flight open when leaving for another session or draft.
    return () => setActiveSession(null)
  }, [commands, setActiveSession, connected, sessionId, known, navigate, reportAbsent])

  // Nobody has it, so it leaves its address.
  useEffect(() => {
    if (sessionId && !known && status === 'absent') void navigate({ to: '/', replace: true })
  }, [known, navigate, sessionId, status])

  // Nothing kept of it here and nothing to ask yet: an empty chat would read as
  // a new session with no messages.
  if (sessionId && !known && (!connected || status === 'offline')) {
    return <SessionPlaceholder sessionId={sessionId} lookup={lookup} />
  }
  return <ChatWorkspace />
}

/** Names who cannot be asked: one of them may have what the address names. */
function mayBeOn(offline: readonly string[]) {
  const names = new Intl.ListFormat('en', { type: 'disjunction' }).format(offline)
  return `This session may be on ${names}, which ${offline.length > 1 ? 'are' : 'is'} offline.`
}

function SessionPlaceholder({
  sessionId,
  lookup,
}: {
  sessionId?: string
  lookup: AddressLookup
}) {
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
          {lookup.status === 'offline'
            ? mayBeOn(lookup.offline)
            : 'Connect to an environment to see your sessions here.'}
        </p>
      </div>
    </div>
  )
}
