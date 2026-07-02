export interface SidecarHandshake {
  serverUrl: string
  password: string
  ready: boolean
}

export interface SidecarConfig {
  opencodeBinaryPath?: string
  hostname: string
  port?: number
  workspacePath: string
}

export type SidecarStatus = 'stopped' | 'starting' | 'healthy' | 'unhealthy' | 'crashed'

export interface SidecarLifecycle {
  spawn(config: SidecarConfig): Promise<SidecarHandshake>
  healthcheck(): Promise<boolean>
  restart(): Promise<SidecarHandshake>
  shutdown(): Promise<void>
  getStatus(): SidecarStatus
}
