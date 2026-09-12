import { useSessionState } from '../../providers/session-provider'
import { useActiveThreadState } from '../../providers/active-thread-provider'
import { ChatView } from './ChatView'
import { FloatingChatComposer } from './FloatingChatComposer'
import { MessageInput } from './MessageInput'

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
