export type AppUpdateEvent =
  | {
      status: 'available'
      version: string
    }
  | {
      status: 'downloading'
      version: string
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  | {
      status: 'ready'
      version: string
    }
  | {
      status: 'error'
      message: string
    }
