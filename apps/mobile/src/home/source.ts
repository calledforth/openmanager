/**
 * Where the home reads its sessions from: the shared sidebar providers of
 * every connected environment, merged into one list and normalised here into
 * the shell's shapes so the screens never see a provider's own. Each row
 * says which environment it is on, and everything done to it goes through
 * that environment. Nothing is guessed or merged across environments: every
 * status, title, settle and draft is its own environment's, passed through
 * as it came, and two environments that hold the same id hold two rows.
 *
 * The fixture (`fixture.ts`) is the source only on a phone with nothing
 * paired, and only when the build asks for it (`EXPO_PUBLIC_FIXTURE=1`), so
 * the shell can still be shown without a server. Otherwise an unpaired phone
 * shows the empty home.
 */
import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  environmentIsDown,
  isLoopbackEnvironmentEndpoint,
  type ConnectionUiState,
  type EnvironmentRoute,
} from '@openmanager/environment-client/connection'
import { readScope } from '@openmanager/app-core/providers/environment-scope'
import {
  SidebarDataContext,
  SidebarDraftsContext,
  SidebarSessionsContext,
  type SidebarDraft,
  type SidebarSessionEntry,
  type SidebarSessionsByWorkspace,
  type WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'

import {
  environmentScopes,
  useEnvironmentLabel,
  usePageEnvironmentId,
  usePhoneConnection,
} from '../environment/PhoneEnvironmentProvider'
import {
  phoneConnectionView,
  type PhoneConnectionReading,
  type PhoneConnectionTone,
} from '../environment/connection-ui'
import { isLocalNetworkEndpoint } from '../environment/route-order'
import { shortConnectionWords } from '../settings/environments'
import {
  FIXTURE_DRAFTS,
  FIXTURE_ENVIRONMENT,
  FIXTURE_SESSIONS,
  FIXTURE_WORKSPACES,
} from './fixture'
import type { HomeDraft, HomeSession } from './rows'

/** The environment line under a screen's title. */
export interface HomeEnvironment {
  environmentId: string
  label: string
  /**
   * The route the phone reaches it on: `local` for this device or its local
   * network, `tunnel` for anything further away.
   */
  route: { kind: 'local' | 'tunnel'; address: string }
}

/** What a row says about the environment it is on (`HomeSession.environment`). */
export interface HomeRowEnvironment {
  environmentId: string
  label: string
}

/**
 * One saved environment as the home shows it beside its rows: its name, and
 * where its connection stands, each environment on its own.
 */
export interface HomeEnvironmentState {
  environmentId: string
  label: string
  /** The one new sessions go to unless another is picked. */
  selected: boolean
  /** Its connection, as the shared derivation names it (`ready` once connected). */
  connection: ConnectionUiState['kind']
  /**
   * Nothing reaches it (`environmentIsDown`): its rows are what the phone
   * last saw of it, not news. The mark to show beside them.
   */
  offline: boolean
  /** The phone holds no token it accepts: only pairing again helps. */
  needsPairing: boolean
  /** The colour of its state dot. */
  tone: PhoneConnectionTone
  /** Its state in a few shared words while not connected; null once it is. */
  words: string | null
  /** The route in use, while connected. */
  route: HomeEnvironment['route'] | null
  /** Its projects, for looking up a row's by its own environment. */
  workspaces: WorkspaceEntry[]
}

export interface HomeSource {
  /** `fixture`: the dev fixture, with no page behind a row. */
  kind: 'fixture' | 'environment'
  /** The environment new sessions go to, for the line under the title. */
  environment: HomeEnvironment | null
  /** Every saved environment, in the saved order, with its connection. */
  environments: HomeEnvironmentState[]
  /** The environment new sessions go to is connected. */
  connected: boolean
  /**
   * The home offers pairing: the controller has loaded and holds no
   * environment, or holds no token for any saved one.
   */
  needsPairing: boolean
  /** Every environment's projects. Ids may repeat across environments: look a row's up in its own. */
  workspaces: WorkspaceEntry[]
  /** Every environment's sessions, each with its `environment`. */
  sessions: HomeSession[]
  /** Every environment's draft cards, each with its `environment`. */
  drafts: HomeDraft[]
  /**
   * Discard a draft card, through its own environment, with the one undo
   * window every environment shares. Absent where there are no draft cards.
   */
  discardDraft?: (draft: HomeDraft) => void
}

/** One connected environment's sidebar, as its providers serve it. */
export interface HomeSlice {
  environmentId: string
  workspaces: WorkspaceEntry[]
  sessions: SidebarSessionsByWorkspace
  /** Null on a host without draft cards. */
  drafts: readonly SidebarDraft[] | null
  discardDraft: ((draftId: string) => void) | null
}

/** What the source is made from: the controller's state and each environment's providers. */
export interface HomeSourceInputs {
  connection: PhoneConnectionReading
  /** The connected environments' sidebars, any order. */
  slices: readonly HomeSlice[]
  /** The build asked for the fixture (`EXPO_PUBLIC_FIXTURE=1`). */
  fixture: boolean
}

const NO_WORKSPACES: WorkspaceEntry[] = []
const NO_SESSIONS: HomeSession[] = []
const NO_DRAFTS: HomeDraft[] = []

const FIXTURE_SOURCE: HomeSource = {
  kind: 'fixture',
  environment: FIXTURE_ENVIRONMENT,
  environments: [],
  connected: true,
  needsPairing: false,
  workspaces: FIXTURE_WORKSPACES,
  sessions: FIXTURE_SESSIONS,
  drafts: FIXTURE_DRAFTS,
}

function routeKind(endpoint: string): HomeEnvironment['route']['kind'] {
  return isLoopbackEnvironmentEndpoint(endpoint) || isLocalNetworkEndpoint(endpoint)
    ? 'local'
    : 'tunnel'
}

/**
 * The environment new sessions go to as the title's line shows it: its saved
 * label, and the route in use (else its first saved one). Null with nothing
 * saved.
 */
export function homeEnvironmentOf(connection: PhoneConnectionReading): HomeEnvironment | null {
  const environment = connection.environments.find(
    (item) => item.environmentId === connection.selectedId,
  )
  if (!environment) return null
  // A saved environment always has a route.
  const routes: readonly EnvironmentRoute[] = environment.routes
  const address = connection.links[environment.environmentId]?.endpoint ?? routes[0]?.endpoint ?? ''
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    route: { kind: routeKind(address), address },
  }
}

