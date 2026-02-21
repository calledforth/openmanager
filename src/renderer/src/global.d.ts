import type { SidecarHandshake, SidecarStatus } from '@shared/contracts/sidecar'

interface ElectronAPI {
  spawnSidecar: (workspacePath: string) => Promise<SidecarHandshake>
  getSidecarHandshake: (workspacePath: string) => Promise<SidecarHandshake | null>
  getSidecarStatus: (workspacePath: string) => Promise<SidecarStatus>
  shutdownSidecar: (workspacePath: string) => Promise<void>
  selectFolder: () => Promise<string | null>
  onSidecarStatusChanged: (
    callback: (data: { workspacePath: string; status: string }) => void,
  ) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
