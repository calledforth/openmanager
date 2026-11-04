import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import { shallowEqualArray, type EnvironmentClient } from '@openmanager/environment-client'
import { DraftDiscardNotice } from '@openmanager/app-core/components/sidebar/DraftDiscardToast'
import { WorkspaceSidebar } from '@openmanager/app-core/components/sidebar/WorkspaceSidebar'
import { newestDraftFirst } from '@openmanager/app-core/components/sidebar/sidebar-sessions'
import {
  DraftDiscardsContext,
  useDraftDiscards,
  type DraftDiscards,
} from '@openmanager/app-core/providers/environment-sidebar-drafts'
import {
  PlatformCapabilitiesContext,
  type PlatformCapabilitiesValue,
} from '@openmanager/app-core/providers/platform-provider'
import {
  SidebarDataContext,
  SidebarDraftsContext,
  SidebarEnvironmentsContext,
  SidebarSessionsContext,
  useEnvironmentChoice,
  useSidebarData,
  useSidebarDrafts,
  useSidebarSessions,
  type SidebarDataValue,
  type SidebarDraftsValue,
  type SidebarEnvironmentRows,
  type SidebarEnvironmentsValue,
  type SidebarRowEnvironment,
  type SidebarSessionsByWorkspace,
} from '@openmanager/app-core/providers/sidebar-provider'
import {
  createSidebarRowsReader,
  isEnvironmentReachable,
  sidebarRowAbilities,
} from '@openmanager/app-core/providers/sidebar-rows'
import { WorkspaceIconContext } from '@openmanager/app-core/providers/view-actions'
import { EnvironmentFailureStrip } from './connection-surfaces'
import { environmentIsDown } from '@openmanager/environment-client/connection'
import { useAddressLookup, type Address } from '../providers/address-environment'
import { useConnection } from '../providers/connection-provider'
import { useEnvironmentClients } from '../providers/environment-client-provider'
import { EnvironmentChoiceHost } from './environment-choice'

/** What the open environment's providers hand the sidebar. */
type OpenEnvironment = {
  data: SidebarDataValue
  sessions: SidebarSessionsByWorkspace
  drafts: SidebarDraftsValue | null
  platform: PlatformCapabilitiesValue | null
}

/**
 * Carries the open environment's side of the sidebar out of its providers.
 * Those are keyed by environment and replaced with it, while the sidebar stays
 * put: a card's scroll position, focus and motion would otherwise start over
 * with every click on another environment's card.
 */