/**
 * Rows by the shared entry they were made from: each environment's provider
 * keeps an entry the same object while nothing it shows changed, so its row
 * does too, and a status change elsewhere re-renders no other row.
 */
const rowsByEntry = new WeakMap<SidebarSessionEntry, HomeSession>()
const cardsByDraft = new WeakMap<SidebarDraft, HomeDraft>()

/**
 * One environment's sessions, grouped by workspace path, as one list of rows
 * that each know their workspace and their environment. Order is the list
 * selectors' to decide; every field of the entry passes through untouched.
 */
export function homeSessionsOf(
  byWorkspace: SidebarSessionsByWorkspace,
  environment: HomeRowEnvironment,
): HomeSession[] {
  const rows: HomeSession[] = []
  for (const [workspacePath, entries] of Object.entries(byWorkspace)) {
    for (const entry of entries) {
      let row = rowsByEntry.get(entry)
      if (
        !row ||
        row.workspacePath !== workspacePath ||
        row.environment?.environmentId !== environment.environmentId ||
        row.environment.label !== environment.label
      ) {
        row = { ...entry, workspacePath, environment }
        rowsByEntry.set(entry, row)
      }
      rows.push(row)
    }
  }
  return rows
}

/** One environment's draft cards, each saying which environment it is on. */
export function homeDraftsOf(
  drafts: readonly SidebarDraft[],
  environment: HomeRowEnvironment,
): HomeDraft[] {
  return drafts.map((draft) => {
    let card = cardsByDraft.get(draft)
    if (
      !card ||
      card.environment?.environmentId !== environment.environmentId ||
      card.environment.label !== environment.label
    ) {
      card = { ...draft, environment }
      cardsByDraft.set(draft, card)
    }
    return card
  })
}

