import type { SidecarHandshake, SidecarStatus } from '@shared/contracts/sidecar'

interface ElectronAPI {
  getClientId: () => Promise<string | null>
  getTelemetrySnapshot: () => Promise<{ filePath: string; events: unknown[] }>
  clearTelemetry: () => Promise<void>
  recordTelemetry: (event: Record<string, unknown>) => Promise<void>
  spawnSidecar: (workspacePath: string) => Promise<SidecarHandshake>
  getSidecarHandshake: (workspacePath: string) => Promise<SidecarHandshake | null>
  getSidecarStatus: (workspacePath: string) => Promise<SidecarStatus>
  shutdownSidecar: (workspacePath: string) => Promise<void>
  loadAcpSession: (workspacePath: string, sessionId: string) => Promise<{ ok: boolean; reason?: string }>
  selectFolder: () => Promise<string | null>
  onSidecarStatusChanged: (
    callback: (data: { workspacePath: string; status: string }) => void,
  ) => () => void
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
