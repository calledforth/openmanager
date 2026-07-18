import { useActiveSession } from '../../providers/active-session-provider'
import { useAppUi } from '../../providers/app-ui-provider'
import { cn } from '../../lib/utils'
import { typographyCaption } from '../../lib/typography'

export function ChatSectionHeader() {
  const { activeSessionId, activeSession, abortSession } = useActiveSession()
  const { localSessionStatus } = useAppUi()

  const status = localSessionStatus ?? activeSession?.status
  const isStreaming = status === 'running' || status === 'busy'

  const handleAbort = () => {
    if (!activeSessionId) return
    abortSession(activeSessionId).catch(() => undefined)
  }

  if ((!status || status === 'idle') && !(isStreaming && activeSessionId)) {
    return null
  }

  return (
    <div
      className="flex h-[var(--basis-titlebar-height)] shrink-0 items-center justify-end gap-2 px-3"
      data-chat-section-header
    >
      {status && status !== 'idle' && (
        <span
          className={cn(
            typographyCaption,
            'shrink-0',
            status === 'running' || status === 'busy'
              ? 'text-[var(--basis-text)]'
              : status === 'error'
                ? 'text-destructive'
                : 'text-[var(--basis-text-muted)]',
          )}
        >
          {status}
        </span>
      )}

      {isStreaming && activeSessionId && (
        <button
          type="button"
          onClick={handleAbort}
          className={cn(
            typographyCaption,
            'shrink-0 rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] px-2 py-0.5 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
          )}
        >
          Stop
        </button>
      )}
    </div>
  )
}