/** Each saved environment's state, in the saved order. */
export function homeEnvironmentsOf(
  connection: PhoneConnectionReading,
  slices: readonly HomeSlice[],
): HomeEnvironmentState[] {
  return connection.environments.map((environment) => {
    const view = phoneConnectionView(connection, environment.environmentId)
    const words = environment.paired ? shortConnectionWords(view) : 'Needs pairing again'
    const slice = slices.find((item) => item.environmentId === environment.environmentId)
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      selected: environment.environmentId === connection.selectedId,
      connection: view.ui.kind,
      offline: environmentIsDown(view.ui),
      needsPairing: !environment.paired || view.ui.kind === 'unauthorized',
      tone: environment.paired ? view.tone : 'error',
      words,
      route: view.route
        ? { kind: routeKind(view.route.endpoint), address: view.route.endpoint }
        : null,
      workspaces: slice?.workspaces ?? NO_WORKSPACES,
    }
  })
}

/** Every connected environment's rows, merged in the saved order. */
export interface HomeRows {
  workspaces: WorkspaceEntry[]
  sessions: HomeSession[]
  drafts: HomeDraft[]
  discardDraft?: (draft: HomeDraft) => void
}

/**
 * The connected environments' rows as one list each, in the saved order,
 * every row tagged with its environment. With one environment its own
 * arrays pass through. Pure.
 */
export function homeRowsOf(
  environments: PhoneConnectionReading['environments'],
  slices: readonly HomeSlice[],
): HomeRows {
  const listed = environments.flatMap((environment) => {
    const slice = slices.find((item) => item.environmentId === environment.environmentId)
    return slice
      ? [{ slice, tag: { environmentId: environment.environmentId, label: environment.label } }]
      : []
  })
  const workspaces =
    listed.length === 1
      ? listed[0]!.slice.workspaces
      : listed.flatMap(({ slice }) => slice.workspaces)
  const sessions = listed.flatMap(({ slice, tag }) => homeSessionsOf(slice.sessions, tag))
  const drafts = listed.flatMap(({ slice, tag }) =>
    slice.drafts ? homeDraftsOf(slice.drafts, tag) : [],
  )
  const offersCards = listed.some(({ slice }) => slice.discardDraft !== null)
  return {
    workspaces: workspaces.length ? workspaces : NO_WORKSPACES,
    sessions: sessions.length ? sessions : NO_SESSIONS,
    drafts: drafts.length ? drafts : NO_DRAFTS,
    ...(offersCards
      ? {
          // Through the card's own environment: the same id elsewhere is another draft.
          discardDraft: (draft: HomeDraft) => {
            const environmentId = draft.environment?.environmentId
            listed
              .find(({ slice }) => slice.environmentId === environmentId)
              ?.slice.discardDraft?.(draft.draftId)
          },
        }
      : {}),
  }
}

/** The home's source, from what the phone and its environments say. Pure. */
export function homeSourceOf(
  inputs: HomeSourceInputs,
  rows: HomeRows = homeRowsOf(inputs.connection.environments, inputs.slices),
): HomeSource {
  const { connection } = inputs
  const anyPaired = connection.environments.some((item) => item.paired)
  // Reading what the phone saved is not knowing it has nothing.
  if (inputs.fixture && !anyPaired && connection.loaded) return FIXTURE_SOURCE
  const selected = connection.selectedId ? connection.links[connection.selectedId] : undefined
  return {
    kind: 'environment',
    environment: homeEnvironmentOf(connection),
    environments: homeEnvironmentsOf(connection, inputs.slices),
    connected: selected?.status === 'connected',
    // Nothing saved, or no saved environment's token is left (refused for
    // certain, or unreadable): either way the next step is pairing.
    needsPairing: connection.loaded && !anyPaired,
    ...rows,
  }
}

