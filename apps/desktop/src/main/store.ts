import Store from 'electron-store'
import { configureStableUserDataPath } from './app-paths'
import type { ProviderCatalogCache } from './provider-catalog-cache'
import type { ProviderHealthCache } from './provider-health-cache'
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
  /** Last provider health snapshot, so the sidebar renders known state at
   * launch instead of "unavailable" while the first probe runs. Aged out by
   * `isProviderHealthStale`; never a source of current truth. */
  providerHealth: ProviderHealthCache
  /** Last model catalog each provider reported, so the composer opens on a
   * full picker instead of an empty one while the first probe runs. Invalidated
   * by the agent version that produced it rather than by age — see
   * `provider-catalog-cache`. */
  providerCatalogs: ProviderCatalogCache
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
    providerHealth: {},
    providerCatalogs: {},
  },
})

export default store
