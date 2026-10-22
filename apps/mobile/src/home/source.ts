/**
 * Where the home reads from. The environment line is the connection
 * controller's: the selected environment's label, and while its socket is up
 * the kind of route in use. The sessions are still the fixture, so the shell
 * can be built and reviewed before the phone speaks the session protocol;
 * the sessions-list issue swaps them for the shared sidebar providers
 * (`useSidebarData` / `useSidebarSessions`) without touching the screens,
 * which only see this shape. With nothing paired there is nothing to list.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { WorkspaceEntry } from '@openmanager/app-core/providers/sidebar-provider'

import { environmentLine, type EnvironmentLine } from '../environment/connected-route'
import { usePhoneConnectionController } from '../environment/PhoneEnvironmentProvider'
import { FIXTURE_DRAFTS, FIXTURE_SESSIONS, FIXTURE_WORKSPACES } from './fixture'
import type { HomeDraft, HomeSession } from './rows'

export interface HomeSource {
  /** Where these sessions live: the fixture has no page behind a row yet. */
  kind: 'fixture' | 'environment'
  /** The selected environment as the controller reports it; `null` with none saved. */
  environment: EnvironmentLine | null
  connected: boolean
  /** The controller has loaded and holds no environment: the phone needs pairing. */
  needsPairing: boolean
  workspaces: WorkspaceEntry[]
  sessions: HomeSession[]
  drafts: HomeDraft[]
}

/**
 * The few facts the home shows from the controller, as one string, so the
 * many screens reading this re-render only when one of them changes, not on
 * every report from the socket.
 */
type HomeFacts = { line: EnvironmentLine | null; saved: boolean; needsPairing: boolean }

export function useHomeSource(): HomeSource {
  const controller = usePhoneConnectionController()
  const read = useCallback(() => {
    const state = controller.getState()
    const facts: HomeFacts = {
      line: environmentLine(state),
      saved: state.environments.length > 0,
      needsPairing: state.status === 'no_environment',
    }
    return JSON.stringify(facts)
  }, [controller])
  const key = useSyncExternalStore(controller.subscribe, read)
  return useMemo(() => {
    const { line, saved, needsPairing } = JSON.parse(key) as HomeFacts
    return {
      kind: 'fixture' as const,
      environment: line,
      connected: line?.connected ?? false,
      needsPairing,
      workspaces: saved ? FIXTURE_WORKSPACES : [],
      sessions: saved ? FIXTURE_SESSIONS : [],
      drafts: saved ? FIXTURE_DRAFTS : [],
    }
  }, [key])
}
