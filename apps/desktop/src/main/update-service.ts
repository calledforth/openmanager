import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from 'electron-updater'
import type { AppUpdateEvent, ManualUpdateCheckResult } from '../shared/app-update'

const INITIAL_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

let started = false
let latestVersion: string | null = null
let updateCheckInFlight: Promise<ManualUpdateCheckResult> | null = null

function getAutoUpdater(): AppUpdater {
  // electron-updater is CommonJS; destructuring avoids ESM interop issues in bundled builds.
  const { autoUpdater } = electronUpdater
  return autoUpdater
}

function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

function broadcastUpdate(event: AppUpdateEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:event', event)
  }
}

function updaterUnavailableReason(): string | null {
  if (!app.isPackaged) return 'Update checks are available in installed builds.'
  if (process.platform !== 'win32') return 'Automatic updates are currently available on Windows.'
  if (isPortableBuild()) return 'Automatic updates are unavailable in portable builds.'
  return null
}

async function checkForUpdatesNow(): Promise<ManualUpdateCheckResult> {
  const unavailableReason = updaterUnavailableReason()
  if (unavailableReason) return { status: 'unsupported', message: unavailableReason }
  if (updateCheckInFlight) return updateCheckInFlight

  const autoUpdater = getAutoUpdater()
  const check = (async (): Promise<ManualUpdateCheckResult> => {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result) {
        return {
          status: 'unsupported',
          message: 'The update service is unavailable for this build.',
        }
      }
      return result.isUpdateAvailable
        ? { status: 'available', version: result.updateInfo.version }
        : { status: 'current', version: app.getVersion() }
    } finally {
      updateCheckInFlight = null
    }
  })()
  updateCheckInFlight = check
  return check
}

export function startUpdateService(): void {
  if (started) return
  started = true

  ipcMain.handle('updater:quit-and-install', () => {
    if (!app.isPackaged || process.platform !== 'win32' || isPortableBuild()) return
    getAutoUpdater().quitAndInstall(false, true)
  })
  ipcMain.handle('updater:check', () => checkForUpdatesNow())

  if (updaterUnavailableReason()) return

  const autoUpdater = getAutoUpdater()
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = app.getVersion().includes('-')

  autoUpdater.on('error', (error) => {
    console.error('[updater] update check failed:', error)
    broadcastUpdate({
      status: 'error',
      message: error?.message || 'Update failed',
    })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    latestVersion = info.version
    console.info(`[updater] downloading ${info.version}`)
    broadcastUpdate({ status: 'available', version: info.version })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    broadcastUpdate({
      status: 'downloading',
      version: latestVersion ?? app.getVersion(),
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-not-available', () => {
    console.info('[updater] application is current')
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    latestVersion = info.version
    console.info(`[updater] ready to install ${info.version}`)
    broadcastUpdate({ status: 'ready', version: info.version })
  })

  const checkForUpdates = (): void => {
    void checkForUpdatesNow().catch((error: unknown) => {
      console.error('[updater] unable to check for updates:', error)
    })
  }

  const initialTimer = setTimeout(checkForUpdates, INITIAL_CHECK_DELAY_MS)
  initialTimer.unref()

  const interval = setInterval(checkForUpdates, CHECK_INTERVAL_MS)
  interval.unref()
}
