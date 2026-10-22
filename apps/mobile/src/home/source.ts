/**
 * Where the home reads its sessions from: the shared sidebar providers of the
 * paired environment, normalised here into the shell's shapes so the screens
 * never see a provider's own. Nothing is guessed or merged: every status,
 * title, settle and draft is the environment's, passed through as it came.
 *
 * The fixture (`fixture.ts`) is the source only on a phone with nothing
 * paired, and only when the build asks for it (`EXPO_PUBLIC_FIXTURE=1`), so
 * the shell can still be shown without a server. Otherwise an unpaired phone
 * shows the empty home.
 */
import { useContext, useMemo } from 'react'
import {
  isLoopbackEnvironmentEndpoint,
  type EnvironmentRoute,
} from '@openmanager/environment-client/connection'
import {
  SidebarDataContext,
  SidebarSessionsContext,
  useSidebarDrafts,
  type SidebarDataValue,
  type SidebarDraft,
  type SidebarSessionEntry,
  type SidebarSessionsByWorkspace,
  type WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'

import { usePhoneConnection } from '../environment/PhoneEnvironmentProvider'
import type { PhoneConnectionState } from '../environment/controller'
import { isLocalNetworkEndpoint } from '../environment/route-order'
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

export interface HomeSource {
  /** `fixture`: the dev fixture, with no page behind a row. */
  kind: 'fixture' | 'environment'
  environment: HomeEnvironment | null
  connected: boolean
  /**
   * The home offers pairing: the controller has loaded and holds no
   * environment, or holds no token for the selected one.
   */
  needsPairing: boolean
  workspaces: WorkspaceEntry[]
  sessions: HomeSession[]
  drafts: HomeDraft[]
}

/** What the source is made from: the controller's state and the shared providers. */
export interface HomeSourceInputs {
  connection: Pick<PhoneConnectionState, 'status' | 'environments' | 'selectedId' | 'endpoint'>
  /** Null while the environment has not accepted this phone's client. */
  sidebar: Pick<SidebarDataValue, 'workspaces'> | null
  sessionsByWorkspace: SidebarSessionsByWorkspace | null
  /** Null on a host without draft cards, or while there is no client. */
  drafts: readonly SidebarDraft[] | null
  /** The build asked for the fixture (`EXPO_PUBLIC_FIXTURE=1`). */
  fixture: boolean
}

const NO_WORKSPACES: WorkspaceEntry[] = []
const NO_SESSIONS: HomeSession[] = []
const NO_DRAFTS: HomeDraft[] = []

const FIXTURE_SOURCE: HomeSource = {
  kind: 'fixture',
  environment: FIXTURE_ENVIRONMENT,
  connected: true,
  needsPairing: false,
  workspaces: FIXTURE_WORKSPACES,
  sessions: FIXTURE_SESSIONS,
  drafts: FIXTURE_DRAFTS,
}

/** The environment the phone is set to, when it holds a token for it. */
function selectedEnvironment(connection: HomeSourceInputs['connection']) {
  return connection.environments.find((item) => item.environmentId === connection.selectedId)
}

function routeKind(endpoint: string): HomeEnvironment['route']['kind'] {
  return isLoopbackEnvironmentEndpoint(endpoint) || isLocalNetworkEndpoint(endpoint)
    ? 'local'
    : 'tunnel'
}

/**
 * The selected environment as the title's line shows it: its saved label,
 * and the route in use (else its first saved one). Null with nothing selected.
 */
export function homeEnvironmentOf(
  connection: HomeSourceInputs['connection'],
): HomeEnvironment | null {
  const environment = selectedEnvironment(connection)
  if (!environment) return null
  // A saved environment always has a route.
  const routes: readonly EnvironmentRoute[] = environment.routes
  const address = connection.endpoint ?? routes[0]?.endpoint ?? ''
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    route: { kind: routeKind(address), address },
  }
}

/**
 * Rows by the shared entry they were made from: the provider keeps an entry
 * the same object while nothing it shows changed, so its row does too, and a
 * status change elsewhere re-renders no other row.
 */
const rowsByEntry = new WeakMap<SidebarSessionEntry, HomeSession>()

/**
 * The provider's sessions, grouped by workspace path, as one list of rows
 * that each know their workspace. Order is the list selectors' to decide;
 * every field of the entry passes through untouched.
 */
export function homeSessionsOf(byWorkspace: SidebarSessionsByWorkspace): HomeSession[] {
  const rows: HomeSession[] = []
  for (const [workspacePath, entries] of Object.entries(byWorkspace)) {
    for (const entry of entries) {
      let row = rowsByEntry.get(entry)
      if (!row || row.workspacePath !== workspacePath) {
        row = { ...entry, workspacePath }
        rowsByEntry.set(entry, row)
      }
      rows.push(row)
    }
  }
  return rows
}

/** The home's source, from what the phone and its environment say. Pure. */
export function homeSourceOf(
  inputs: HomeSourceInputs,
  sessions: HomeSession[] = inputs.sessionsByWorkspace
    ? homeSessionsOf(inputs.sessionsByWorkspace)
    : NO_SESSIONS,
): HomeSource {
  const { connection } = inputs
  const paired = selectedEnvironment(connection)?.paired === true
  // Reading what the phone saved is not knowing it has nothing.
  if (inputs.fixture && !paired && connection.status !== 'starting') return FIXTURE_SOURCE
  return {
    kind: 'environment',
    environment: homeEnvironmentOf(connection),
    connected: connection.status === 'connected',
    // Nothing saved, or the selected environment's token is gone (refused for
    // certain, or unreadable): either way the next step is pairing.
    needsPairing:
      connection.status === 'no_environment' ||
      (connection.status !== 'starting' && selectedEnvironment(connection)?.paired === false),
    workspaces: inputs.sidebar?.workspaces ?? NO_WORKSPACES,
    sessions,
    drafts: (inputs.drafts as HomeDraft[] | null) ?? NO_DRAFTS,
  }
}

/** The build's request for the fixture; Expo inlines `EXPO_PUBLIC_*` at bundle time. */
const FIXTURE_REQUESTED = process.env.EXPO_PUBLIC_FIXTURE === '1'

/**
 * The home's source. Works on both sides of the application providers: with
 * no client yet (nothing paired, a first connect, a refused token) the
 * sidebar contexts are absent and the lists are empty.
 */
export function useHomeSource(): HomeSource {
  const phone = usePhoneConnection()
  const sidebar = useContext(SidebarDataContext)
  const sessionsByWorkspace = useContext(SidebarSessionsContext)
  const drafts = useSidebarDrafts()?.drafts ?? null
  const { status, environments, selectedId, endpoint } = phone
  const sessions = useMemo(
    () => (sessionsByWorkspace ? homeSessionsOf(sessionsByWorkspace) : NO_SESSIONS),
    [sessionsByWorkspace],
  )
  const workspaces = sidebar?.workspaces
  return useMemo(
    () =>
      homeSourceOf(
        {
          connection: { status, environments, selectedId, endpoint },
          sidebar: workspaces ? { workspaces } : null,
          sessionsByWorkspace,
          drafts,
          fixture: FIXTURE_REQUESTED,
        },
        sessions,
      ),
    [status, environments, selectedId, endpoint, workspaces, sessionsByWorkspace, drafts, sessions],
  )
}
