// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useContext, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMockEnvironmentClient } from '@openmanager/environment-client'
import { ComposerDraftStoreContext } from '../src/components/chat/composerDraftStore'
import {
  ActiveThreadStateContext,
  ActiveThreadStoresContext,
} from '../src/providers/active-thread-provider'
import { ComposerStateContext } from '../src/providers/composer-provider'
import { DeviceHostContext } from '../src/providers/device-host'
import {
  DraftPageContext,
  DraftPageNavigationContext,
  DraftPicksContext,
} from '../src/providers/draft-pages'
import {
  DraftInternalsContext,
  EnvironmentApplicationProviders,
} from '../src/providers/environment-application'
import {
  EnvironmentClientProvider,
  useEnvironmentClientOptional,
} from '../src/providers/environment-client'
import { DraftLaunchContext } from '../src/providers/environment-composer'
import {
  EnvironmentScopeProvider,
  useEnvironmentScope,
  type EnvironmentScope,
} from '../src/providers/environment-scope'
import { PermissionStateContext } from '../src/providers/permission-provider'
import { PlanStateContext } from '../src/providers/plan-provider'
import { PlatformCapabilitiesContext } from '../src/providers/platform-provider'
import { QuestionStateContext } from '../src/providers/question-provider'
import { SessionStateContext } from '../src/providers/session-provider'
import {
  SidebarDataContext,
  SidebarDraftsContext,
  SidebarSessionsContext,
} from '../src/providers/sidebar-provider'
import { TurnRecoveryContext } from '../src/providers/turn-recovery'
import { ViewActionsContext, WorkspaceIconContext } from '../src/providers/view-actions'

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false },
  exists: true,
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** What views read, context by context: the providers' list, and the client. */
function useEverything() {
  return {
    client: useEnvironmentClientOptional(),
    device: useContext(DeviceHostContext),
    platform: useContext(PlatformCapabilitiesContext),
    session: useContext(SessionStateContext),
    draftInternals: useContext(DraftInternalsContext),
    draftPage: useContext(DraftPageContext),
    draftNavigation: useContext(DraftPageNavigationContext),
    composer: useContext(ComposerStateContext),
    draftLaunch: useContext(DraftLaunchContext),
    draftPicks: useContext(DraftPicksContext),
    composerDrafts: useContext(ComposerDraftStoreContext),
    sidebar: useContext(SidebarDataContext),
    sidebarSessions: useContext(SidebarSessionsContext),
    sidebarDrafts: useContext(SidebarDraftsContext),
    threadStores: useContext(ActiveThreadStoresContext),
    thread: useContext(ActiveThreadStateContext),
    recovery: useContext(TurnRecoveryContext),
    permission: useContext(PermissionStateContext),
    question: useContext(QuestionStateContext),
    plan: useContext(PlanStateContext),
    viewActions: useContext(ViewActionsContext),
    icons: useContext(WorkspaceIconContext),
  }
}

type Everything = ReturnType<typeof useEverything>

describe('an environment scope', () => {
  it('serves a page outside the providers exactly what they serve inside', async () => {
    const client = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE] } })
    let inside: Everything | null = null
    let outside: Everything | null = null
    let publish: (scope: EnvironmentScope) => void = () => undefined

    function Capture() {
      const scope = useEnvironmentScope()
      inside = useEverything()
      useLayoutEffect(() => publish(scope), [scope])
      return null
    }
    function Reader() {
      outside = useEverything()
      return null
    }
    function Page() {
      const [scope, setScope] = useState<EnvironmentScope | null>(null)
      publish = setScope
      return scope ? (
        <EnvironmentScopeProvider scope={scope}>
          <Reader />
        </EnvironmentScopeProvider>
      ) : null
    }

    await act(() =>
      root.render(
        <>
          <EnvironmentClientProvider client={client}>
            <EnvironmentApplicationProviders
              storage={null}
              navigateSession={async () => undefined}
              navigateDraft={async () => undefined}
            >
              <Capture />
            </EnvironmentApplicationProviders>
          </EnvironmentClientProvider>
          <Page />
        </>,
      ),
    )
    await act(() => client.settle())

    expect(inside).not.toBeNull()
    expect(outside).not.toBeNull()
    const served = inside as unknown as Everything
    const read = outside as unknown as Everything
    // Each value is the providers' own object, not a copy.
    for (const key of Object.keys(served) as (keyof Everything)[]) {
      expect(read[key], key).toBe(served[key])
    }
    // And the providers do serve each one here, so the check means something.
    expect(served.client).toBe(client)
    expect(served.session).not.toBeNull()
    expect(served.composer).not.toBeNull()
    expect(served.thread).not.toBeNull()
    expect(served.sidebar?.workspaces.map((workspace) => workspace.path)).toEqual(['C:/repo'])
  })

  it('stays the same object while nothing it serves changed', async () => {
    const client = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE] } })
    const scopes: EnvironmentScope[] = []
    function Capture() {
      scopes.push(useEnvironmentScope())
      return null
    }
    function Host({ tick }: { tick: number }) {
      return (
        <EnvironmentClientProvider client={client}>
          <EnvironmentApplicationProviders storage={null}>
            <Capture key="capture" />
            <span>{tick}</span>
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>
      )
    }
    await act(() => root.render(<Host tick={0} />))
    await act(() => client.settle())
    const before = scopes.at(-1)
    await act(() => root.render(<Host tick={1} />))
    expect(scopes.at(-1)).toBe(before)
  })
})