/** The build's request for the fixture; Expo inlines `EXPO_PUBLIC_*` at bundle time. */
const FIXTURE_REQUESTED = process.env.EXPO_PUBLIC_FIXTURE === '1'

const NO_SLICES: readonly HomeSlice[] = []

function sameSlices(left: readonly HomeSlice[], right: readonly HomeSlice[]) {
  return (
    left.length === right.length &&
    left.every((slice, index) => {
      const other = right[index]!
      return (
        slice.environmentId === other.environmentId &&
        slice.workspaces === other.workspaces &&
        slice.sessions === other.sessions &&
        slice.drafts === other.drafts &&
        slice.discardDraft === other.discardDraft
      )
    })
  )
}

/**
 * Every connected environment's sidebar, read from its providers' scope. The
 * same array while none of them changed: a scope changes with a streamed
 * token, its sidebar does not.
 */
function useHomeSlices(): readonly HomeSlice[] {
  const last = useRef<readonly HomeSlice[]>(NO_SLICES)
  const read = useCallback(() => {
    const slices: HomeSlice[] = []
    for (const environmentId of environmentScopes.ids()) {
      const scope = environmentScopes.get(environmentId)
      if (!scope) continue
      const data = readScope(scope, SidebarDataContext)
      const sessions = readScope(scope, SidebarSessionsContext)
      const drafts = readScope(scope, SidebarDraftsContext)
      if (!data || !sessions) continue
      slices.push({
        environmentId,
        workspaces: data.workspaces,
        sessions,
        drafts: drafts?.drafts ?? null,
        discardDraft: drafts?.discardDraft ?? null,
      })
    }
    if (!sameSlices(last.current, slices)) last.current = slices.length ? slices : NO_SLICES
    return last.current
  }, [])
  return useSyncExternalStore(environmentScopes.subscribeAll, read, read)
}

/**
 * The home's source. Works with no environment connected yet (nothing
 * paired, a first connect, a refused token): the lists are then empty, and
 * `environments` says where each one stands.
 */
export function useHomeSource(): HomeSource {
  const phone = usePhoneConnection()
  const slices = useHomeSlices()
  const { loaded, environments, selectedId, links, network } = phone
  // The rows change with the environments' sidebars, not with every report
  // of every connection.
  const rows = useMemo(() => homeRowsOf(environments, slices), [environments, slices])
  return useMemo(
    () =>
      homeSourceOf(
        {
          connection: { loaded, environments, selectedId, links, network },
          slices,
          fixture: FIXTURE_REQUESTED,
        },
        rows,
      ),
    [loaded, environments, selectedId, links, network, slices, rows],
  )
}

const NO_SIDEBAR_SESSIONS: SidebarSessionsByWorkspace = {}

/**
 * The sessions of the page's own environment, tagged as the home tags them,
 * read from the providers the page is under (`EnvironmentPage`). Empty
 * outside one. The same list while that environment's sidebar is.
 */
export function usePageSessions(): HomeSession[] {
  const environmentId = usePageEnvironmentId()
  const byWorkspace = useContext(SidebarSessionsContext) ?? NO_SIDEBAR_SESSIONS
  const label = useEnvironmentLabel(environmentId)
  return useMemo(() => {
    if (!environmentId) return NO_SESSIONS
    const rows = homeSessionsOf(byWorkspace, { environmentId, label: label ?? environmentId })
    return rows.length ? rows : NO_SESSIONS
  }, [byWorkspace, environmentId, label])
}

/** The projects of the page's own environment; empty outside an `EnvironmentPage`. */
export function usePageWorkspaces(): WorkspaceEntry[] {
  return useContext(SidebarDataContext)?.workspaces ?? NO_WORKSPACES
}
