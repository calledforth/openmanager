import { app } from 'electron'
import { join } from 'path'

const STABLE_USER_DATA_DIRECTORY = 'openmanager'

export function configureStableUserDataPath(): void {
  const stablePath = join(app.getPath('appData'), STABLE_USER_DATA_DIRECTORY)
  if (app.getPath('userData') !== stablePath) {
    app.setPath('userData', stablePath)
  }
}
