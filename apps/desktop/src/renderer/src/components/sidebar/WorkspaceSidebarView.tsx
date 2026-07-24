import { useEffect, useMemo, useState } from 'react'
import {
  PlusIcon,
  CaretDoubleLeftIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  FolderOpenIcon,
  TrashIcon,
  NotePencilIcon,
  GitBranchIcon,
} from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { typographyBodySm, typographyLabel } from '../../lib/typography'
import { ProviderIcon } from '../providers/ProviderIcon'
import { SidebarSettingsMenu } from './SidebarSettingsMenu'

const SESSION_PREVIEW_LIMIT = 5
const SESSION_PAGE_SIZE = 10

export interface SidebarSession {
  externalId: string
  title?: string
  status: string
  providerId?: ProviderId
  parentExternalId?: string
}

export interface SidebarWorkspace {
  path: string
  name: string
  sessions: SidebarSession[]
}

export interface SidebarSessionRow {
  session: SidebarSession
  depth: number
  isChild: boolean
  isOrphan: boolean
}

/** Preserve recency order within each level while placing child transcripts
 * directly beneath their parent. Missing parents and cycles remain visible. */
export function flattenSidebarSessions(sessions: SidebarSession[]): SidebarSessionRow[] {
  const byId = new Map(sessions.map((session) => [session.externalId, session]))
  const children = new Map<string, SidebarSession[]>()
  const roots: SidebarSession[] = []
  for (const session of sessions) {
    if (session.parentExternalId && byId.has(session.parentExternalId)) {
      const siblings = children.get(session.parentExternalId) ?? []
      siblings.push(session)
      children.set(session.parentExternalId, siblings)
    } else {
      roots.push(session)
    }
  }

  const rows: SidebarSessionRow[] = []
  const visited = new Set<string>()
  const visit = (session: SidebarSession, depth: number, isOrphan: boolean) => {
    if (visited.has(session.externalId)) return
    visited.add(session.externalId)
    rows.push({
      session,
      depth,
      isChild: !!session.parentExternalId,
      isOrphan,
    })
    for (const child of children.get(session.externalId) ?? []) {
      visit(child, depth + 1, false)
    }
  }

  for (const root of roots) {
    visit(root, 0, !!root.parentExternalId)
  }
  for (const session of sessions) {
    if (!visited.has(session.externalId)) visit(session, 0, true)
  }
  return rows
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
              'flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[var(--basis-text)] transition-default hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <NotePencilIcon className="h-3.5 w-3.5 shrink-0" weight="regular" />
            <span>New Agent</span>
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
  const [visibleCount, setVisibleCount] = useState(SESSION_PREVIEW_LIMIT)
  const FolderIcon = isCollapsed ? FolderSimpleIcon : FolderOpenIcon
  const orderedSessions = useMemo(
    () => flattenSidebarSessions(workspace.sessions),
    [workspace.sessions],
  )
  const hasMoreSessions = orderedSessions.length > visibleCount
  const visibleSessions = orderedSessions.slice(0, visibleCount)

  useEffect(() => {
    if (!isActiveWorkspace || !activeSessionId) return
    const activeIndex = orderedSessions.findIndex(
      ({ session }) => session.externalId === activeSessionId,
    )
    if (activeIndex >= 0) {
      setVisibleCount((count) => Math.max(count, activeIndex + 1))
    }
  }, [isActiveWorkspace, activeSessionId, orderedSessions])

  return (
    <div className="mb-0">
      {/* Project header row */}
      <div
        className={cn(
          typographyBodySm,
          'group flex w-full items-center gap-1 rounded-md px-2 py-0.5 font-medium text-[color-mix(in_srgb,var(--basis-text)_72%,var(--basis-text-muted))] transition-default hover:bg-surface-hover hover:text-[var(--basis-text)]',
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
          title="New Agent"
          aria-label="New Agent"
          className="flex h-5 w-0 shrink-0 items-center justify-center overflow-hidden rounded text-[var(--basis-text-muted)] opacity-0 transition-[width,opacity] group-hover:w-5 group-hover:opacity-100 hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]"
        >
          <PlusIcon className="h-3.5 w-3.5" weight="bold" />
        </button>
      </div>

      {!isCollapsed && (
        <div className="ml-1">
          {visibleSessions.map(({ session: s, depth, isChild, isOrphan }) => {
            const isActive = isActiveWorkspace && s.externalId === activeSessionId
            const providerId = s.providerId ?? 'opencode'
            const isBusy = s.status === 'running' || s.status === 'busy' || s.status === 'waiting'
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
                style={{ paddingLeft: `${10 + Math.min(depth, 4) * 14}px` }}
              >
                {isChild ? (
                  <GitBranchIcon
                    className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                    weight="regular"
                  />
                ) : (
                  <ProviderIcon providerId={providerId} className="h-3 w-3 opacity-70" />
                )}
                <span className={cn(typographyLabel, 'flex-1 truncate font-normal')}>
                  {s.title || 'New session'}
                </span>
                {isChild && !isBusy ? (
                  <span
                    className="shrink-0 rounded-sm border border-[var(--basis-border-muted)] px-1 py-px text-[9px] leading-none tracking-wide text-[var(--basis-text-faint)]"
                    title={
                      isOrphan ? 'Subagent transcript (parent unavailable)' : 'Subagent transcript'
                    }
                  >
                    {isOrphan ? 'ORPHAN' : 'SUBAGENT'}
                  </span>
                ) : null}
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
          {hasMoreSessions && (
            <button
              type="button"
              onClick={() =>
                setVisibleCount((count) =>
                  Math.min(count + SESSION_PAGE_SIZE, orderedSessions.length),
                )
              }
              className={cn(
                typographyLabel,
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left font-normal text-[var(--basis-text-muted)] transition-default hover:bg-surface-hover hover:text-[var(--basis-text)]',
              )}
            >
              <span className="h-3 w-3 shrink-0" aria-hidden />
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  )
}
