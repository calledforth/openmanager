import Store from 'electron-store'
import { configureStableUserDataPath } from './app-paths'

// Keep desktop identity and persisted settings stable even if the workspace
// package name changes. Electron otherwise derives userData from package.name.
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
