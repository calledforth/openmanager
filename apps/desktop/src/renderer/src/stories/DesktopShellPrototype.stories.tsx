import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { PanelLeft, SquarePen } from 'lucide-react'
import { ThemeProvider } from '../providers/theme-provider'
import { AppUiProvider } from '../providers/app-ui-provider'
import { AppChrome } from '../components/shell/AppChrome'
import { WorkspaceSidebarView } from '../components/sidebar/WorkspaceSidebarView'
import { ChatViewPanel, UserMessage, AssistantMessage } from '../components/chat/ChatViewPrimitives'
import { MessageInputView } from '../components/chat/MessageInputView'
import { FloatingChatComposer } from '../components/chat/FloatingChatComposer'
import { cn } from '../lib/utils'
import { typographyCaption, typographyTitle } from '../lib/typography'

const meta = {
  title: 'App/DesktopShellPrototype',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj

const storyConvex = new ConvexReactClient('https://example.convex.cloud')

function ensureElectronMock() {
  if (typeof window === 'undefined') return
  if (window.electronAPI) return

  const noop = async () => undefined
  const emptyCleanup = () => () => undefined

  // Minimal browser mock so chrome/settings stories render outside Electron.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).electronAPI = {
    platform: 'linux',
    minimizeWindow: noop,
    maximizeWindow: noop,
    closeWindow: noop,
    isWindowMaximized: async () => false,
    onWindowMaximizedChanged: emptyCleanup,
    getClientId: async () => 'storybook-client',
    getRuntimeConfig: async () => ({
      convexUrl: 'https://example.convex.cloud',
      convexSource: 'settings',
      environmentUrlAvailable: false,
    }),
    testConvexUrl: async () => ({ ok: true, normalizedUrl: 'https://example.convex.cloud' }),
    setConvexUrlAndRestart: async () => ({ ok: true }),
    getTelemetrySnapshot: async () => ({ filePath: '', events: [] }),
    clearTelemetry: noop,
    recordTelemetry: noop,
    ensureAgentProvider: async () => ({
      providerId: 'opencode',
      agentInfo: { name: 'OpenCode', version: '1.7.0' },
      promptCapabilities: {},
    }),
    getAgentStatuses: async () => ({ opencode: 'healthy' }),
    getAgentPromptCapabilities: async () => ({}),
    getAgentProviders: async () => [
      {
        id: 'opencode',
        displayName: 'OpenCode',
        capabilities: { loadSession: true, imageInput: true },
      },
      {
        id: 'cursor',
        displayName: 'Cursor',
        capabilities: { loadSession: true, imageInput: true },
      },
    ],
    getModelImageSupport: async () => true,
    loadAcpSession: async () => ({ ok: true }),
    selectFolder: async () => null,
    getCollapsedWorkspaces: async () => [],
    setCollapsedWorkspaces: noop,
    getLastProviderId: async () => 'opencode',
    setLastProviderId: noop,
    onAgentStatusChanged: emptyCleanup,
    onStreamToken: emptyCleanup,
    onTelemetryUpdate: emptyCleanup,
    onAcpEvent: emptyCleanup,
  }
}

function StoryProviders({ children }: { children: ReactNode }) {
  ensureElectronMock()
  return (
    <ConvexProvider client={storyConvex}>
      <ThemeProvider>
        <AppUiProvider>{children}</AppUiProvider>
      </ThemeProvider>
    </ConvexProvider>
  )
}

function ShellHeader({
  sidebarCollapsed,
  onToggleSidebar,
}: {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)] px-2.5"
      data-chat-section-header
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text-strong)]"
          title={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
        >
          <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-default hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text-strong)]"
          title="New thread"
        >
          <SquarePen className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>
      <span
        className={cn(
          typographyTitle,
          'min-w-0 flex-1 truncate font-normal text-[var(--basis-text-muted)]',
        )}
      >
        Typography system refactor
      </span>
      <span className={cn(typographyCaption, 'shrink-0 text-[var(--basis-text-faint)]')}>idle</span>
    </div>
  )
}

