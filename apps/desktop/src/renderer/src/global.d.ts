import type { SidecarHandshake, SidecarStatus } from '@openmanager/shared/contracts/sidecar'

interface ElectronAPI {
  platform: NodeJS.Platform
  minimizeWindow: () => Promise<void>
  maximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => () => void
  getClientId: () => Promise<string | null>
  getTelemetrySnapshot: () => Promise<{ filePath: string; events: unknown[] }>
  clearTelemetry: () => Promise<void>
  recordTelemetry: (event: Record<string, unknown>) => Promise<void>
  ensureOpenCode: () => Promise<SidecarHandshake>
  retryOpenCode: () => Promise<SidecarHandshake>
  getOpenCodeStatus: () => Promise<SidecarStatus>
  shutdownOpenCode: () => Promise<void>
  loadAcpSession: (
    workspacePath: string,
    sessionId: string,
  ) => Promise<{ ok: boolean; reason?: string }>
  selectFolder: () => Promise<string | null>
  getCollapsedWorkspaces: () => Promise<string[]>
  setCollapsedWorkspaces: (paths: string[]) => Promise<void>
  onOpenCodeStatusChanged: (callback: (data: { status: string }) => void) => () => void
  onStreamToken: (
    callback: (data: {
      sessionExternalId: string
      messageExternalId: string
      delta?: string
      partId?: string
      field?: string
      part?: Record<string, unknown>
    }) => void,
  ) => () => void
  onTelemetryUpdate: (callback: (data: unknown) => void) => () => void
  onAcpEvent: (callback: (data: unknown) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
