import type { SidecarHandshake, SidecarStatus } from '@openmanager/shared/contracts/sidecar'
import type { AgentEvent, ProviderId, ProviderMetadata } from '@agentpack/contract'
import type { ConvexConnectionResult, RuntimeConfig } from '../../shared/runtime-config'

interface ElectronAPI {
  platform: NodeJS.Platform
  minimizeWindow: () => Promise<void>
  maximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => () => void
  getClientId: () => Promise<string | null>
  getRuntimeConfig: () => Promise<RuntimeConfig>
  testConvexUrl: (url: string) => Promise<ConvexConnectionResult>
  setConvexUrlAndRestart: (url: string) => Promise<ConvexConnectionResult>
  getTelemetrySnapshot: () => Promise<{ filePath: string; events: unknown[] }>
  clearTelemetry: () => Promise<void>
  recordTelemetry: (event: Record<string, unknown>) => Promise<void>
  ensureAgentProvider: (providerId: ProviderId, cwd: string) => Promise<SidecarHandshake>
  getAgentStatuses: () => Promise<Partial<Record<ProviderId, SidecarStatus>>>
  getAgentProviders: () => Promise<ProviderMetadata[]>
  loadAcpSession: (
    providerId: ProviderId,
    workspacePath: string,
    sessionId: string,
  ) => Promise<{ ok: boolean; reason?: string }>
  selectFolder: () => Promise<string | null>
  getCollapsedWorkspaces: () => Promise<string[]>
  setCollapsedWorkspaces: (paths: string[]) => Promise<void>
  getLastProviderId: () => Promise<ProviderId>
  setLastProviderId: (providerId: ProviderId) => Promise<void>
  onAgentStatusChanged: (
    callback: (data: { providerId: ProviderId; status: string }) => void,
  ) => () => void
  onStreamToken: (callback: (data: AgentEvent) => void) => () => void
  onTelemetryUpdate: (callback: (data: unknown) => void) => () => void
  onAcpEvent: (callback: (data: AgentEvent) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
