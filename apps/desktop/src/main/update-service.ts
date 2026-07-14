import { app, dialog } from 'electron'
import electronUpdater, { type AppUpdater, type UpdateInfo } from 'electron-updater'

const INITIAL_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

let started = false

function getAutoUpdater(): AppUpdater {
  // electron-updater is CommonJS; destructuring avoids ESM interop issues in bundled builds.
  const { autoUpdater } = electronUpdater
  return autoUpdater
}

function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

export function startUpdateService(): void {
  if (started || !app.isPackaged || process.platform !== 'win32' || isPortableBuild()) return
  started = true

  const autoUpdater = getAutoUpdater()
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = app.getVersion().includes('-')

  autoUpdater.on('error', (error) => {
    console.error('[updater] update check failed:', error)
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.info(`[updater] downloading ${info.version}`)
  })

  autoUpdater.on('update-not-available', () => {
    console.info('[updater] application is current')
  })

  autoUpdater.on('update-downloaded', async (info: UpdateInfo) => {
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'OpenManager update ready',
      message: `OpenManager ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or choose Later to install it when you next quit.',
    })

    if (result.response === 0) autoUpdater.quitAndInstall(false, true)
  })

  const checkForUpdates = (): void => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.error('[updater] unable to check for updates:', error)
    })
  }

  const initialTimer = setTimeout(checkForUpdates, INITIAL_CHECK_DELAY_MS)
  initialTimer.unref()

  const interval = setInterval(checkForUpdates, CHECK_INTERVAL_MS)
  interval.unref()
}
