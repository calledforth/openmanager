import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  getClientId: () => ipcRenderer.invoke('client:get-id'),
  getTelemetrySnapshot: () => ipcRenderer.invoke('telemetry:get-snapshot'),
  clearTelemetry: () => ipcRenderer.invoke('telemetry:clear'),
  recordTelemetry: (event: Record<string, unknown>) => ipcRenderer.invoke('telemetry:record', event),
  spawnSidecar: (workspacePath: string) => ipcRenderer.invoke('sidecar:spawn', workspacePath),
  getSidecarHandshake: (workspacePath: string) =>
    ipcRenderer.invoke('sidecar:handshake', workspacePath),
  getSidecarStatus: (workspacePath: string) =>
    ipcRenderer.invoke('sidecar:status', workspacePath),
  shutdownSidecar: (workspacePath: string) =>
    ipcRenderer.invoke('sidecar:shutdown', workspacePath),
  loadAcpSession: (workspacePath: string, sessionId: string) =>
    ipcRenderer.invoke('acp:load-session', workspacePath, sessionId),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  onSidecarStatusChanged: (
    callback: (data: { workspacePath: string; status: string }) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { workspacePath: string; status: string })
    ipcRenderer.on('sidecar:status-changed', handler)
    return () => ipcRenderer.removeListener('sidecar:status-changed', handler)
  },
  onStreamToken: (
    callback: (
      data: {
        sessionExternalId: string
        messageExternalId: string
        delta?: string
        partId?: string
        field?: string
        part?: Record<string, unknown>
      },
    ) => void,
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
