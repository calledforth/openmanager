import { useEffect, useState } from 'react'
import {
  CopySimpleIcon,
  FolderSimpleIcon,
  MinusIcon,
  SidebarSimpleIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useActiveThreadState } from '@openmanager/app-core/providers/active-thread-provider'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useSidebarData } from '@openmanager/app-core/providers/sidebar-provider'
import { cn } from '@openmanager/app-core/lib/utils'
import { typographyBody } from '@openmanager/app-core/lib/typography'
import { Tooltip } from '@openmanager/app-core/components/ui/Tooltip'
import { ProjectIcon } from '@openmanager/app-core/components/sidebar/ProjectIcon'
import { useSidebar } from '@openmanager/app-core/components/fluid/ui/sidebar'
import {
  SessionTrailParent,
  SessionTrailTag,
} from '@openmanager/app-core/components/chat/SessionTrail'
import { useChildSessionTrail } from '@openmanager/app-core/components/chat/SubagentSession'
import { useEnvironmentClientOptional } from '@openmanager/app-core/providers/environment-client'

const isMac = window.electronAPI.platform === 'darwin'
const showWindowControls = !isMac

/** Hover uses text-strong ink so light mode gets a clear darker wash. */
const titlebarIconBtnClass =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--basis-text-strong)] transition-default hover:bg-[color-mix(in_srgb,var(--basis-text-strong)_14%,transparent)] disabled:opacity-30'

const windowControlBtnClass =
  'flex w-10 items-center justify-center text-[var(--basis-text-strong)] transition-default hover:bg-[var(--basis-surface-hover)]'

function useTitlebarTrail() {
  const { activeSessionId, activeThread } = useActiveThreadState()
  const { activeWorkspacePath } = useSessionState()
  const { workspaces } = useSidebarData()

  const project = workspaces.find((workspace) => workspace.path === activeWorkspacePath)
  const projectName =
    project?.name ??
    (activeWorkspacePath
      ? (activeWorkspacePath.split(/[\\/]/).filter(Boolean).pop() ?? activeWorkspacePath)
      : null)

  let chatTitle = 'New session'
  if (activeSessionId && activeThread?.title) {
    chatTitle = activeThread.title
  }

  return { projectName, chatTitle, scratch: project?.scratch === true }
}

function TitleText({ children }: { children: string }) {
  return (
    <span className={cn(typographyBody, 'min-w-0 truncate text-[var(--basis-text-muted)]')}>
      {children}
    </span>
  )
}

/** The session's title, after its parent's on a subagent's page, with the subagent's kind beside it. */
function ChildAwareTitle({ chatTitle }: { chatTitle: string }) {
  const child = useChildSessionTrail()
  return (
    <>
      {child ? (
        <SessionTrailParent
          trail={child}
          className={cn(typographyBody, 'titlebar-no-drag text-[var(--basis-text-muted)]')}
        />
      ) : null}
      <TitleText>{chatTitle}</TitleText>
      {child?.agentType ? <SessionTrailTag>{child.agentType}</SessionTrailTag> : null}
    </>
  )
}

export function AppChrome() {
  const { open: sidebarOpen, toggleSidebar } = useSidebar()
  const sidebarCollapsed = !sidebarOpen
  const [maximized, setMaximized] = useState(false)
  const { activeWorkspacePath } = useSessionState()
  const { createSession } = useSidebarData()
  const { projectName, chatTitle, scratch } = useTitlebarTrail()
  // The environment client mounts after the first paint; until then no
  // session is a subagent's.
  const hasEnvironment = useEnvironmentClientOptional() !== null

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
      <div
        className={cn(
          'titlebar-no-drag flex shrink-0 items-center gap-0.5 pr-2',
          sidebarCollapsed ? 'pl-3.5' : 'pl-1.5',
          isMac && sidebarCollapsed && 'pl-[76px]',
        )}
        data-sidebar-icons
      >
        <Tooltip
          content={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
          shortcut={isMac ? '⌘B' : 'Ctrl+B'}
          side="bottom"
        >
          <button
            type="button"
            onClick={toggleSidebar}
            className={titlebarIconBtnClass}
            aria-label={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
            aria-expanded={!sidebarCollapsed}
          >
            <SidebarSimpleIcon weight="light" className="h-[16px] w-[18px]" />
          </button>
        </Tooltip>
        {sidebarCollapsed && (
          <Tooltip content="New thread" side="bottom">
            <button
              type="button"
              onClick={handleNewSession}
              disabled={!activeWorkspacePath}
              className={titlebarIconBtnClass}
              aria-label="New thread"
            >
              <PlusIcon weight="light" className="h-[16px] w-[18px]" />
            </button>
          </Tooltip>
        )}
      </div>

      <div
        className="titlebar-drag flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2"
        title={fullTitle}
      >
        {projectName && activeWorkspacePath ? (
          <>
            <ProjectIcon
              workspacePath={activeWorkspacePath}
              scratch={scratch}
              fallbackIcon={FolderSimpleIcon}
              className="h-4 w-4 text-[var(--basis-text-faint)]"
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
        {hasEnvironment ? (
          <ChildAwareTitle chatTitle={chatTitle} />
        ) : (
          <TitleText>{chatTitle}</TitleText>
        )}
      </div>

      <div className="titlebar-no-drag flex shrink-0 items-stretch">
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
