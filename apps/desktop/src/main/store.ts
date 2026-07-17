import Store from 'electron-store'
import { configureStableUserDataPath } from './app-paths'
import type {
  ProviderComposerProfiles,
  WorkspaceComposerPreferences,
} from '../shared/composer-profile'

// Electron derives userData from package.name. Keep the original path so the
// desktop retains its existing client identity and local preferences.
configureStableUserDataPath()

interface StoreSchema {
  convexUrl: string
  collapsedWorkspaces: string[]
  lastSelectedModelByWorkspace: Record<string, string>
  lastUsedProviderId: string
  lastActiveWorkspacePath: string
  providerComposerProfiles: ProviderComposerProfiles
  workspaceComposerPreferences: WorkspaceComposerPreferences
}

const store = new Store<StoreSchema>({
  name: 'openmanager-settings',
  defaults: {
    convexUrl: '',
    collapsedWorkspaces: [],
    lastSelectedModelByWorkspace: {},
    lastUsedProviderId: 'opencode',
    lastActiveWorkspacePath: '',
    providerComposerProfiles: {},
    workspaceComposerPreferences: {},
  },
})

export default store