function createSidebarBridge() {
  let open: OpenEnvironment | null = null
  const listeners = new Set<() => void>()
  const tell = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    get: () => open,
    set: (next: OpenEnvironment) => {
      open = next
      tell()
    },
    clear: () => {
      if (!open) return
      open = null
      tell()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

type SidebarBridge = ReturnType<typeof createSidebarBridge>

const SidebarBridgeContext = createContext<SidebarBridge | null>(null)

/**
 * Renders nothing: inside an environment's providers, it tells the sidebar what
 * they say. In a layout effect, so a new environment's providers reach the
 * sidebar in the commit that mounts them, before anything is painted. That
 * takes the sidebar listening by then, on the first commit too, which is why
 * `EnvironmentsSidebar` comes first in the tree and listens in a layout effect.
 */
export function SidebarSource() {
  const bridge = useContext(SidebarBridgeContext)
  const data = useSidebarData()
  const sessions = useSidebarSessions()
  const drafts = useSidebarDrafts()
  const platform = useContext(PlatformCapabilitiesContext)
  useLayoutEffect(() => {
    bridge?.set({ data, sessions, drafts, platform })
  }, [bridge, data, drafts, platform, sessions])
  // Its commands go through providers that are leaving. Moving to another
  // environment, the next source speaks in this same commit, so the sidebar
  // never renders the gap between them.
  useLayoutEffect(() => () => bridge?.clear(), [bridge])
  return null
}

const NO_ROWS: readonly SidebarEnvironmentRows[] = []
const NO_ORDER: readonly string[] = []
type ProviderId = SidebarSessionsByWorkspace[string][number]['providerId']

const NO_SESSIONS: SidebarSessionsByWorkspace = {}
const NOTHING = () => undefined
const NOTHING_LATER = async () => undefined

/**
 * The sidebar with no environment open, because the selected one has no client:
 * it refused the token, or it is offline with nothing kept. Only other
 * environments' rows are left, and each of those goes through its own. Opening
 * one needs no providers: everything that opens goes through the address.
 */
function noOpenEnvironment(
  navigate: ReturnType<typeof useNavigate>,
  { undo, confirm, hold }: Pick<DraftDiscards, 'undo' | 'confirm' | 'hold'>,
): OpenEnvironment {
  return {
    data: {
      workspaces: [],
      isWorkspacesLoading: false,
      activeWorkspacePath: null,
      activeSessionId: null,
      collapsedWorkspacePaths: [],
      toggleWorkspaceCollapsed: NOTHING,
      addWorkspace: NOTHING_LATER,
      addWorkspaceDisabled: true,
      removeWorkspace: NOTHING_LATER,
      selectSession: (_workspacePath, sessionId) =>
        void navigate({ to: '/sessions/$sessionId', params: { sessionId } }),
      createSession: NOTHING_LATER,
      renameSession: NOTHING_LATER,
      deleteSession: NOTHING_LATER,
    },
    sessions: NO_SESSIONS,
    drafts: {
      drafts: [],
      openDraftId: null,
      openDraft: (draftId) => void navigate({ to: '/drafts/$draftId', params: { draftId } }),
      discardDraft: NOTHING,
      pendingDiscard: null,
      undoDiscard: undo,
      confirmDiscard: confirm,
      holdDiscard: hold,
    },
    platform: null,
  }
}

/**
 * The rows of every environment but the open one, in saved order, kept the same
 * array while none of them changed. Each store tells of every event, a streamed
 * token included, and each read here costs a few comparisons
 * (`createSidebarRowsReader`), so nothing above this renders for a token,
 * wherever it streams. The open environment is left out: its rows come from its
 * providers, and reading them again here would run on every keystroke.
 */
function useOtherEnvironmentRows(
  clients: Readonly<Record<string, EnvironmentClient>>,
  order: readonly string[],
  openId: string | undefined,
): readonly SidebarEnvironmentRows[] {
  const readers = useRef(new Map<string, ReturnType<typeof createSidebarRowsReader>>())
  const last = useRef(NO_ROWS)
  const subscribe = useCallback(
    (listener: () => void) => {
      const leave = Object.entries(clients)
        .filter(([environmentId]) => environmentId !== openId)
        .map(([, client]) => client.subscribe(listener))
      return () => {
        for (const stop of leave) stop()
      }
    },
    [clients, openId],
  )
  const read = useCallback(() => {
    const rows: SidebarEnvironmentRows[] = []
    for (const environmentId of order) {
      const client = clients[environmentId]
      if (!client || environmentId === openId) continue
      let reader = readers.current.get(environmentId)
      if (!reader) {
        reader = createSidebarRowsReader()
        readers.current.set(environmentId, reader)
      }
      const environment = reader(client)
      if (environment) rows.push(environment)
    }
    if (!shallowEqualArray(last.current as SidebarEnvironmentRows[], rows)) last.current = rows
    return last.current
  }, [clients, openId, order])
  return useSyncExternalStore(subscribe, read, read)
}

const NEVER = () => () => undefined
const NOT_OFFERED = 'none'

/** What the open environment's rows can offer, as one comparable value. */
function useOpenRowAbilities(client: EnvironmentClient | undefined) {
  const read = useCallback(() => {
    if (!client) return NOT_OFFERED
    const { reachable, canSettle, canPin, hasIcons } = sidebarRowAbilities(client)
    return `${reachable ? 'reachable' : ''} ${canSettle ? 'settle' : ''} ${canPin ? 'pin' : ''} ${hasIcons ? 'icons' : ''}`
  }, [client])
  const abilities = useSyncExternalStore(client?.subscribe ?? NEVER, read, read)
  return {
    reachable: abilities.includes('reachable'),
    canSettle: abilities.includes('settle'),
    canPin: abilities.includes('pin'),
    hasIcons: abilities.includes('icons'),
  }
}

/**
 * The icon lookup of one client. Its identity keys the icon cache, so it is
 * kept per client: an environment's rows stay the same whether it is open or not.
 */
const iconLookups = new WeakMap<
  EnvironmentClient,
  NonNullable<SidebarRowEnvironment['iconLookup']>
>()
function iconLookupOf(client: EnvironmentClient) {
  let lookup = iconLookups.get(client)
  if (!lookup) {
    lookup = (workspaceId) => client.commands.resolveWorkspaceIcon(workspaceId).catch(() => null)
    iconLookups.set(client, lookup)
  }
  return lookup
}

function sameRowEnvironments(
  left: Readonly<Record<string, SidebarRowEnvironment>>,
  right: Readonly<Record<string, SidebarRowEnvironment>>,
) {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const a = left[key]!
      const b = right[key]
      return (
        b !== undefined &&
        a.name === b.name &&
        a.reachable === b.reachable &&
        a.canSettle === b.canSettle &&
        a.canPin === b.canPin &&
        a.offline === b.offline &&
        a.iconLookup === b.iconLookup
      )
    })
  )
}

