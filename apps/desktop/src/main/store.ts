import Store from 'electron-store'
import { configureStableUserDataPath } from './app-paths'

// Electron derives userData from package.name. Keep the original path so the
// desktop retains its existing client identity and local preferences.
configureStableUserDataPath()

interface StoreSchema {
  collapsedWorkspaces: string[]
  lastSelectedModelByWorkspace: Record<string, string>
}

const store = new Store<StoreSchema>({
  name: 'openmanager-settings',
  defaults: {
    collapsedWorkspaces: [],
    lastSelectedModelByWorkspace: {},
  },
})

export default store
