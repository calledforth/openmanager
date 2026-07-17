import { MessageSquare, Plus, ChevronDown, FolderPlus, Trash2 } from 'lucide-react'
import type { ProviderId } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { typographyBodySm, typographyCaption } from '../../lib/typography'
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
        'flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--basis-border-muted)] bg-[var(--basis-sidebar-bg)] transition-[width] duration-300 ease-in-out',
        collapsed ? 'w-0 border-r-0' : 'w-[var(--basis-sidebar-width)]',
      )}
      aria-hidden={collapsed}
    >
      <div className={cn('flex min-h-0 flex-1 flex-col', collapsed && 'invisible')}>
        <div className="border-b border-[var(--basis-border-muted)] px-2 py-2">
          <button
            type="button"
            onClick={onAddWorkspace}
            className={cn(
              typographyBodySm,
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
            )}
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span>Add repository</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-1.5 py-2">
          {workspaces.length === 0 && (
            <div
              className={cn(
                typographyCaption,
                'px-3 py-8 text-center text-[var(--basis-text-faint)]',
              )}
            >
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

        <div className="flex items-center justify-between border-t border-[var(--basis-border-muted)] bg-[var(--basis-titlebar-bg)] px-2 py-1.5">
          <span className={cn(typographyCaption, 'px-1 text-[var(--basis-text-faint)]')}>
            Preferences
          </span>
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
    <div className="mb-2">
      <div className="group flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]">
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
            strokeWidth={1.75}
          />
          <span className={cn(typographyBodySm, 'flex-1 truncate text-left font-medium')}>
            {workspace.name}
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="rounded p-0.5 text-[var(--basis-text-faint)] opacity-0 transition-default group-hover:opacity-100 hover:text-[var(--basis-text)]"
          aria-label={`Remove ${workspace.name}`}
        >
          <Trash2 className="h-3 w-3" strokeWidth={1.75} />
        </button>
      </div>

      {!isCollapsed && (
        <div className="ml-0.5 mt-0.5 space-y-px border-l border-[var(--basis-border-muted)] pl-1.5">
          <button
            type="button"
            onClick={() => onCreateSession(workspace.path)}
            className={cn(
              typographyCaption,
              'flex w-full items-center gap-2 rounded-md px-2 py-1 text-[var(--basis-text-faint)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
            )}
          >
            <Plus className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span>New session</span>
          </button>

          {workspace.sessions.map((s) => {
            const isActive = isActiveWorkspace && s.externalId === activeSessionId
            const providerId = s.providerId ?? 'opencode'
            return (
              <button
                key={s.externalId}
                type="button"
                onClick={() => onSelectSession(workspace.path, s.externalId, providerId)}
                className={cn(
                  'group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-default',
                  isActive
                    ? 'bg-[var(--basis-tab-active-bg)] text-[var(--basis-text-strong)]'
                    : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
                )}
              >
                {s.status === 'running' || s.status === 'busy' || s.status === 'waiting' ? (
                  <span className="custom-loader shrink-0 !h-3 !w-3 !border-2 text-[var(--basis-text)]" />
                ) : (
                  <MessageSquare
                    className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                    strokeWidth={1.75}
                  />
                )}
                <span className={cn(typographyCaption, 'min-w-0 flex-1 truncate')}>
                  {s.title || s.externalId.slice(0, 10)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteSession(workspace.path, s.externalId, providerId)
                  }}
                  className="shrink-0 rounded p-0.5 text-[var(--basis-text-faint)] opacity-0 transition-default group-hover:opacity-100 hover:bg-red-400/10 hover:text-red-400"
                  aria-label="Delete session"
                >
                  <Trash2 className="h-3 w-3" strokeWidth={1.75} />
                </button>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