/**
 * What the sidebar shows: the open environment's rows as its providers made
 * them, and every other's as its client has them. With one environment saved
 * that is the providers' word alone, and nothing here adds to it.
 *
 * With nothing open and no other environment's rows to list it shows
 * `fallback`. With rows it stays the same sidebar, so losing the open
 * environment costs the others neither their cards nor their place.
 */
function EnvironmentsSidebar({
  footer,
  fallback,
  reportFailure,
}: {
  footer: ReactNode
  fallback: ReactNode
  reportFailure: (message: string) => void
}) {
  const bridge = useContext(SidebarBridgeContext)!
  const discards = useContext(DraftDiscardsContext)!
  // Not `useSyncExternalStore`: it subscribes after paint, so on boot the shell
  // would show for a frame with no sidebar beside it.
  const [open, setOpen] = useState(bridge.get)
  useLayoutEffect(() => {
    const stop = bridge.subscribe(() => setOpen(bridge.get()))
    // Whatever was published before it listened.
    setOpen(bridge.get())
    return stop
  }, [bridge])
  const navigate = useNavigate()
  const { undo, confirm, hold } = discards
  const nothingOpen = useMemo(
    () => noOpenEnvironment(navigate, { undo, confirm, hold }),
    [confirm, hold, navigate, undo],
  )
  const { clients, everyCacheRead } = useEnvironmentClients()
  const { environments, links } = useConnection()
  const { prefer } = useAddressLookup()
  const choose = useEnvironmentChoice()?.choose
  const savedKey = environments.map(({ environmentId }) => environmentId).join('\n')
  const order = useMemo(() => (savedKey ? savedKey.split('\n') : []), [savedKey])

  // Who is open comes from what the providers last said, not from the address:
  // that keeps a card from leaving the list for the commit between the two.
  const { data, sessions, drafts: openDrafts, platform } = open ?? nothingOpen
  const openId = data.activeEnvironmentId
  const openClient = openId ? clients[openId] : undefined
  const pending = discards.pending
  const several = order.length > 1
  const others = useOtherEnvironmentRows(clients, several ? order : NO_ORDER, openId)
  const {
    reachable: openReachable,
    canSettle: openCanSettle,
    canPin: openCanPin,
    hasIcons: openHasIcons,
  } = useOpenRowAbilities(openClient)

  // Down is narrower than not reachable (`isEnvironmentReachable`): it is what
  // the banner says can't be reached, and leaves out a first connection still on
  // its way, so nothing reads offline at boot. Every one that is down is also not
  // reachable. Compared as text: `links` is new with every report from any
  // connection.
  const downKey = links
    .filter((link) => environmentIsDown(link.ui))
    .map((link) => link.environmentId)
    .join('\n')

  const down = useMemo(() => new Set(downKey.split('\n')), [downKey])

  const nameOf = useCallback(
    (environmentId: string) =>
      environments.find((item) => item.environmentId === environmentId)?.label ?? environmentId,
    [environments],
  )

  const rowEnvironmentsRef = useRef<SidebarEnvironmentsValue['rowEnvironments'] | null>(null)
  const rowEnvironments = useMemo(() => {
    if (!several) return null
    const next: Record<string, SidebarRowEnvironment> = {}
    const add = (
      environmentId: string,
      {
        reachable,
        canSettle,
        canPin,
        hasIcons,
      }: { reachable?: boolean; canSettle: boolean; canPin: boolean; hasIcons: boolean },
    ) => {
      const client = clients[environmentId]
      next[environmentId] = {
        name: nameOf(environmentId),
        reachable: reachable === true,
        canSettle,
        canPin,
        offline: down.has(environmentId),
        iconLookup: hasIcons && client ? iconLookupOf(client) : null,
      }
    }
    if (openId) {
      add(openId, {
        reachable: openReachable,
        canSettle: openCanSettle,
        canPin: openCanPin,
        hasIcons: openHasIcons,
      })
    }
    for (const row of others) add(row.environmentId, row)
    const before = rowEnvironmentsRef.current
    if (before && sameRowEnvironments(before, next)) return before
    rowEnvironmentsRef.current = next
    return next
  }, [
    clients,
    down,
    nameOf,
    openCanPin,
    openCanSettle,
    openHasIcons,
    openId,
    openReachable,
    others,
    several,
  ])

  // A provider's name is the same everywhere, but only the catalog of an
  // environment that offers it can say so.
  const catalogName = useCallback(
    (providerId: ProviderId) => {
      for (const client of Object.values(clients)) {
        const entry = client.getState().providers[providerId]
        if (entry) return entry.displayName
      }
      return providerId
    },
    [clients],
  )

  const listed = useMemo<SidebarEnvironmentsValue | null>(
    () =>
      rowEnvironments
        ? {
            others,
            rowEnvironments,
            filling: !everyCacheRead,
            ...(platform ? {} : { providerDisplayName: catalogName }),
          }
        : null,
    [catalogName, everyCacheRead, others, platform, rowEnvironments],
  )

  // Null for the open environment's rows. A row of another environment goes
  // through that environment or nowhere: with its client gone, the open one
  // must not be handed an id that means something else there.
  const elsewhere = useCallback(
    (environmentId: string | undefined) =>
      environmentId && environmentId !== openId ? { client: clients[environmentId] } : null,
    [clients, openId],
  )
  // Always, the open environment's own cards too: a word left from an
  // earlier click that never arrived would otherwise decide for this one.
  const opening = useCallback(
    (environmentId: string | undefined, address: Address) => {
      if (environmentId) prefer(address, environmentId)
    },
    [prefer],
  )

  // With several listed, what a row asks goes through here, the open
  // environment's rows included: the providers keep a failure to themselves, and
  // this says who was asked. Nothing waits to be sent again: if it didn't go,
  // it's up to the person to ask again.
  // Down, its client would hold the command and send it on reconnecting, after
  // anyone asked. It waits for the environment, not in a queue. The client's
  // word as well as the banner's: after a drop the banner can read ready until
  // the route is asked again. Says why, or null when it can go.
  const refusalFor = useCallback(
    (environmentId: string, asked: string) => {
      const name = nameOf(environmentId)
      const client = clients[environmentId]
      return !client
        ? `Couldn't ${asked} on ${name}: it isn't connected.`
        : down.has(environmentId)
          ? `Couldn't ${asked} on ${name}: it's offline. Try again once it's back.`
          : !isEnvironmentReachable(client)
            ? `Couldn't ${asked} on ${name}: it isn't connected right now. Try again once it is.`
            : null
    },
    [clients, down, nameOf],
  )

  const askRowEnvironment = useCallback(
    async (
      environmentId: string,
      asked: string,
      run: (client: EnvironmentClient) => Promise<unknown>,
    ) => {
      // Nothing was sent, so nothing moved that a rejection would move back.
      const refusal = refusalFor(environmentId, asked)
      if (refusal) {
        reportFailure(refusal)
        return
      }
      try {
        await run(clients[environmentId]!)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        reportFailure(`Couldn't ${asked} on ${nameOf(environmentId)}: ${reason}`)
        throw error
      }
    },
    [clients, nameOf, refusalFor, reportFailure],
  )

  const askedDirectly = useCallback(
    (environmentId: string | undefined): environmentId is string =>
      Boolean(environmentId) && (several || environmentId !== openId),
    [openId, several],
  )

  const anySettles = others.some((row) => row.canSettle)
  const anyPins = others.some((row) => row.canPin)
  const sidebarData = useMemo<SidebarDataValue>(() => {
    const {
      createSession,
      deleteSession,
      pinSession,
      renameSession,
      selectSession,
      settleSession,
    } = data
    return {
      ...data,
      selectSession: (path, id, providerId, environmentId) => {
        opening(environmentId, { kind: 'session', id })
        selectSession(path, id, providerId)
      },
      // The open environment's providers can only open a page of their own;
      // another environment's project opens on that environment's page.
      createSession: async (path, environmentId) => {
        if (environmentId && environmentId !== openId) choose?.(environmentId, null, path)
        else await createSession(path)
      },
      // A row of another environment goes straight to its client.
      ...(renameSession
        ? {
            renameSession: async (path, id, title, environmentId) => {
              if (askedDirectly(environmentId)) {
                await askRowEnvironment(environmentId, 'rename a session', ({ commands }) =>
                  commands.renameSession(id, title),
                ).catch(NOTHING)
              } else await renameSession(path, id, title)
            },
          }
        : {}),
      deleteSession: async (path, id, providerId, environmentId) => {
        if (askedDirectly(environmentId)) {
          await askRowEnvironment(environmentId, 'delete a session', ({ commands }) =>
            commands.deleteSession(id),
          ).catch(NOTHING)
        } else await deleteSession(path, id, providerId)
      },
      ...(settleSession || anySettles
        ? {
            settleSession: async (path, id, settled, environmentId) => {
              if (askedDirectly(environmentId)) {
                await askRowEnvironment(
                  environmentId,
                  settled ? 'settle a session' : 'bring a session back',
                  ({ commands }) => commands.settleSession(id, settled),
                )
              } else await settleSession?.(path, id, settled)
            },
          }
        : {}),
      ...(pinSession || anyPins
        ? {
            pinSession: async (path, id, pinned, environmentId) => {
              if (askedDirectly(environmentId)) {
                await askRowEnvironment(
                  environmentId,
                  pinned ? 'pin a session' : 'unpin a session',
                  ({ commands }) => commands.pinSession(id, pinned),
                )
              } else await pinSession?.(path, id, pinned)
            },
          }
        : {}),
    }
  }, [anyPins, anySettles, askedDirectly, askRowEnvironment, choose, data, openId, opening])

  // The cards are the same array while no card changed: the sidebar reads a
  // new one as a card having changed.
  const mergedDrafts = useRef<SidebarDraftsValue['drafts'] | null>(null)
  const sidebarDrafts = useMemo<SidebarDraftsValue | null>(() => {
    if (!openDrafts) return null
    const theirs = others.flatMap(({ drafts }) =>
      pending
        ? drafts.filter(
            (draft) =>
              draft.draftId !== pending.draftId || draft.environmentId !== pending.environmentId,
          )
        : drafts,
    )
    let cards = openDrafts.drafts
    if (theirs.length > 0) {
      const merged = [...openDrafts.drafts, ...theirs].sort(newestDraftFirst)
      const before = mergedDrafts.current
      cards = before && shallowEqualArray(before, merged) ? before : merged
      mergedDrafts.current = cards
    }
    const { discardDraft, openDraft } = openDrafts
    return {
      ...openDrafts,
      drafts: cards,
      pendingDiscard: pending,
      openDraft: (draftId, environmentId) => {
        opening(environmentId, { kind: 'draft', id: draftId })
        openDraft(draftId)
      },
      discardDraft: (draftId, options) => {
        const other = elsewhere(options?.environmentId)
        if (!other) {
          discardDraft(draftId, options)
          return
        }
        // Its delete would wait in that client's queue, as any command would.
        const refusal = refusalFor(options!.environmentId!, 'discard a draft')
        if (refusal) reportFailure(refusal)
        else if (other.client) discards.begin(other.client, draftId, options)
      },
    }
  }, [discards, elsewhere, openDrafts, opening, others, pending, refusalFor, reportFailure])

  const platformValue = useMemo(() => {
    if (!platform || !several) return platform
    const { providerDisplayName } = platform
    return {
      ...platform,
      providerDisplayName: (providerId: ProviderId) => {
        const named = providerDisplayName(providerId)
        return named !== providerId ? named : catalogName(providerId)
      },
    }
  }, [catalogName, platform, several])

  const iconLookup = openHasIcons && openClient ? iconLookupOf(openClient) : null

  // Nothing open with no rows is the plain sidebar: the card list would only say
  // there are no projects, which nobody can tell.
  const listing = open !== null || others.length > 0
  return (
    <PlatformCapabilitiesContext.Provider value={platformValue}>
      <WorkspaceIconContext.Provider value={iconLookup}>
        <SidebarDataContext.Provider value={sidebarData}>
          <SidebarSessionsContext.Provider value={sessions}>
            <SidebarDraftsContext.Provider value={sidebarDrafts}>
              <SidebarEnvironmentsContext.Provider value={listed}>
                {/* A healthy connection says nothing; trouble shows as the banner. */}
                {listing ? <WorkspaceSidebar footer={footer} /> : fallback}
                {/* Beside the sidebar, not in it: on a phone the sidebar is a modal
                    sheet that closes on the tap that reaches for Undo. A discard
                    waiting when the list goes keeps its Undo. */}
                {listing || pending ? <DraftDiscardNotice /> : null}
              </SidebarEnvironmentsContext.Provider>
            </SidebarDraftsContext.Provider>
          </SidebarSessionsContext.Provider>
        </SidebarDataContext.Provider>
      </WorkspaceIconContext.Provider>
    </PlatformCapabilitiesContext.Provider>
  )
}

