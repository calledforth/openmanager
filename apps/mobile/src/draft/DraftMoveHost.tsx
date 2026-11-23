import { usePathname } from 'expo-router'
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { selectLandingWorkspaceId } from '@openmanager/app-core/logic'
import { readScope } from '@openmanager/app-core/providers/environment-scope'
import { isEnvironmentReachable } from '@openmanager/app-core/providers/sidebar-rows'
import { SidebarDraftsContext } from '@openmanager/app-core/providers/sidebar-provider'
import { environmentIsDown } from '@openmanager/environment-client/connection'

import { phoneConnectionView } from '../environment/connection-ui'
import { linkOf, type PhoneConnectionController } from '../environment/controller'
import type { ScopeRegistry } from '../environment/scopes'
import { phoneStorage } from '../storage'
import { createDraftMover, type DraftMover, type MoveNotice } from './environment-move'

const DraftMoverContext = createContext<DraftMover | null>(null)

/** The phone's one draft mover; null outside `DraftMoveHost` (the tests' hosts). */
export function useDraftMover(): DraftMover | null {
  return useContext(DraftMoverContext)
}

const NO_NOTICE = () => null
const NO_SUBSCRIBE = () => () => undefined

/** The newest thing a move has to say, until it is dismissed. */
export function useDraftMoveNotice(): MoveNotice | null {
  const mover = useDraftMover()
  return useSyncExternalStore(
    mover?.subscribe ?? NO_SUBSCRIBE,
    mover?.notice ?? NO_NOTICE,
    mover?.notice ?? NO_NOTICE,
  )
}

/** Whether a phone's environment can take a draft now: connected, and not down. */
export function environmentReachable(
  controller: Pick<PhoneConnectionController, 'getState'>,
  environmentId: string,
): boolean {
  const state = controller.getState()
  const link = linkOf(state, environmentId)
  if (!link || !isEnvironmentReachable(link.client ?? undefined)) return false
  return !environmentIsDown(phoneConnectionView(state, environmentId).ui)
}

/**
 * Holds the moves of new-session pages between environments
 * (`environment-move.ts`) for the app's lifetime: a move, once asked for,
 * finishes wherever the reader goes next, as web's choice does. Rendered once,
 * beside every environment's providers.
 */
export function DraftMoveHost({
  controller,
  scopes,
  children,
}: {
  controller: PhoneConnectionController
  /** Each environment's providers, for the draft each has open. */
  scopes: ScopeRegistry
  children: ReactNode
}) {
  const [mover] = useState(() =>
    createDraftMover({
      clientOf: (environmentId) =>
        linkOf(controller.getState(), environmentId)?.client ?? undefined,
      reachable: (environmentId) => environmentReachable(controller, environmentId),
      labelOf: (environmentId) =>
        controller.getState().environments.find((item) => item.environmentId === environmentId)
          ?.label ?? 'that environment',
      landingWorkspaceOf: (state) =>
        selectLandingWorkspaceId(state, phoneStorage.device) ?? state.workspaceOrder[0] ?? null,
      onScreen: (environmentId, draftId) => {
        const scope = scopes.get(environmentId)
        const drafts = scope ? readScope(scope, SidebarDraftsContext) : undefined
        return drafts?.openDraftId === draftId
      },
      mintId: () => globalThis.crypto.randomUUID(),
      now: () => Date.now(),
    }),
  )
  // A page going, a client coming or going, a scope's open draft changing:
  // any of them may settle what waits.
  const pathname = usePathname()
  useEffect(() => mover.check(), [mover, pathname])
  useEffect(() => controller.subscribe(() => mover.check()), [controller, mover])
  useEffect(() => scopes.subscribeAll(() => mover.check()), [mover, scopes])
  return <DraftMoverContext.Provider value={mover}>{children}</DraftMoverContext.Provider>
}
