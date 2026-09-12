import { useCallback, useEffect } from 'react'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '@openmanager/app-core/providers/environment-client'
import { ChatWorkspace } from '@openmanager/app-core/components/chat/ChatWorkspace'
import type { EnvironmentState } from '@openmanager/environment-client'

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
    (state: EnvironmentState) =>
      sessionId
        ? state.activeSessionId === sessionId
          ? 'active'
          : state.sessions[sessionId]
            ? 'known'
            : 'unknown'
        : 'none',
    [sessionId],
  )
  const status = useEnvironmentState(selector)

  useEffect(() => {
    if (!sessionId || status !== 'known') return
    void client.commands.openSession(sessionId).catch(() => undefined)
  }, [client, sessionId, status])

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