type EnvironmentFailure = { key: number; message: string }

const EnvironmentFailureContext = createContext<{
  failure: EnvironmentFailure | null
  dismiss: () => void
} | null>(null)

/**
 * The last thing asked of a row's environment that failed, for the page to show
 * over itself. It stays until it's dismissed or another takes its place.
 */
export function EnvironmentFailureNotice({ className }: { className?: string }) {
  const failures = useContext(EnvironmentFailureContext)
  if (!failures?.failure) return null
  return (
    <EnvironmentFailureStrip
      key={failures.failure.key}
      className={className}
      message={failures.failure.message}
      onDismiss={failures.dismiss}
    />
  )
}

/**
 * The one sidebar of every environment, and what must outlive any one of them:
 * `children` holds the shell keyed by environment, which reports through
 * `SidebarSource`. A discarded draft's undo is here too, so it carries on
 * across a move between environments, and through losing the open one.
 *
 * Mounted whether or not an environment is open; `fallback` is what shows
 * while nothing can be listed.
 */
export function EnvironmentsSidebarHost({
  footer,
  fallback,
  children,
}: {
  footer: ReactNode
  fallback: ReactNode
  children: ReactNode
}) {
  const [bridge] = useState(createSidebarBridge)
  const { clients } = useEnvironmentClients()
  const clientsRef = useRef(clients)
  useLayoutEffect(() => {
    clientsRef.current = clients
  }, [clients])
  const latest = useCallback((environmentId: string) => clientsRef.current[environmentId], [])
  const discards = useDraftDiscards(latest)
  const [failure, setFailure] = useState<EnvironmentFailure | null>(null)
  const failureKey = useRef(0)
  const reportFailure = useCallback((message: string) => {
    failureKey.current += 1
    setFailure({ key: failureKey.current, message })
  }, [])
  const failures = useMemo(() => ({ failure, dismiss: () => setFailure(null) }), [failure])
  return (
    <SidebarBridgeContext.Provider value={bridge}>
      <DraftDiscardsContext.Provider value={discards}>
        <EnvironmentFailureContext.Provider value={failures}>
          <EnvironmentChoiceHost>
            <EnvironmentsSidebar
              footer={footer}
              fallback={fallback}
              reportFailure={reportFailure}
            />
            {children}
          </EnvironmentChoiceHost>
        </EnvironmentFailureContext.Provider>
      </DraftDiscardsContext.Provider>
    </SidebarBridgeContext.Provider>
  )
}
