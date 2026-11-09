import { use, useRef, type Context, type ReactNode } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { ComposerDraftStoreContext } from '../components/chat/composerDraftStore'
import { ActiveThreadStateContext, ActiveThreadStoresContext } from './active-thread-provider'
import { ComposerStateContext } from './composer-provider'
import { DeviceHostContext } from './device-host'
import { DraftPageContext, DraftPageNavigationContext, DraftPicksContext } from './draft-pages'
import { DraftInternalsContext } from './environment-application'
import { EnvironmentClientProvider, useEnvironmentClientOptional } from './environment-client'
import { DraftLaunchContext } from './environment-composer'
import { PermissionStateContext } from './permission-provider'
import { PlanStateContext } from './plan-provider'
import { PlatformCapabilitiesContext } from './platform-provider'
import { QuestionStateContext } from './question-provider'
import { SessionStateContext } from './session-provider'
import {
  SidebarDataContext,
  SidebarDraftsContext,
  SidebarSessionsContext,
} from './sidebar-provider'
import { TurnRecoveryContext } from './turn-recovery'
import { ViewActionsContext, WorkspaceIconContext } from './view-actions'

/**
 * Every context `EnvironmentApplicationProviders` serves. A context added
 * there is added here too, or a page reached through a scope goes without it
 * (`environment-scope.test.tsx` checks the hooks views read).
 */
const SCOPE_CONTEXTS: readonly Context<unknown>[] = [
  DeviceHostContext,
  PlatformCapabilitiesContext,
  SessionStateContext,
  DraftInternalsContext,
  DraftPageContext,
  DraftPageNavigationContext,
  ComposerStateContext,
  DraftLaunchContext,
  DraftPicksContext,
  ComposerDraftStoreContext,
  SidebarDataContext,
  SidebarSessionsContext,
  SidebarDraftsContext,
  ActiveThreadStoresContext,
  ActiveThreadStateContext,
  TurnRecoveryContext,
  PermissionStateContext,
  QuestionStateContext,
  PlanStateContext,
  ViewActionsContext,
  WorkspaceIconContext,
] as readonly Context<unknown>[]

/**
 * What one environment's providers serve, read inside them: its client and
 * every value its views read. The same object while none of them changed.
 */
export interface EnvironmentScope {
  readonly client: EnvironmentClient | null
  readonly values: readonly unknown[]
}

/**
 * Reads the environment's providers, from inside them, for a host whose
 * pages are not rendered under them. The phone keeps one set of providers
 * per connected environment beside its navigator, so a page of any of them
 * can be on the stack at once, and each page takes its own environment's
 * scope (`EnvironmentScopeProvider`).
 *
 * The same object comes back while nothing in it changed, so a host that
 * hands it on in an effect hands on only changes.
 */
export function useEnvironmentScope(): EnvironmentScope {
  const client = useEnvironmentClientOptional()
  // `use` may be called in a loop; the list never changes, so the order holds.
  const values: unknown[] = []
  for (const context of SCOPE_CONTEXTS) values.push(use(context))
  const last = useRef<EnvironmentScope | null>(null)
  const previous = last.current
  if (
    previous &&
    previous.client === client &&
    previous.values.every((value, index) => Object.is(value, values[index]))
  ) {
    return previous
  }
  const next: EnvironmentScope = { client, values }
  last.current = next
  return next
}

/**
 * Serves a scope read by `useEnvironmentScope` to `children`, as if they
 * were rendered inside that environment's providers. Only values change
 * hands: the providers, and everything they keep, stay where they are.
 */
export function EnvironmentScopeProvider({
  scope,
  children,
}: {
  scope: EnvironmentScope
  children: ReactNode
}) {
  let tree = children
  for (let index = SCOPE_CONTEXTS.length - 1; index >= 0; index -= 1) {
    const Provider = SCOPE_CONTEXTS[index]!.Provider
    tree = <Provider value={scope.values[index]}>{tree}</Provider>
  }
  return <EnvironmentClientProvider client={scope.client}>{tree}</EnvironmentClientProvider>
}

/**
 * One context's value in a scope, for a host that reads a scope outside a
 * page (the phone's home lists every environment's sidebar). Undefined for a
 * context the scope does not carry.
 */
export function readScope<T>(scope: EnvironmentScope, context: Context<T>): T | undefined {
  const index = SCOPE_CONTEXTS.indexOf(context as Context<unknown>)
  return index === -1 ? undefined : (scope.values[index] as T)
}
