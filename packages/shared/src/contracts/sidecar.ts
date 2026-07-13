export interface SidecarHandshake {
  ready: boolean
}

export type SidecarStatus = 'stopped' | 'starting' | 'healthy' | 'unhealthy' | 'crashed'
