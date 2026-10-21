/**
 * Where the home reads its sessions from. Today that is the fixture, so the
 * shell can be built and reviewed before the phone speaks the environment
 * protocol; the sessions-list issue swaps this hook for the shared sidebar
 * providers (`useSidebarData` / `useSidebarSessions`) without touching the
 * screens, which only see this shape.
 */
import { useMemo } from 'react'
import type { WorkspaceEntry } from '@openmanager/app-core/providers/sidebar-provider'

import {
  FIXTURE_DRAFTS,
  FIXTURE_ENVIRONMENT,
  FIXTURE_SESSIONS,
  FIXTURE_WORKSPACES,
  type FixtureEnvironment,
} from './fixture'
import type { HomeDraft, HomeSession } from './rows'

export interface HomeSource {
  /** Where these sessions live: the fixture has no page behind a row yet. */
  kind: 'fixture' | 'environment'
  environment: FixtureEnvironment | null
  connected: boolean
  workspaces: WorkspaceEntry[]
  sessions: HomeSession[]
  drafts: HomeDraft[]
}

export function useHomeSource(): HomeSource {
  return useMemo(
    () => ({
      kind: 'fixture' as const,
      environment: FIXTURE_ENVIRONMENT,
      connected: true,
      workspaces: FIXTURE_WORKSPACES,
      sessions: FIXTURE_SESSIONS,
      drafts: FIXTURE_DRAFTS,
    }),
    [],
  )
}