function DesktopShellDemo({ settingsOpen = false }: { settingsOpen?: boolean }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [convexOpen, setConvexOpen] = useState(false)

  useEffect(() => {
    ensureElectronMock()
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    const timer = window.setTimeout(() => {
      const btn = document.querySelector<HTMLButtonElement>('button[title="Settings"]')
      btn?.click()
    }, 500)
    return () => window.clearTimeout(timer)
  }, [settingsOpen])

  const workspaces = useMemo(
    () => [
      {
        path: '/workspace/openmanager',
        name: 'openmanager',
        sessions: [
          { externalId: 'sess-1', title: 'Typography system refactor', status: 'idle' },
          { externalId: 'sess-2', title: 'Storybook view setup', status: 'idle' },
          { externalId: 'sess-3', title: 'Convex streaming overhaul', status: 'running' },
        ],
      },
      {
        path: '/workspace/opencode.ref',
        name: 'opencode.ref',
        sessions: [{ externalId: 'sess-101', title: 'Reference audit', status: 'idle' }],
      },
    ],
    [],
  )

  return (
    <StoryProviders>
      <div className="flex h-screen w-screen min-w-0 flex-col overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
        <AppChrome convexOpen={convexOpen} onToggleConvex={() => setConvexOpen((v) => !v)} />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <WorkspaceSidebarView
            collapsed={sidebarCollapsed}
            workspaces={workspaces}
            activeWorkspacePath="/workspace/openmanager"
            activeSessionId="sess-1"
            collapsedWorkspacePaths={[]}
            onToggleWorkspaceCollapse={() => undefined}
            onCreateSession={() => undefined}
            onSelectSession={() => undefined}
            onDeleteSession={() => undefined}
            onRemoveWorkspace={() => undefined}
            onAddWorkspace={() => undefined}
          />
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--basis-canvas-bg)]">
            <ShellHeader
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
            />
            <ChatViewPanel>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-2xl space-y-3 px-4 py-6 pb-44">
                  <UserMessage content="The title bar still feels unfinished — can we tighten the chrome and settings?" />
                  <AssistantMessage
                    isFinal
                    content="Yes. I tightened the title bar border, cleaned the sidebar hierarchy, rebuilt settings as a flat panel, and darkened the composer slightly while leaving chat content alone."
                  />
                  <UserMessage content="Also check Lucide icon consistency across the shell." />
                  <AssistantMessage
                    isFinal
                    content="Icons were already Lucide React. Stroke width is now consistently 1.75 across chrome, sidebar, and settings."
                  />
                </div>
              </div>
            </ChatViewPanel>
            <FloatingChatComposer>
              <MessageInputView
                disabled={false}
                pendingDraftSessionStart={false}
                activeWorkspacePath="/workspace/openmanager"
                activeSessionId="sess-1"
                isSessionDraftOpen={false}
                providerReady={true}
                providerOptions={[
                  { id: 'opencode', name: 'OpenCode' },
                  { id: 'cursor', name: 'Cursor' },
                ]}
                currentProviderId="opencode"
                currentProviderName="OpenCode"
                modeOptions={[
                  { id: 'default', name: 'Default' },
                  { id: 'plan', name: 'Plan' },
                ]}
                currentModeId="default"
                modelOptions={[
                  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
                  { id: 'claude-opus-4', name: 'Claude Opus 4' },
                ]}
                currentModelId="claude-sonnet-4-5"
                canChangeSettings={true}
                canChangeProvider={false}
                showModeControl={true}
                showModelControl={true}
                agent={{ name: 'OpenCode', version: '1.7.0' }}
                isStreaming={false}
                draftKey="desktop-shell"
                imageUploadEnabled={true}
                imageSupportMessage={null}
                onModeChange={() => undefined}
                onProviderChange={() => undefined}
                onModelChange={() => undefined}
                onSend={async () => undefined}
                onAbort={() => undefined}
              />
            </FloatingChatComposer>
          </div>
        </div>
      </div>
    </StoryProviders>
  )
}

export const Shell: Story = {
  render: () => <DesktopShellDemo />,
}

export const SettingsOpen: Story = {
  render: () => <DesktopShellDemo settingsOpen />,
}
