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
import { shallowEqualArray, type EnvironmentClient } from '@openmanager/environment-client'
import { DraftDiscardNotice } from '@openmanager/app-core/components/sidebar/DraftDiscardToast'
import { WorkspaceSidebar } from '@openmanager/app-core/components/sidebar/WorkspaceSidebar'
import { newestDraftFirst } from '@openmanager/app-core/components/sidebar/sidebar-sessions'
import {
  DraftDiscardsContext,
  useDraftDiscards,
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
  sidebarRowAbilities,
} from '@openmanager/app-core/providers/sidebar-rows'
import { WorkspaceIconContext } from '@openmanager/app-core/providers/view-actions'
import { useAddressLookup, type Address } from '../providers/address-environment'
import { useConnection } from '../providers/connection-provider'
import { useEnvironmentClients } from '../providers/environment-client-provider'

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
  return {
    get: () => open,
    set: (next: OpenEnvironment) => {
      open = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

type SidebarBridge = ReturnType<typeof createSidebarBridge>

const SidebarBridgeContext = createContext<SidebarBridge | null>(null)

/**
 * Renders nothing: inside an environment's providers, it tells the sidebar what
 * they say. In a layout effect, so a new environment's providers reach the
 * sidebar in the commit that mounts them, before anything is painted.
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
  return null
}

const NO_ROWS: readonly SidebarEnvironmentRows[] = []
const NO_ORDER: readonly string[] = []

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
    const { canSettle, hasIcons } = sidebarRowAbilities(client)
    return `${canSettle ? 'settle' : ''} ${hasIcons ? 'icons' : ''}`
  }, [client])
  const abilities = useSyncExternalStore(client?.subscribe ?? NEVER, read, read)
  return { canSettle: abilities.includes('settle'), hasIcons: abilities.includes('icons') }
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
        a.canSettle === b.canSettle &&
        a.iconLookup === b.iconLookup
      )
    })
  )
}

/**
 * What the sidebar shows: the open environment's rows as its providers made
 * them, and every other's as its client has them. With one environment saved
 * that is the providers' word alone, and nothing here adds to it.
 */
function EnvironmentsSidebar({ footer }: { footer: ReactNode }) {
  const bridge = useContext(SidebarBridgeContext)!
  const discards = useContext(DraftDiscardsContext)!
  const open = useSyncExternalStore(bridge.subscribe, bridge.get, bridge.get)
  const { clients, everyCacheRead } = useEnvironmentClients()
  const { environments } = useConnection()
  const { prefer } = useAddressLookup()
  const savedKey = environments.map(({ environmentId }) => environmentId).join('\n')
  const order = useMemo(() => (savedKey ? savedKey.split('\n') : []), [savedKey])

  // Who is open comes from what the providers last said, not from the address:
  // that keeps a card from leaving the list for the commit between the two.
  const data = open?.data
  const openId = data?.activeEnvironmentId
  const openClient = openId ? clients[openId] : undefined
  const pending = discards.pending
  const several = order.length > 1
  const others = useOtherEnvironmentRows(clients, several ? order : NO_ORDER, openId)
  const { canSettle: openCanSettle, hasIcons: openHasIcons } = useOpenRowAbilities(openClient)

  const rowEnvironmentsRef = useRef<SidebarEnvironmentsValue['rowEnvironments'] | null>(null)
  const rowEnvironments = useMemo(() => {
    if (!several) return null
    const next: Record<string, SidebarRowEnvironment> = {}
    const add = (environmentId: string, canSettle: boolean, hasIcons: boolean) => {
      const client = clients[environmentId]
      next[environmentId] = {
        name:
          environments.find((item) => item.environmentId === environmentId)?.label ?? environmentId,
        canSettle,
        iconLookup: hasIcons && client ? iconLookupOf(client) : null,
      }
    }
    if (openId) add(openId, openCanSettle, openHasIcons)
    for (const { environmentId, canSettle, hasIcons } of others) {
      add(environmentId, canSettle, hasIcons)
    }
    const before = rowEnvironmentsRef.current
    if (before && sameRowEnvironments(before, next)) return before
    rowEnvironmentsRef.current = next
    return next
  }, [clients, environments, openCanSettle, openHasIcons, openId, others, several])

  const listed = useMemo<SidebarEnvironmentsValue | null>(
    () => (rowEnvironments ? { others, rowEnvironments, filling: !everyCacheRead } : null),
    [everyCacheRead, others, rowEnvironments],
  )

  const elsewhere = useCallback(
    (environmentId: string | undefined) =>
      environmentId && environmentId !== openId ? clients[environmentId] : undefined,
    [clients, openId],
  )
  const opening = useCallback(
    (environmentId: string | undefined, address: Address) => {
      if (environmentId && environmentId !== openId) prefer(address, environmentId)
    },
    [openId, prefer],
  )

  const anySettles = others.some((row) => row.canSettle)
  const sidebarData = useMemo<SidebarDataValue | null>(() => {
    if (!data) return null
    const { deleteSession, renameSession, selectSession, settleSession } = data
    return {
      ...data,
      selectSession: (path, id, providerId, environmentId) => {
        opening(environmentId, { kind: 'session', id })
        selectSession(path, id, providerId)
      },
      // A row of another environment goes straight to its client. What the
      // open environment says about a failure (`fail`) is about the page, and
      // that environment's failures have no place to show yet.
      ...(renameSession
        ? {
            renameSession: async (path, id, title, environmentId) => {
              const client = elsewhere(environmentId)
              if (client) await client.commands.renameSession(id, title).catch(() => undefined)
              else await renameSession(path, id, title)
            },
          }
        : {}),
      deleteSession: async (path, id, providerId, environmentId) => {
        const client = elsewhere(environmentId)
        if (client) await client.commands.deleteSession(id).catch(() => undefined)
        else await deleteSession(path, id, providerId)
      },
      ...(settleSession || anySettles
        ? {
            settleSession: async (path, id, settled, environmentId) => {
              const client = elsewhere(environmentId)
              if (client) await client.commands.settleSession(id, settled)
              else await settleSession?.(path, id, settled)
            },
          }
        : {}),
    }
  }, [anySettles, data, elsewhere, opening])

  // The cards are the same array while no card changed: the sidebar reads a
  // new one as a card having changed.
  const mergedDrafts = useRef<SidebarDraftsValue['drafts'] | null>(null)
  const openDrafts = open?.drafts
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
        const client = elsewhere(options?.environmentId)
        if (client) discards.begin(client, draftId, options)
        else discardDraft(draftId, options)
      },
    }
  }, [discards, elsewhere, openDrafts, opening, others, pending])

  // A provider's name is the same everywhere, but only the catalog of an
  // environment that offers it can say so.
  const platform = open?.platform
  const platformValue = useMemo(() => {
    if (!platform || !several) return platform ?? null
    const { providerDisplayName } = platform
    return {
      ...platform,
      providerDisplayName: (providerId: Parameters<typeof providerDisplayName>[0]) => {
        const named = providerDisplayName(providerId)
        if (named !== providerId) return named
        for (const client of Object.values(clients)) {
          const entry = client.getState().providers[providerId]
          if (entry) return entry.displayName
        }
        return named
      },
    }
  }, [clients, platform, several])

  const iconLookup = openHasIcons && openClient ? iconLookupOf(openClient) : null

  if (!open || !sidebarData) return null
  return (
    <PlatformCapabilitiesContext.Provider value={platformValue}>
      <WorkspaceIconContext.Provider value={iconLookup}>
        <SidebarDataContext.Provider value={sidebarData}>
          <SidebarSessionsContext.Provider value={open.sessions}>
            <SidebarDraftsContext.Provider value={sidebarDrafts}>
              <SidebarEnvironmentsContext.Provider value={listed}>
                {/* A healthy connection says nothing; trouble shows as the banner. */}
                <WorkspaceSidebar footer={footer} />
                {/* Beside the sidebar, not in it: on a phone the sidebar is a modal
                    sheet that closes on the tap that reaches for Undo. */}
                <DraftDiscardNotice />
              </SidebarEnvironmentsContext.Provider>
            </SidebarDraftsContext.Provider>
          </SidebarSessionsContext.Provider>
        </SidebarDataContext.Provider>
      </WorkspaceIconContext.Provider>
    </PlatformCapabilitiesContext.Provider>
  )
}

/**
 * The one sidebar of every environment, and what must outlive any one of them:
 * `children` holds the shell keyed by environment, which reports through
 * `SidebarSource`. A discarded draft's undo is here too, so it carries on
 * across a move between environments.
 */
export function EnvironmentsSidebarHost({
  footer,
  children,
}: {
  footer: ReactNode
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
  return (
    <SidebarBridgeContext.Provider value={bridge}>
      <DraftDiscardsContext.Provider value={discards}>
        <EnvironmentsSidebar footer={footer} />
        {children}
      </DraftDiscardsContext.Provider>
    </SidebarBridgeContext.Provider>
  )
}
