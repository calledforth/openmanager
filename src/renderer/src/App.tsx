import { SessionProvider } from './stores/session-store'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { ChatView } from './components/ChatView'
import { MessageInput } from './components/MessageInput'
import { PermissionPrompt } from './components/PermissionPrompt'

function AppShell() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        backgroundColor: '#0f0f0f',
        color: '#e0e0e0',
        margin: 0,
        padding: 0,
      }}
    >
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div
          style={{
            width: '240px',
            borderRight: '1px solid #1f1f1f',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <WorkspaceSidebar />
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <ChatView />
          <MessageInput />
        </div>
      </div>
      <PermissionPrompt />
    </div>
  )
}

function App() {
  return (
    <SessionProvider>
      <AppShell />
    </SessionProvider>
  )
}

export default App
