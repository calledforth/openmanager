import { MessageSquare, Plus, ChevronDown, FolderPlus, Trash2 } from 'lucide-react'
import type { ProviderId } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { typographyBodySm } from '../../lib/typography'
import { SidebarSettingsMenu } from './SidebarSettingsMenu'

export interface SidebarWorkspace {
  path: string
  name: string
  sessions: Array<{
    externalId: string
    title?: string
    status: string
    providerId?: ProviderId
  }>
}

export function WorkspaceSidebarView({
  collapsed,
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
}: {
  collapsed: boolean
  workspaces: SidebarWorkspace[]
  activeWorkspacePath: string | null
  activeSessionId: string | null
  collapsedWorkspacePaths: string[]
  onToggleWorkspaceCollapse: (path: string) => void
  onCreateSession: (workspacePath: string) => void
  onSelectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onDeleteSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onRemoveWorkspace: (path: string) => void
  onAddWorkspace: () => void
}) {
  const collapsedSet = new Set(collapsedWorkspacePaths)

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] transition-[width] duration-300 ease-in-out',
        collapsed ? 'w-0 border-r-0' : 'w-[var(--basis-sidebar-width)]',
      )}
      aria-hidden={collapsed}
    >
      <div className={cn('flex min-h-0 flex-1 flex-col py-1.5', collapsed && 'invisible')}>
        <div className="px-2 pb-2">
          <button
            type="button"
            onClick={onAddWorkspace}
            className={cn(
              typographyBodySm,
              'flex w-full items-center gap-2 rounded-[var(--basis-chat-shell-radius)] px-2 py-1.5 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
            )}
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span>Add repository</span>
          </button>
        </div>

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
        <div className="flex items-center justify-end border-t border-[var(--basis-border-muted)] px-2 py-1.5">
          <SidebarSettingsMenu />
        </div>
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
  onSelectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onCreateSession: (workspacePath: string) => void
  onDeleteSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onRemove: () => void
}) {
  return (
    <div className="mb-1">
      {/* Workspace header row */}
      <div className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-13-medium text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex min-w-0 flex-1 items-center gap-1.5"
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 transition-transform duration-150',
              isCollapsed && '-rotate-90',
            )}
          />
          <span className="flex-1 truncate text-left">{workspace.name}</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="rounded p-0.5 text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground transition-default"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

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
            const providerId = s.providerId ?? 'opencode'
            return (
              <button
                key={s.externalId}
                onClick={() => onSelectSession(workspace.path, s.externalId, providerId)}
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
                    onDeleteSession(workspace.path, s.externalId, providerId)
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
