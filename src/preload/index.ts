import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  spawnSidecar: (workspacePath: string) => ipcRenderer.invoke('sidecar:spawn', workspacePath),
  getSidecarHandshake: (workspacePath: string) =>
    ipcRenderer.invoke('sidecar:handshake', workspacePath),
  getSidecarStatus: (workspacePath: string) =>
    ipcRenderer.invoke('sidecar:status', workspacePath),
  shutdownSidecar: (workspacePath: string) =>
    ipcRenderer.invoke('sidecar:shutdown', workspacePath),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  onSidecarStatusChanged: (
    callback: (data: { workspacePath: string; status: string }) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { workspacePath: string; status: string })
    ipcRenderer.on('sidecar:status-changed', handler)
    return () => ipcRenderer.removeListener('sidecar:status-changed', handler)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
