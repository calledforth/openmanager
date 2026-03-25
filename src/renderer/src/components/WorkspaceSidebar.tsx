import { useState, useEffect, useCallback } from 'react'
import {
  MessageSquare,
  Plus,
  SquarePen,
  ChevronDown,
  Archive,
  Trash2,
  PanelLeftClose,
  PanelLeft,
  Loader2,
} from 'lucide-react'
import { useSidebarData, type WorkspaceEntry } from '../providers/sidebar-data-provider'
import { useAppUi } from '../providers/app-ui-provider'
import { cn } from '../lib/utils'

const openCodeDot: Record<string, string> = {
  stopped: 'bg-[hsl(0_0%_33%)]',
  starting: 'bg-amber-400',
  healthy: 'bg-emerald-400',
  unhealthy: 'bg-red-400',
  crashed: 'bg-red-400',
}

export function WorkspaceSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const {
    workspaces,
    sessionsByWorkspace,
    activeWorkspacePath,
    activeSessionId,
    addWorkspace,
    removeWorkspace,
    selectSession,
    createSession,
    deleteSession,
  } = useSidebarData()
  const { openCodeStatus, openCodeUiStatus, retryOpenCode } = useAppUi()

  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(new Set())

  // Load persisted collapsed workspaces on mount
  useEffect(() => {
    window.electronAPI
      .getCollapsedWorkspaces()
      .then((paths) => {
        setCollapsedSet(new Set(paths))
      })
      .catch(() => {})
  }, [])

  const toggleWorkspaceCollapse = useCallback((path: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      // Persist to electron-store
      window.electronAPI.setCollapsedWorkspaces([...next]).catch(() => {})
      return next
    })
  }, [])

  if (collapsed) {
    return (
      <aside className="flex h-full w-[48px] flex-col items-center bg-sidebar py-3 shrink-0">
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
    <aside className="flex h-full w-[260px] flex-col bg-sidebar shrink-0">
      {/* Header */}
      <div className="flex h-12 items-center justify-between px-3">
        <span className="text-sm font-medium text-sidebar-primary">Home</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onToggle}
            className="rounded-md p-1.5 text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            onClick={() => activeWorkspacePath && createSession(activeWorkspacePath)}
            disabled={!activeWorkspacePath}
            className="rounded-md p-1.5 text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground disabled:opacity-30"
            title="New thread"
          >
            <SquarePen className="h-4 w-4" />
          </button>
        </div>
      </div>

      <button
        onClick={() => {
          if (openCodeUiStatus !== 'connected') void retryOpenCode()
        }}
        className={cn(
          'mx-3 mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11px] transition-default',
          openCodeUiStatus === 'connected'
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
            : openCodeUiStatus === 'connecting'
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              : 'border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/15',
        )}
        title={
          openCodeUiStatus === 'connected' ? 'OpenCode connected' : 'Retry OpenCode connection'
        }
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            openCodeDot[openCodeStatus] ?? openCodeDot.stopped,
          )}
        />
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
          <div className="px-3 py-5 text-center text-xs text-muted-foreground">
            No workspaces yet
          </div>
        )}
        {workspaces.map((ws) => (
          <WorkspaceGroup
            key={ws.path}
            workspace={ws}
            sessions={sessionsByWorkspace[ws.path] ?? []}
            isActiveWorkspace={ws.path === activeWorkspacePath}
            activeSessionId={activeSessionId}
            isCollapsed={collapsedSet.has(ws.path)}
            onToggleCollapse={() => toggleWorkspaceCollapse(ws.path)}
            selectSession={selectSession}
            createSession={createSession}
            deleteSession={deleteSession}
            onRemove={() => removeWorkspace(ws.path)}
          />
        ))}
      </div>

      {/* Bottom actions */}
      <div className="px-2 py-2">
        <button
          onClick={() => addWorkspace()}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
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
  sessions,
  isActiveWorkspace,
  activeSessionId,
  isCollapsed,
  onToggleCollapse,
  selectSession,
  createSession,
  deleteSession,
  onRemove,
}: {
  workspace: WorkspaceEntry
  sessions: Array<{ externalId: string; title?: string; status: string }>
  isActiveWorkspace: boolean
  activeSessionId: string | null
  isCollapsed: boolean
  onToggleCollapse: () => void
  selectSession: (workspacePath: string, externalId: string) => void
  createSession: (workspacePath: string) => Promise<void>
  deleteSession: (workspacePath: string, externalId: string) => Promise<void>
  onRemove: () => void
}) {
  return (
    <div className="mb-1">
      {/* Group header */}
      <button
        onClick={onToggleCollapse}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
      >
        <ChevronDown
          className={cn('h-3 w-3 transition-transform duration-150', isCollapsed && '-rotate-90')}
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

      {/* Items */}
      {!isCollapsed && (
        <div className="ml-1">
          {/* New session button */}
          <button
            onClick={() => createSession(workspace.path)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1 text-xs text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            <span>New session</span>
          </button>

          {sessions.map((s) => {
            const isActive = isActiveWorkspace && s.externalId === activeSessionId
            return (
              <button
                key={s.externalId}
                onClick={() => selectSession(workspace.path, s.externalId)}
                className={cn(
                  'group flex w-full items-center gap-2 rounded-md px-2.5 py-1 mb-[2px] text-left transition-default',
                  isActive
                    ? 'bg-surface-active text-foreground'
                    : 'text-sidebar-foreground hover:bg-surface-hover hover:text-foreground',
                )}
              >
                {s.status === 'running' || s.status === 'busy' || s.status === 'waiting' ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                ) : (
                  <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                )}
                <span className="flex-1 truncate text-[13px]">
                  {s.title || s.externalId.slice(0, 10)}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteSession(workspace.path, s.externalId)
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
