import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  platform: process.platform as NodeJS.Platform,
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
      callback(maximized)
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },
  getClientId: () => ipcRenderer.invoke('client:get-id'),
  getTelemetrySnapshot: () => ipcRenderer.invoke('telemetry:get-snapshot'),
  clearTelemetry: () => ipcRenderer.invoke('telemetry:clear'),
  recordTelemetry: (event: Record<string, unknown>) =>
    ipcRenderer.invoke('telemetry:record', event),
  ensureOpenCode: () => ipcRenderer.invoke('opencode:ensure'),
  retryOpenCode: () => ipcRenderer.invoke('opencode:retry'),
  getOpenCodeStatus: () => ipcRenderer.invoke('opencode:status'),
  shutdownOpenCode: () => ipcRenderer.invoke('opencode:shutdown'),
  loadAcpSession: (workspacePath: string, sessionId: string) =>
    ipcRenderer.invoke('acp:load-session', workspacePath, sessionId),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  getCollapsedWorkspaces: () =>
    ipcRenderer.invoke('store:get-collapsed-workspaces') as Promise<string[]>,
  setCollapsedWorkspaces: (paths: string[]) =>
    ipcRenderer.invoke('store:set-collapsed-workspaces', paths),
  onOpenCodeStatusChanged: (callback: (data: { status: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { status: string })
    ipcRenderer.on('opencode:status-changed', handler)
    return () => ipcRenderer.removeListener('opencode:status-changed', handler)
  },
  onStreamToken: (
    callback: (data: {
      sessionExternalId: string
      messageExternalId: string
      delta?: string
      partId?: string
      field?: string
      part?: Record<string, unknown>
    }) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(
        data as {
          sessionExternalId: string
          messageExternalId: string
          delta?: string
          partId?: string
          field?: string
          part?: Record<string, unknown>
        },
      )
    ipcRenderer.on('stream:token', handler)
    return () => ipcRenderer.removeListener('stream:token', handler)
  },
  onTelemetryUpdate: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on('telemetry:update', handler)
    return () => ipcRenderer.removeListener('telemetry:update', handler)
  },
  onAcpEvent: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on('acp:event', handler)
    return () => ipcRenderer.removeListener('acp:event', handler)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
