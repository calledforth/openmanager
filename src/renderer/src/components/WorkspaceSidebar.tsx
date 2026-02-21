import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { useSessionStore, type WorkspaceEntry } from '../stores/session-store'

const statusColors: Record<string, string> = {
  idle: '#666',
  running: '#4ade80',
  busy: '#4ade80',
  waiting: '#fbbf24',
  retry: '#fbbf24',
  done: '#888',
  error: '#ef4444',
}

const sidecarDot: Record<string, string> = {
  disconnected: '#555',
  connecting: '#fbbf24',
  connected: '#4ade80',
}

export function WorkspaceSidebar() {
  const { workspaces, activeWorkspacePath, activeSessionId, addWorkspace, removeWorkspace } =
    useSessionStore()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid #1f1f1f',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: '#888',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          Workspaces
        </span>
        <button
          onClick={() => addWorkspace()}
          style={{
            background: '#1a1a2e',
            color: '#a0a0ff',
            border: '1px solid #2a2a4a',
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          + Add
        </button>
      </div>

      {/* Workspace tree */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {workspaces.length === 0 && (
          <div
            style={{
              padding: '20px 14px',
              color: '#444',
              fontSize: '12px',
              textAlign: 'center',
            }}
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
            onRemove={() => removeWorkspace(ws.path)}
          />
        ))}
      </div>
    </div>
  )
}

function WorkspaceGroup({
  workspace,
  isActiveWorkspace,
  activeSessionId,
  onRemove,
}: {
  workspace: WorkspaceEntry
  isActiveWorkspace: boolean
  activeSessionId: string | null
  onRemove: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const { selectSession, createSession, deleteSession } = useSessionStore()

  const rawSessions = useQuery(api.sessions.listByWorkspace, {
    workspacePath: workspace.path,
  })
  const sessions = (rawSessions ?? []).map((s) => ({
    externalId: s.externalId,
    title: s.title,
    status: s.status,
  }))

  return (
    <div style={{ borderBottom: '1px solid #141414' }}>
      {/* Workspace header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          padding: '8px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
          background: isActiveWorkspace ? '#131320' : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (!isActiveWorkspace)
            (e.currentTarget as HTMLDivElement).style.background = '#141414'
        }}
        onMouseLeave={(e) => {
          if (!isActiveWorkspace)
            (e.currentTarget as HTMLDivElement).style.background = 'transparent'
        }}
      >
        <span
          style={{
            fontSize: '10px',
            color: '#555',
            transition: 'transform 0.15s',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            display: 'inline-block',
          }}
        >
          ▼
        </span>
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: sidecarDot[workspace.sidecarStatus] ?? '#555',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: '13px',
            fontWeight: 500,
            color: isActiveWorkspace ? '#d4d4d4' : '#999',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={workspace.path}
        >
          {workspace.name}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{
            background: 'none',
            border: 'none',
            color: '#444',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '0 2px',
            opacity: 0.5,
          }}
          title="Remove workspace"
        >
          ×
        </button>
      </div>

      {/* Sessions */}
      {!collapsed && (
        <div style={{ paddingLeft: '12px' }}>
          {sessions.map((s) => {
            const isActive = isActiveWorkspace && s.externalId === activeSessionId
            return (
              <div
                key={s.externalId}
                onClick={() => selectSession(workspace.path, s.externalId)}
                style={{
                  padding: '6px 14px',
                  cursor: 'pointer',
                  background: isActive ? '#1a1a2e' : 'transparent',
                  borderLeft: isActive
                    ? '2px solid #5b5bf7'
                    : '2px solid transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => {
                  if (!isActive)
                    (e.currentTarget as HTMLDivElement).style.background = '#141414'
                }}
                onMouseLeave={(e) => {
                  if (!isActive)
                    (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span
                    style={{
                      fontSize: '12px',
                      color: isActive ? '#e0e0e0' : '#888',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {s.title || s.externalId.slice(0, 10)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteSession(workspace.path, s.externalId)
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#444',
                      cursor: 'pointer',
                      fontSize: '10px',
                      padding: '0 2px',
                      opacity: 0.5,
                    }}
                  >
                    ×
                  </button>
                </div>
                <div
                  style={{
                    fontSize: '10px',
                    color: statusColors[s.status] ?? '#555',
                    marginTop: '1px',
                  }}
                >
                  {s.status}
                </div>
              </div>
            )
          })}

          {/* New session button */}
          <div
            onClick={() => createSession(workspace.path)}
            style={{
              padding: '6px 14px',
              cursor: 'pointer',
              fontSize: '11px',
              color: '#555',
              transition: 'color 0.1s',
            }}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.color = '#a0a0ff'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.color = '#555'
            }}
          >
            + New Session
          </div>
        </div>
      )}
    </div>
  )
}
