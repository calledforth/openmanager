import {
  PlusIcon,
  CaretDoubleLeftIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  FolderOpenIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { typographyBodySm, typographyLabel } from '../../lib/typography'
import { ProviderIcon } from '../providers/ProviderIcon'
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
  onCollapse,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onAddWorkspace,
}: {
  collapsed: boolean
  workspaces: SidebarWorkspace[]
  activeWorkspacePath: string | null
  activeSessionId: string | null
  collapsedWorkspacePaths: string[]
  onToggleWorkspaceCollapse: (path: string) => void
  onCollapse?: () => void
  onCreateSession: (workspacePath: string) => void
  onSelectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onDeleteSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onAddWorkspace: () => void
}) {
  const collapsedSet = new Set(collapsedWorkspacePaths)
  const newThreadTarget = activeWorkspacePath ?? workspaces[0]?.path ?? null

  return (
    <aside
      className={cn(
        'group/sidebar relative flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] transition-[width] duration-300 ease-in-out',
        collapsed ? 'w-0 border-r-0' : 'w-[var(--basis-sidebar-width)]',
      )}
      aria-hidden={collapsed}
    >
      <div className={cn('flex min-h-0 flex-1 flex-col', collapsed && 'invisible')}>
        <div className="relative flex h-[var(--basis-titlebar-height)] shrink-0 items-center justify-end px-1.5">
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              title="Close sidebar"
              aria-label="Close sidebar"
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--basis-text-strong)] opacity-0 transition-default hover:bg-[color-mix(in_srgb,var(--basis-text-strong)_14%,transparent)] group-hover/sidebar:opacity-100 focus-visible:opacity-100"
            >
              <CaretDoubleLeftIcon weight="light" className="h-[16px] w-[18px]" />
            </button>
          )}
        </div>

        <div className="px-1.5 pb-1">
          <button
            type="button"
            disabled={!newThreadTarget}
            onClick={() => {
              if (newThreadTarget) onCreateSession(newThreadTarget)
            }}
            className={cn(
              typographyBodySm,
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[var(--basis-text)] transition-default hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <PlusIcon className="h-3.5 w-3.5 shrink-0" weight="bold" />
            <span>New Thread</span>
          </button>
        </div>

        <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
          <span className={cn(typographyBodySm, 'min-w-0 flex-1 text-[var(--basis-text-muted)]')}>
            Projects
          </span>
          <button
            type="button"
            onClick={onAddWorkspace}
            title="Add project"
            aria-label="Add project"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]"
          >
            <FolderPlusIcon className="h-5 w-5" weight="regular" />
          </button>
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto px-1.5 pb-3">
          {workspaces.length === 0 && (
            <div className={cn(typographyBodySm, 'px-3 py-5 text-center text-muted-foreground')}>
              No projects yet
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
}: {
  workspace: SidebarWorkspace
  isActiveWorkspace: boolean
  activeSessionId: string | null
  isCollapsed: boolean
  onToggleCollapse: () => void
  onSelectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  onCreateSession: (workspacePath: string) => void
  onDeleteSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
}) {
  const FolderIcon = isCollapsed ? FolderSimpleIcon : FolderOpenIcon

  return (
    <div className="mb-1">
      {/* Project header row */}
      <div
        className={cn(
          typographyBodySm,
          'group flex w-full items-center gap-1 rounded-md px-2 py-1 font-medium text-[var(--basis-text-muted)] transition-default hover:bg-surface-hover hover:text-[var(--basis-text)]',
        )}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex min-w-0 flex-1 items-center gap-1.5"
        >
          <FolderIcon className="h-3.5 w-3.5 shrink-0" weight="regular" />
          <span className="flex-1 truncate text-left">{workspace.name}</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onCreateSession(workspace.path)
          }}
          title="New Thread"
          aria-label="New Thread"
          className="flex h-5 w-0 shrink-0 items-center justify-center overflow-hidden rounded text-[var(--basis-text-muted)] opacity-0 transition-[width,opacity] group-hover:w-5 group-hover:opacity-100 hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]"
        >
          <PlusIcon className="h-3.5 w-3.5" weight="bold" />
        </button>
      </div>

      {!isCollapsed && (
        <div className="ml-1">
          {workspace.sessions.map((s) => {
            const isActive = isActiveWorkspace && s.externalId === activeSessionId
            const providerId = s.providerId ?? 'opencode'
            const isBusy =
              s.status === 'running' || s.status === 'busy' || s.status === 'waiting'
            return (
              <button
                key={s.externalId}
                onClick={() => onSelectSession(workspace.path, s.externalId, providerId)}
                className={cn(
                  'group flex w-full items-center gap-2 rounded-md px-2.5 py-1 mb-[1px] text-left transition-default',
                  isActive
                    ? 'bg-surface-active text-[var(--basis-text)]'
                    : 'text-[var(--basis-text)] hover:bg-surface-hover',
                )}
              >
                <ProviderIcon providerId={providerId} className="h-3 w-3 opacity-70" />
                <span className={cn(typographyLabel, 'flex-1 truncate font-normal')}>
                  {s.title || s.externalId.slice(0, 10)}
                </span>
                <span
                  className={cn(
                    'relative flex h-4 shrink-0 items-center justify-center overflow-hidden transition-[width]',
                    isBusy ? 'w-4' : 'w-0 group-hover:w-4',
                  )}
                >
                  {isBusy && (
                    <span className="custom-loader shrink-0 !h-3 !w-3 !border-2 text-[var(--basis-text)] transition-opacity group-hover:opacity-0" />
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteSession(workspace.path, s.externalId, providerId)
                    }}
                    className="absolute inset-0 flex items-center justify-center rounded text-muted-foreground opacity-0 transition-default group-hover:opacity-100 hover:bg-red-400/10 hover:text-red-400"
                    aria-label="Delete session"
                  >
                    <TrashIcon className="h-3 w-3" />
                  </button>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
