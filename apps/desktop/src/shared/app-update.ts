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

export type ManualUpdateCheckResult =
  | {
      status: 'available'
      version: string
    }
  | {
      status: 'current'
      version: string
    }
  | {
      status: 'unsupported'
      message: string
    }

export function updateProgressPercent(event: AppUpdateEvent): number {
  if (event.status === 'ready') return 100
  if (event.status !== 'downloading') return 0
  return Math.max(0, Math.min(100, Math.round(event.percent)))
}
