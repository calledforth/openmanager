import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentEvent,
  PromptCapabilities,
  ProviderId,
  ProviderMetadata,
} from '@agentpack/contract'
import type { ConvexConnectionResult, RuntimeConfig } from '../shared/runtime-config'

const electronAPI = {
  platform: process.platform as NodeJS.Platform,
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },
  getClientId: () => ipcRenderer.invoke('client:get-id'),
  getRuntimeConfig: () => ipcRenderer.invoke('config:get-runtime') as Promise<RuntimeConfig>,
  testConvexUrl: (url: string) =>
    ipcRenderer.invoke('config:test-convex-url', url) as Promise<ConvexConnectionResult>,
  setConvexUrlAndRestart: (url: string) =>
    ipcRenderer.invoke('config:set-convex-url', url) as Promise<ConvexConnectionResult>,
  getTelemetrySnapshot: () => ipcRenderer.invoke('telemetry:get-snapshot'),
  clearTelemetry: () => ipcRenderer.invoke('telemetry:clear'),
  recordTelemetry: (event: Record<string, unknown>) =>
    ipcRenderer.invoke('telemetry:record', event),
  ensureAgentProvider: (providerId: ProviderId, cwd: string) =>
    ipcRenderer.invoke('agent:ensure', providerId, cwd),
  getAgentStatuses: () => ipcRenderer.invoke('agent:status'),
  getAgentPromptCapabilities: () =>
    ipcRenderer.invoke('agent:prompt-capabilities') as Promise<
      Partial<Record<ProviderId, PromptCapabilities>>
    >,
  getAgentProviders: () => ipcRenderer.invoke('agent:providers') as Promise<ProviderMetadata[]>,
  getModelImageSupport: (providerId: ProviderId, modelId: string) =>
    ipcRenderer.invoke('agent:model-image-support', providerId, modelId) as Promise<boolean | null>,
  loadAcpSession: (providerId: ProviderId, workspacePath: string, sessionId: string) =>
    ipcRenderer.invoke('acp:load-session', providerId, workspacePath, sessionId),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  getCollapsedWorkspaces: () =>
    ipcRenderer.invoke('store:get-collapsed-workspaces') as Promise<string[]>,
  setCollapsedWorkspaces: (paths: string[]) =>
    ipcRenderer.invoke('store:set-collapsed-workspaces', paths),
  getLastProviderId: () => ipcRenderer.invoke('store:get-last-provider') as Promise<ProviderId>,
  setLastProviderId: (providerId: ProviderId) =>
    ipcRenderer.invoke('store:set-last-provider', providerId),
  onAgentStatusChanged: (callback: (data: { providerId: ProviderId; status: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { providerId: ProviderId; status: string })
    ipcRenderer.on('agent:status-changed', handler)
    return () => ipcRenderer.removeListener('agent:status-changed', handler)
  },
  onStreamToken: (callback: (data: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: AgentEvent) => callback(data)
    ipcRenderer.on('stream:token', handler)
    return () => ipcRenderer.removeListener('stream:token', handler)
  },
  onTelemetryUpdate: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on('telemetry:update', handler)
    return () => ipcRenderer.removeListener('telemetry:update', handler)
  },
  onAcpEvent: (callback: (data: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: AgentEvent) => callback(data)
    ipcRenderer.on('acp:event', handler)
    return () => ipcRenderer.removeListener('acp:event', handler)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
