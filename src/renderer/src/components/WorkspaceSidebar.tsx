import { useState } from 'react'
import { Hash, Plus, Settings, ChevronDown, Archive, X } from 'lucide-react'
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

export function WorkspaceSidebar() {
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

  return (
    <aside className="flex h-full w-[260px] flex-col border-r border-border bg-sidebar">
      {/* Header */}
      <div className="flex h-12 items-center justify-between px-3">
        <span className="text-sm font-medium text-sidebar-primary">Home</span>
        <button className="rounded-md p-1 text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground">
          <Settings className="h-4 w-4" />
        </button>
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
      <div className="border-t border-border px-2 py-2">
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
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-default hover:bg-surface-hover hover:text-foreground"
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
          <X className="h-3 w-3" />
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
                  'group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-default',
                  isActive
                    ? 'bg-surface-active text-foreground'
                    : 'text-sidebar-foreground hover:bg-surface-hover hover:text-foreground'
                )}
              >
                <Hash className="h-3 w-3 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px]">
                    {s.title || s.externalId.slice(0, 10)}
                  </span>
                  <span className={cn(
                    'truncate text-[11px]',
                    statusLabel[s.status] ?? 'text-muted-foreground'
                  )}>
                    {s.status}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteSession(workspace.path, s.externalId)
                  }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-default group-hover:opacity-100 hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
