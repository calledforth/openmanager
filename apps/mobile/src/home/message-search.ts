/**
 * Search over what was said in chats, on the phone: which environments can
 * be asked (`search.messages`), and how their hits become the phone's own
 * session rows. The asking, merging, debounce and timeout are app-core's
 * (`useChatSearch`); this is only the phone's side of it. Pure but for the
 * hook at the end, so it is tested without React Native.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import {
  withoutLeadingEllipsis,
  type ChatSearchSource,
  type PlacedSearchHit,
  type SearchSnippet,
} from '@openmanager/app-core/lib/chat-search'
import type { WorkspaceEntry } from '@openmanager/app-core/providers/sidebar-provider'

import { usePhoneConnectionController } from '../environment/PhoneEnvironmentProvider'
import type { PhoneConnectionState } from '../environment/controller'
import { homeSessionKey, statusMarkOf, type HomeRow, type HomeSession } from './rows'

/** What a source needs of an environment's client. */
export type SearchClient = Pick<EnvironmentClient, 'supports' | 'commands'>

/**
 * The saved environments whose client says it can search messages now, in
 * the saved order: the order equal places merge in. One with no client, or
 * on a server from before `search.messages`, is left out.
 */
export function searchableEnvironmentIds(
  state: Pick<PhoneConnectionState, 'environments' | 'links'>,
): string[] {
  return state.environments.flatMap(({ environmentId }) =>
    state.links[environmentId]?.client?.supports('searchMessages') ? [environmentId] : [],
  )
}

/**
 * One source per environment, asking whatever client that environment holds
 * when the search runs, so a source stays the same object across a
 * reconnect and the search is not asked again for it. A client gone by then
 * fails the search, and the environment is named as one that could not be
 * searched.
 */
export function chatSearchSourcesOf(
  environmentIds: readonly string[],
  clientOf: (environmentId: string) => SearchClient | null,
): ChatSearchSource[] {
  return environmentIds.map((environmentId) => ({
    environmentId,
    search: (query: string, limit: number) => {
      const client = clientOf(environmentId)
      if (!client?.supports('searchMessages')) {
        return Promise.reject(new Error(`${environmentId} cannot search now`))
      }
      return client.commands.searchMessages(query, limit)
    },
  }))
}

/** A hit as the phone lists it: the session's own row, at the message that matched. */
export interface MessageHitRow {
  /** The row's key, as `homeSessionKey` makes it. */
  key: string
  row: HomeRow
  hit: PlacedSearchHit
  /** The snippet to show, the leading "…" dropped. */
  snippet: SearchSnippet
}

/** A session's key from an environment and an id, as `homeSessionKey` makes it. */
function placeKey(environmentId: string, sessionId: string): string {
  return `${environmentId}\n${sessionId}`
}

/**
 * The hits as rows of the sessions the phone holds, best first. A session
 * already listed by its title (`listed`, keys as `homeSessionKey` makes
 * them) is not listed again, and one the phone does not hold (yet) is
 * skipped: there is no row to open.
 */
export function messageHitRowsOf({
  hits,
  sessions,
  listed,
  workspaceOf,
}: {
  hits: readonly PlacedSearchHit[]
  sessions: readonly HomeSession[]
  listed: ReadonlySet<string>
  workspaceOf: (session: HomeSession) => WorkspaceEntry | undefined
}): MessageHitRow[] {
  if (hits.length === 0) return []
  const byKey = new Map(sessions.map((session) => [homeSessionKey(session), session]))
  const rows: MessageHitRow[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const key = placeKey(hit.environmentId, hit.sessionId)
    const session = byKey.get(key)
    if (!session || listed.has(key) || seen.has(key)) continue
    seen.add(key)
    rows.push({
      key,
      row: {
        kind: 'session',
        session,
        workspace: workspaceOf(session),
        mark: statusMarkOf(session),
        depth: 0,
      },
      hit,
      snippet: withoutLeadingEllipsis(hit),
    })
  }
  return rows
}

const NO_SOURCES: ChatSearchSource[] = []

/**
 * The sources for `useChatSearch`: every saved environment whose client can
 * search messages, in the saved order. The same array until that set
 * changes, so a streamed token or a route change elsewhere does not ask the
 * environments again.
 */
export function useChatSearchSources(): readonly ChatSearchSource[] {
  const controller = usePhoneConnectionController()
  const read = useCallback(
    () => searchableEnvironmentIds(controller.getState()).join('\n'),
    [controller],
  )
  const ids = useSyncExternalStore(controller.subscribe, read, read)
  return useMemo(
    () =>
      ids
        ? chatSearchSourcesOf(
            ids.split('\n'),
            (environmentId) => controller.getState().links[environmentId]?.client ?? null,
          )
        : NO_SOURCES,
    [controller, ids],
  )
}
