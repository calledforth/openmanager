export type ConvexConfigSource = 'settings' | 'environment' | 'unset'

export interface RuntimeConfig {
  convexUrl: string
  convexSource: ConvexConfigSource
  environmentUrlAvailable: boolean
}

export interface ConvexConnectionResult {
  ok: boolean
  normalizedUrl?: string
  error?: string
}
