import {
  MessageSquare,
  Plus,
  SquarePen,
  ChevronDown,
  Archive,
  Trash2,
  PanelLeftClose,
  PanelLeft,
  Sun,
  Moon,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useTheme } from '../../providers/theme-provider'
import { typographyBodySm, typographyCaption, typographyLabel } from '../../lib/typography'

export interface SidebarWorkspace {
  path: string
  name: string
  sessions: Array<{ externalId: string; title?: string; status: string }>
}

const dot: Record<string, string> = {
  stopped: 'bg-[hsl(0_0%_33%)]',
  starting: 'bg-neutral-400',
  healthy: 'bg-neutral-200',
  unhealthy: 'bg-red-400',
  crashed: 'bg-red-400',
}

export function WorkspaceSidebarView({
  collapsed,
  onToggle,
  workspaces,
  activeWorkspacePath,
  activeSessionId,
  collapsedWorkspacePaths,
  onToggleWorkspaceCollapse,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onRemoveWorkspace,
  onAddWorkspace,
  openCodeStatus,
  openCodeUiStatus,
  onRetryOpenCode,
}: {
  collapsed: boolean
  onToggle: () => void
  workspaces: SidebarWorkspace[]
  activeWorkspacePath: string | null
  activeSessionId: string | null
  collapsedWorkspacePaths: string[]
  onToggleWorkspaceCollapse: (path: string) => void
  onCreateSession: (workspacePath: string) => void
  onSelectSession: (workspacePath: string, externalId: string) => void
  onDeleteSession: (workspacePath: string, externalId: string) => void
  onRemoveWorkspace: (path: string) => void
  onAddWorkspace: () => void
  openCodeStatus: string
  openCodeUiStatus: 'disconnected' | 'connecting' | 'connected'
  onRetryOpenCode: () => void
}) {
  const collapsedSet = new Set(collapsedWorkspacePaths)
  const { theme, toggleTheme } = useTheme()

  if (collapsed) {
    return (
      <aside className="flex h-full w-[48px] shrink-0 flex-col items-center overflow-hidden bg-transparent py-3 transition-[width] duration-300 ease-in-out">
        <button
          onClick={onToggle}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
          title="Expand sidebar"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      </aside>
    )
  }

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col overflow-hidden border-r border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] py-2 transition-[width] duration-300 ease-in-out">
      {/* Header */}
      <div className="flex h-8 items-center justify-between px-3">
        <span className={`${typographyLabel} text-[var(--basis-text-strong)]`}>Home</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onToggle}
            className="rounded-md p-1.5 text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            onClick={() => activeWorkspacePath && onCreateSession(activeWorkspacePath)}
            disabled={!activeWorkspacePath}
            className="rounded-md p-1.5 text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground disabled:opacity-30"
            title="New thread"
          >
            <SquarePen className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Status badge */}
      <button
        onClick={() => {
          if (openCodeUiStatus !== 'connected') onRetryOpenCode()
        }}
        className={cn(
          'mx-3 mb-2 flex items-center gap-2 rounded-[var(--basis-chat-shell-radius)] border px-2 py-1.5 transition-default',
          typographyCaption,
          openCodeUiStatus === 'connected'
            ? 'border-[var(--basis-border)] bg-[var(--basis-surface)] text-[var(--basis-text)]'
            : openCodeUiStatus === 'connecting'
              ? 'border-[var(--basis-border)] bg-[var(--basis-surface-elevated)] text-[var(--basis-text-muted)]'
              : 'border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/15',
        )}
        title={
          openCodeUiStatus === 'connected' ? 'OpenCode connected' : 'Retry OpenCode connection'
        }
      >
        <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dot[openCodeStatus] ?? dot.stopped)} />
        <span className="flex-1 text-left">
          {openCodeUiStatus === 'connected'
            ? 'OpenCode ACP connected'
            : openCodeUiStatus === 'connecting'
              ? 'Connecting OpenCode...'
              : 'OpenCode unavailable - click to retry'}
        </span>
      </button>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {workspaces.length === 0 && (
          <div className="px-3 py-5 text-center text-13-regular text-muted-foreground">
            No workspaces yet
          </div>
        )}
        {workspaces.map((ws) => (
          <WorkspaceGroup
            key={ws.path}
            workspace={ws}
            isActiveWorkspace={ws.path === activeWorkspacePath}
            activeSessionId={activeSessionId}
            isCollapsed={collapsedSet.has(ws.path)}
            onToggleCollapse={() => onToggleWorkspaceCollapse(ws.path)}
            onSelectSession={onSelectSession}
            onCreateSession={onCreateSession}
            onDeleteSession={onDeleteSession}
            onRemove={() => onRemoveWorkspace(ws.path)}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="space-y-0.5 px-2 py-2">
        <button
          onClick={toggleTheme}
          className={`flex w-full items-center gap-2 rounded-[var(--basis-chat-shell-radius)] px-2 py-1.5 ${typographyBodySm} text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]`}
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <button
          onClick={onAddWorkspace}
          className={`flex w-full items-center gap-2 rounded-[var(--basis-chat-shell-radius)] px-2 py-1.5 ${typographyBodySm} text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]`}
        >
          <Archive className="h-3.5 w-3.5" />
          <span>Add repository</span>
        </button>
      </div>
    </aside>
  )
}

function WorkspaceGroup({
  workspace,
  isActiveWorkspace,
  activeSessionId,
  isCollapsed,
  onToggleCollapse,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onRemove,
}: {
  workspace: SidebarWorkspace
  isActiveWorkspace: boolean
  activeSessionId: string | null
  isCollapsed: boolean
  onToggleCollapse: () => void
  onSelectSession: (workspacePath: string, externalId: string) => void
  onCreateSession: (workspacePath: string) => void
  onDeleteSession: (workspacePath: string, externalId: string) => void
  onRemove: () => void
}) {
  return (
    <div className="mb-1">
      {/* Workspace header row */}
      <button
        onClick={onToggleCollapse}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-13-medium text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
      >
        <ChevronDown
          className={cn('h-3 w-3 shrink-0 transition-transform duration-150', isCollapsed && '-rotate-90')}
        />
        <span className="flex-1 truncate text-left">{workspace.name}</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="rounded p-0.5 text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground transition-default"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </button>

      {!isCollapsed && (
        <div className="ml-1">
          {/* New session row */}
          <button
            onClick={() => onCreateSession(workspace.path)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1 text-12-regular text-muted-foreground/60 transition-default hover:bg-surface-hover hover:text-foreground"
          >
            <Plus className="h-3 w-3 shrink-0" />
            <span>New session</span>
          </button>

          {/* Session rows */}
          {workspace.sessions.map((s) => {
            const isActive = isActiveWorkspace && s.externalId === activeSessionId
            return (
              <button
                key={s.externalId}
                onClick={() => onSelectSession(workspace.path, s.externalId)}
                className={cn(
                  'group flex w-full items-center gap-2 rounded-md px-2.5 py-1 mb-[1px] text-left transition-default',
                  isActive
                    ? 'bg-surface-active text-foreground'
                    : 'text-sidebar-foreground hover:bg-surface-hover hover:text-foreground',
                )}
              >
                {s.status === 'running' || s.status === 'busy' || s.status === 'waiting' ? (
                  <span className="custom-loader text-primary shrink-0 !w-3 !h-3 !border-2" />
                ) : (
                  <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                )}
                <span className="flex-1 truncate text-12-regular">
                  {s.title || s.externalId.slice(0, 10)}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteSession(workspace.path, s.externalId)
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground/30 opacity-0 transition-default group-hover:opacity-100 hover:text-red-400 hover:bg-red-400/10"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
