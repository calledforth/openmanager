import { useCallback, useMemo } from 'react'
import { useEnvironmentClient } from '@openmanager/app-core/logic'

import { usePhoneConnection } from '../environment/PhoneEnvironmentProvider'
import { statusMarkOf, type HomeSession } from '../home/rows'
import { sessionMenuItems, type SessionMenuItem, type SessionMenuItemId } from './session-menu'

/** What the page's header can do with the session it shows. */
export interface SessionActions {
  menu: readonly SessionMenuItem[]
  /** Sends a menu item's command; settles once the environment answered. */
  run: (id: SessionMenuItemId) => Promise<void>
  /** Asks the environment to rename it; the title on screen is the one it keeps. */
  rename: (title: string) => Promise<void>
}

/** No environment to ask (a sample row, nothing paired): every item says why. */
export function unavailableSessionActions(
  session: HomeSession | undefined,
  reason: string,
): SessionActions {
  return {
    menu: sessionMenuItems({
      mark: session ? statusMarkOf(session) : 'idle',
      settled: !!session?.settledAt,
      backgroundTaskCount: session?.backgroundTaskCount ?? 0,
      unavailable: reason,
      supports: () => false,
    }),
    run: () => Promise.resolve(),
    rename: () => Promise.resolve(),
  }
}

/**
 * The live session's actions: the shared client's commands, offered once the
 * environment is connected and advertises them. Nothing is changed here; the
 * client folds the environment's answer into the listing the page reads.
 */
export function useSessionActions(
  sessionId: string,
  session: HomeSession | undefined,
): SessionActions {
  const client = useEnvironmentClient()
  const { status } = usePhoneConnection()
  const mark = session ? statusMarkOf(session) : 'idle'
  const settled = !!session?.settledAt
  const backgroundTaskCount = session?.backgroundTaskCount ?? 0
  const menu = useMemo(
    () =>
      sessionMenuItems({
        mark,
        settled,
        backgroundTaskCount,
        unavailable:
          status !== 'connected'
            ? 'Not connected to its environment'
            : !session
              ? 'Not listed by its environment yet'
              : null,
        supports: (command) => client.supports(command),
      }),
    // `status` is in the list: what the client supports is known once it connects.
    [backgroundTaskCount, client, mark, session, settled, status],
  )
  const run = useCallback(
    async (id: SessionMenuItemId) => {
      switch (id) {
        case 'regenerate-title':
          return client.commands.regenerateSessionTitle(sessionId)
        case 'settle':
          return client.commands.settleSession(sessionId, true)
        case 'unsettle':
          return client.commands.settleSession(sessionId, false)
        case 'stop-background':
          return client.commands.stopBackgroundTasks({ sessionId })
        default:
          // Rename opens the title for editing; settings are not on the phone yet.
          return undefined
      }
    },
    [client, sessionId],
  )
  const rename = useCallback(
    (title: string) => client.commands.renameSession(sessionId, title),
    [client, sessionId],
  )
  return useMemo(() => ({ menu, run, rename }), [menu, rename, run])
}
