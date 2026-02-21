import { useMemo } from 'react'
import { useSessionStore } from '../stores/session-store'

interface PermissionPayload {
  type: string
  permissionId: string
  toolName: string
  description: string
}

export function PermissionPrompt() {
  const { messages, activeSessionId, resolvePermission } = useSessionStore()

  const pendingPermission = useMemo(() => {
    for (const msg of messages) {
      if (msg.role !== 'permission') continue
      try {
        const payload: PermissionPayload = JSON.parse(msg.content)
        if (payload.type === 'permission_request') return payload
      } catch {
        continue
      }
    }
    return null
  }, [messages])

  if (!pendingPermission || !activeSessionId) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: '#1a1a1a',
          border: '1px solid #333',
          borderRadius: '12px',
          padding: '24px',
          maxWidth: '420px',
          width: '100%',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: '15px', color: '#fbbf24' }}>
          Permission Required
        </h3>
        <p style={{ margin: '0 0 4px', fontSize: '13px', color: '#aaa' }}>
          Tool: <strong style={{ color: '#ddd' }}>{pendingPermission.toolName}</strong>
        </p>
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: '#888' }}>
          {pendingPermission.description}
        </p>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={() =>
              resolvePermission(activeSessionId, pendingPermission.permissionId, false)
            }
            style={{
              background: '#333',
              color: '#ddd',
              border: 'none',
              borderRadius: '6px',
              padding: '8px 16px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Deny
          </button>
          <button
            onClick={() =>
              resolvePermission(activeSessionId, pendingPermission.permissionId, true)
            }
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '8px 16px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
