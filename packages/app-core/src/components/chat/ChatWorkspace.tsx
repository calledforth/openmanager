import { useSessionState } from '../../providers/session-provider'
import { useActiveThreadState } from '../../providers/active-thread-provider'
import { ChatView } from './ChatView'
import { FloatingChatComposer } from './FloatingChatComposer'
import { MessageInput } from './MessageInput'
import { useState, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '../../providers/environment-client'

const ACTION_CLASS =
  'rounded-md border border-[var(--basis-border-muted)] px-3 py-2 hover:bg-[var(--basis-surface)] focus-visible:outline focus-visible:outline-2 disabled:opacity-50'

function SessionOpenBoundary({ children }: { children: ReactNode }) {
  const client = useEnvironmentClientOptional()!
  const failure = useEnvironmentState((state) => state.sessionOpenFailure)
  const workspace = useEnvironmentState((state) => {
    const sessionId = state.sessionOpenFailure?.sessionId
    const session = sessionId ? state.sessions[sessionId] : undefined
    return session ? state.workspaces[session.workspaceId] : undefined
  })
  const [retrying, setRetrying] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  if (!failure) return children
  // The folder, not the request, is what has to change, so the pane explains
  // the on-disk fix and still offers a way out that does not need the folder.
  const unavailable = failure.code === 'workspace_unavailable'
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto p-6">
      {/* A landmark so the recovery actions are reachable on their own, not
        only by reading past the alert that explains them. */}
      <section
        aria-label="Session recovery"
        className="m-auto w-full max-w-lg space-y-4 text-ui-sm text-[var(--basis-text)]"
      >
        <div role="alert" className="space-y-2">
          <h2 className="font-medium">
            {unavailable ? 'Project folder unavailable' : 'Could not open session'}
          </h2>
          {workspace ? <p className="break-all font-mono text-ui-xs">{workspace.path}</p> : null}
          <p>{failure.message}</p>
          {workspace?.availability === 'inaccessible' ? (
            <p>Check folder permissions and the environment’s allowed workspace roots.</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={retrying || deleting}
            className={ACTION_CLASS}
            onClick={() => {
              setRetrying(true)
              setConfirmingDelete(false)
              void client.commands
                .openSession(failure.sessionId)
                .catch(() => undefined)
                .finally(() => setRetrying(false))
            }}
          >
            {retrying ? 'Trying again…' : 'Try again'}
          </button>
          {unavailable ? (
            <button
              type="button"
              disabled={deleting}
              className={cn(
                ACTION_CLASS,
                confirmingDelete
                  ? 'border-red-400/50 text-red-400 hover:bg-red-400/10'
                  : 'text-[var(--basis-text-muted)] hover:text-[var(--basis-text)]',
              )}
              onClick={() => {
                // Deleting a transcript is irreversible; the second click is
                // the confirmation, so nothing is lost to a stray click here.
                if (!confirmingDelete) {
                  setConfirmingDelete(true)
                  return
                }
                setDeleting(true)
                void client.commands
                  .deleteSession(failure.sessionId)
                  .catch(() => undefined)
                  .finally(() => {
                    setDeleting(false)
                    setConfirmingDelete(false)
                  })
              }}
            >
              {confirmingDelete ? 'Delete permanently' : 'Delete session'}
            </button>
          ) : null}
        </div>
        {unavailable ? (
          <p className="text-[var(--basis-text-muted)]">
            If you moved the folder, restore its original path to reopen this session. Adding the
            new path creates a separate project and keeps this session in the original project.
          </p>
        ) : null}
      </section>
    </div>
  )
}

/** Subagent transcripts are read-only: the composer is replaced by a banner
 * linking back to the parent session. */
export function ChildSessionBanner({ onBack }: { onBack: () => void }) {
  return (
    <div className="pointer-events-auto mx-auto mb-4 flex w-fit items-center gap-2 rounded-full border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-xs text-[var(--basis-text-muted)] shadow-sm">
      <span>Subagent transcript · read-only</span>
      <button
        type="button"
        className="rounded-full border border-[var(--basis-border-muted)] px-2 py-0.5 text-[var(--basis-text)] hover:bg-[var(--basis-canvas-bg)]"
        onClick={onBack}
      >
        Back to session
      </button>
    </div>
  )
}

/**
 * The chat pane: conversation above, composer docked below — or the
 * read-only banner when a subagent transcript is open. Hosts wrap it in
 * their own chrome (title bar, sidebar, panels).
 */
export function ChatWorkspace() {
  const client = useEnvironmentClientOptional()
  return client ? (
    <SessionOpenBoundary>
      <ChatWorkspaceContent />
    </SessionOpenBoundary>
  ) : (
    <ChatWorkspaceContent />
  )
}

function ChatWorkspaceContent() {
  const { closeChildSession } = useSessionState()
  const { activeThread } = useActiveThreadState()
  const parentExternalId = activeThread?.parentExternalId

  return (
    <>
      <ChatView />
      {parentExternalId ? (
        <ChildSessionBanner onBack={() => closeChildSession(parentExternalId)} />
      ) : (
        <FloatingChatComposer>
          <MessageInput />
        </FloatingChatComposer>
      )}
    </>
  )
}
