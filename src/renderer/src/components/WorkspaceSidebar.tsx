import { useState } from 'react'
import { MessageSquare, Plus, SquarePen, ChevronDown, Archive, Trash2, PanelLeftClose, PanelLeft, Loader2 } from 'lucide-react'
import { useSidebarData, type WorkspaceEntry } from '../providers/sidebar-data-provider'
import { cn } from '../lib/utils'

const sidecarDot: Record<string, string> = {
  disconnected: 'bg-[hsl(0_0%_33%)]',
  connecting: 'bg-amber-400',
  connected: 'bg-emerald-400',
}

const statusLabel: Record<string, string> = {
  idle: 'text-muted-foreground',
  running: 'text-emerald-400',
  busy: 'text-emerald-400',
  waiting: 'text-amber-400',
  retry: 'text-amber-400',
  done: 'text-muted-foreground',
  error: 'text-red-400',
}

export function WorkspaceSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
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
  selectSession,
  createSession,
  deleteSession,
  onRemove,
}: {
  workspace: WorkspaceEntry
  sessions: Array<{ externalId: string; title?: string; status: string }>
  isActiveWorkspace: boolean
  activeSessionId: string | null
  selectSession: (workspacePath: string, externalId: string) => void
  createSession: (workspacePath: string) => Promise<void>
  deleteSession: (workspacePath: string, externalId: string) => Promise<void>
  onRemove: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="mb-1">
      {/* Group header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform duration-150',
            collapsed && '-rotate-90'
          )}
        />
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            sidecarDot[workspace.sidecarStatus] ?? 'bg-[hsl(0_0%_33%)]'
          )}
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
      {!collapsed && (
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
                  'group flex w-full items-center gap-2 rounded-md px-3 py-1 text-left transition-default',
                  isActive
                    ? 'bg-surface-active text-foreground'
                    : 'text-sidebar-foreground hover:bg-surface-hover hover:text-foreground'
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
