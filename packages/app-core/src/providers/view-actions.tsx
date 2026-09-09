import { createContext, useContext } from 'react'

export interface ViewActions {
  activeSessionId: string | null
  openChildSession?: (childId: string, parentId: string) => Promise<void>
  resolveWorkspaceIcon?: (path: string) => Promise<string | null>
}

export const ViewActionsContext = createContext<ViewActions>({ activeSessionId: null })
export const useViewActions = () => useContext(ViewActionsContext)
