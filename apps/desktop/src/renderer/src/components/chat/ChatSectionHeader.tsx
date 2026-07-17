import { PanelLeft, SquarePen } from 'lucide-react'
import { useActiveSession } from '../../providers/active-session-provider'
import { useAppUi } from '../../providers/app-ui-provider'
import { useSidebarData } from '../../providers/sidebar-data-provider'
import { cn } from '../../lib/utils'
import { typographyCaption, typographyTitle } from '../../lib/typography'

const iconBtnClass =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text-strong)] disabled:opacity-30'

export function ChatSectionHeader({
  sidebarCollapsed,
  onToggleSidebar,
}: {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}) {
  const { activeSessionId, activeSession, abortSession } = useActiveSession()
  const { activeWorkspacePath, isSessionDraftOpen } = useAppUi()
  const { createSession } = useSidebarData()

  const isStreaming = activeSession?.status === 'running' || activeSession?.status === 'busy'
  const status = activeSession?.status

  let sessionTitle = 'New session'
  if (activeSessionId && activeSession?.title) {
    sessionTitle = activeSession.title
  } else if (activeSessionId) {
    sessionTitle = activeSessionId.slice(0, 12)
  } else if (isSessionDraftOpen && activeWorkspacePath) {
    sessionTitle =
      activeWorkspacePath.split(/[\\/]/).filter(Boolean).pop() ?? activeWorkspacePath
  }

  const handleAbort = () => {
    if (!activeSessionId) return
    abortSession(activeSessionId).catch(() => undefined)
  }

  const handleNewSession = () => {
    if (!activeWorkspacePath) return
    void createSession(activeWorkspacePath)
  }

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] px-2.5"
      data-chat-section-header
    >
      <div className="flex shrink-0 items-center gap-0.5" data-sidebar-icons>
        <button
          type="button"
          onClick={onToggleSidebar}
          className={iconBtnClass}
          title={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
          aria-expanded={!sidebarCollapsed}
        >
          <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={handleNewSession}
          disabled={!activeWorkspacePath}
          className={iconBtnClass}
          title="New thread"
        >
          <SquarePen className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <span
        className={cn(typographyTitle, 'min-w-0 flex-1 truncate font-normal text-[var(--basis-text-muted)]')}
        title={sessionTitle}
      >
        {sessionTitle}
      </span>

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
