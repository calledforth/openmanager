import { useEffect, useState } from 'react'
import {
  CopySimpleIcon,
  FolderSimpleIcon,
  HexagonIcon,
  MinusIcon,
  SidebarSimpleIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useActiveSession } from '../../providers/active-session-provider'
import { useAppUi } from '../../providers/app-ui-provider'
import { useSidebarData } from '../../providers/sidebar-data-provider'
import { cn } from '../../lib/utils'
import { typographyBody, typographyCaption } from '../../lib/typography'

const isMac = window.electronAPI.platform === 'darwin'
const showWindowControls = !isMac

/** Hover uses text-strong ink so light mode gets a clear darker wash. */
const titlebarIconBtnClass =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--basis-text-strong)] transition-default hover:bg-[color-mix(in_srgb,var(--basis-text-strong)_14%,transparent)] disabled:opacity-30'

const windowControlBtnClass =
  'flex w-10 items-center justify-center text-[var(--basis-text-strong)] transition-default hover:bg-[var(--basis-surface-hover)]'

function useTitlebarTrail() {
  const { activeSessionId, activeSession } = useActiveSession()
  const { activeWorkspacePath } = useAppUi()
  const { workspaces } = useSidebarData()

  const projectName =
    workspaces.find((workspace) => workspace.path === activeWorkspacePath)?.name ??
    (activeWorkspacePath
      ? (activeWorkspacePath.split(/[\\/]/).filter(Boolean).pop() ?? activeWorkspacePath)
      : null)

  let chatTitle = 'New session'
  if (activeSessionId && activeSession?.title) {
    chatTitle = activeSession.title
  }

  return { projectName, chatTitle }
}

export function AppChrome({
  sidebarCollapsed,
  onToggleSidebar,
  convexOpen,
  onToggleConvex,
}: {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  convexOpen: boolean
  onToggleConvex: () => void
}) {
  const [maximized, setMaximized] = useState(false)
  const { activeWorkspacePath } = useAppUi()
  const { createSession } = useSidebarData()
  const { projectName, chatTitle } = useTitlebarTrail()

  useEffect(() => {
    window.electronAPI
      .isWindowMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    return window.electronAPI.onWindowMaximizedChanged(setMaximized)
  }, [])

  const handleNewSession = () => {
    if (!activeWorkspacePath) return
    void createSession(activeWorkspacePath)
  }

  const fullTitle = projectName ? `${projectName} / ${chatTitle}` : chatTitle

  return (
    <header
      className="flex h-[var(--basis-titlebar-height)] shrink-0 items-stretch bg-[var(--basis-canvas-bg)]"
      data-app-titlebar
    >
      {sidebarCollapsed && (
        <div
          className="titlebar-no-drag flex shrink-0 items-center gap-0.5 pl-3.5 pr-2"
          data-sidebar-icons
        >
          <button
            type="button"
            onClick={onToggleSidebar}
            className={titlebarIconBtnClass}
            title="Open sidebar"
            aria-expanded={false}
          >
            <SidebarSimpleIcon weight="light" className="h-[16px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={handleNewSession}
            disabled={!activeWorkspacePath}
            className={titlebarIconBtnClass}
            title="New thread"
          >
            <PlusIcon weight="light" className="h-[16px] w-[18px]" />
          </button>
        </div>
      )}

      <div
        className={cn(
          'titlebar-drag flex min-w-0 flex-1 items-center gap-1.5 px-2',
          isMac && sidebarCollapsed && 'pl-[72px]',
        )}
        title={fullTitle}
      >
        {projectName ? (
          <>
            <FolderSimpleIcon
              className="h-4 w-4 shrink-0 text-[var(--basis-text-faint)]"
            />
            <span
              className={cn(
                typographyBody,
                'min-w-0 shrink truncate text-[var(--basis-text-muted)]',
              )}
            >
              {projectName}
            </span>
            <span className="shrink-0 text-[var(--basis-text-faint)]">/</span>
          </>
        ) : null}
        <span
          className={cn(typographyBody, 'min-w-0 truncate text-[var(--basis-text-muted)]')}
        >
          {chatTitle}
        </span>
      </div>

      <div className="titlebar-no-drag flex shrink-0 items-stretch">
        <button
          type="button"
          onClick={onToggleConvex}
          aria-pressed={convexOpen}
          title="Convex trace panel"
          className={cn(
            typographyCaption,
            'flex items-center gap-1.5 border-l border-[var(--basis-border-muted)] px-3 uppercase tracking-[0.12em] transition-default',
            convexOpen
              ? 'bg-[var(--basis-surface)] text-[var(--basis-text-strong)]'
              : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
          )}
        >
          <HexagonIcon className="h-3 w-3" />
          Convex
        </button>

        {showWindowControls && (
          <>
            <button
              type="button"
              onClick={() => window.electronAPI.minimizeWindow()}
              aria-label="Minimize"
              className={windowControlBtnClass}
            >
              <MinusIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI.maximizeWindow()}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              className={windowControlBtnClass}
            >
              {maximized ? (
                <CopySimpleIcon className="h-5 w-5" />
              ) : (
                <SquareIcon className="h-5 w-5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI.closeWindow()}
              aria-label="Close"
              className={cn(
                windowControlBtnClass,
                'hover:bg-destructive hover:text-destructive-foreground',
              )}
            >
              <XIcon className="h-5 w-5" />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
