import Store from 'electron-store'

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
