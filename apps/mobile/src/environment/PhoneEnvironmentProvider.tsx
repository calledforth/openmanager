import { router, usePathname } from 'expo-router'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  EnvironmentApplicationProviders,
  EnvironmentClientProvider,
} from '@openmanager/app-core/logic'
import {
  EnvironmentAvailabilityContext,
  type EnvironmentAvailability,
} from '@openmanager/app-core/providers/environment-availability'
import {
  EnvironmentScopeProvider,
  useEnvironmentScope,
  type EnvironmentScope,
} from '@openmanager/app-core/providers/environment-scope'
import {
  DraftDiscardsContext,
  useDraftDiscards,
} from '@openmanager/app-core/providers/environment-sidebar-drafts'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { sendBlockedReason } from '@openmanager/environment-client/connection'
import type { NativeWebSocketConstructor } from './app-origin'
import { phoneConnectionView } from './connection-ui'
import {
  createPhoneConnectionController,
  linkOf,
  statusOf,
  type PhoneConnectionController,
  type PhoneConnectionState,
  type PhoneConnectionStatus,
} from './controller'
import { DraftDiscardHost } from '../draft/DraftDiscardHost'
import { sessionWatch } from '../notifications'
import { phoneStorage, subscribePhonePageExit } from '../storage'
import { landingFor, landingOf } from './landing-route'
import { appActivity, deviceNetwork } from './lifecycle'
import { createPhoneNavigation, type PhoneNavigation } from './navigation'
import { createPhoneFetch, type BlobRequest } from './phone-fetch'
import { missingRuntimeFills, type RuntimeScope } from './runtime-fills'
import { createScopeRegistry } from './scopes'

/**
 * One controller for the app's lifetime, created on first use. It is never
 * disposed: the app process ending is its end.
 */
let controller: PhoneConnectionController | null = null

function phoneController(): PhoneConnectionController {
  if (!controller) {
    controller = createPhoneConnectionController({
      storage: phoneStorage,
      // Turned-on session notices keep the connections in the background.
      activity: sessionWatch.activity(appActivity),
      network: deviceNetwork,
      // React Native's own socket and fetch. Passed explicitly so nothing
      // depends on which globals a later polyfill replaces. Reads go through
      // its XMLHttpRequest, whose Blob a kept image can be shown from.
      transport: {
        WebSocket: globalThis.WebSocket as unknown as NativeWebSocketConstructor,
        fetch: createPhoneFetch({
          fetch: globalThis.fetch,
          createRequest: () => new XMLHttpRequest() as unknown as BlobRequest,
        }),
        // The fill `polyfills.ts` installed where the runtime had none.
        requestId: () => globalThis.crypto.randomUUID(),
      },
    })
    sessionWatch.attach(controller)
    void sessionWatch.start()
  }
  return controller
}

type PhoneConnectionValue = {
  controller: PhoneConnectionController
  /** Runtime pieces still missing after `polyfills.ts`; the connection does not start. */
  missingFills: readonly string[]
}

const PhoneConnectionContext = createContext<PhoneConnectionValue | null>(null)

function usePhoneConnectionValue(): PhoneConnectionValue {
  const value = useContext(PhoneConnectionContext)
  if (!value) throw new Error('usePhoneConnection must be used within a PhoneEnvironmentProvider')
  return value
}

/** Where the phone's connections stand. Re-renders on every change to any of them. */
export function usePhoneConnection(): PhoneConnectionState {
  const { controller } = usePhoneConnectionValue()
  return useSyncExternalStore(controller.subscribe, controller.getState)
}

/** The controller's actions: select, save or remove an environment, retry. */
export function usePhoneConnectionController(): PhoneConnectionController {
  return usePhoneConnectionValue().controller
}

/** Runtime pieces missing after the polyfills ran; empty when all is well. */
export function useMissingRuntimeFills(): readonly string[] {
  return usePhoneConnectionValue().missingFills
}

/** One environment's client, while the phone holds one for it. */
export function useEnvironmentClientFor(
  environmentId: string | null | undefined,
): EnvironmentClient | null {
  const { controller } = usePhoneConnectionValue()
  const read = useCallback(
    () => linkOf(controller.getState(), environmentId)?.client ?? null,
    [controller, environmentId],
  )
  return useSyncExternalStore(controller.subscribe, read, read)
}

/** One environment's connection status, re-rendering only when that changes. */
export function useEnvironmentStatus(
  environmentId: string | null | undefined,
): PhoneConnectionStatus {
  const { controller } = usePhoneConnectionValue()
  const read = useCallback(
    () => statusOf(controller.getState(), environmentId),
    [controller, environmentId],
  )
  return useSyncExternalStore(controller.subscribe, read, read)
}

/** One saved environment's label, re-rendering only when that changes; null when not saved. */
export function useEnvironmentLabel(environmentId: string | null | undefined): string | null {
  const { controller } = usePhoneConnectionValue()
  const read = useCallback(
    () =>
      controller.getState().environments.find((item) => item.environmentId === environmentId)
        ?.label ?? null,
    [controller, environmentId],
  )
  return useSyncExternalStore(controller.subscribe, read, read)
}

/** The connection status of the environment of the page this renders in. */
export function usePageConnectionStatus(): PhoneConnectionStatus {
  return useEnvironmentStatus(usePageEnvironmentId())
}

/**
 * Where each environment's shared session state navigates: a session's page,
 * its blank new-session page, a draft's own page, every address that
 * environment's (`landing-route.ts`). Given `navigateDraft`, the application
 * providers also serve the environment's draft cards (`useSidebarDrafts`),
 * which only hosts with draft pages get.
 */
const navigations = new Map<string, PhoneNavigation>()
let pathInFront = ''

const phoneRouter = {
  push: (href: string) => router.push(href as never),
  replace: (href: string) => router.replace(href as never),
  setParams: (params: Record<string, string>) => router.setParams(params as never),
}

function navigationFor(environmentId: string): PhoneNavigation {
  let navigation = navigations.get(environmentId)
  if (!navigation) {
    navigation = createPhoneNavigation(phoneRouter, {
      environmentId,
      // A launch that finished after the reader left its page: no page holds
      // the session it selected, so it is let go (a session page opens it again).
      stayed: (sessionId) => {
        const client = controller ? linkOf(controller.getState(), environmentId)?.client : null
        if (client?.getState().activeSessionId === sessionId) client.setActiveSession(null)
      },
    })
    navigation.arrived(pathInFront)
    navigations.set(environmentId, navigation)
  }
  return navigation
}

/** What each connected environment's providers serve, for its pages and the home. */
export const environmentScopes = createScopeRegistry()

const missingFills = missingRuntimeFills(
  globalThis as unknown as RuntimeScope & { URL?: typeof URL },
)

/** Renders nothing: hands the scope of the providers it sits in to `environmentScopes`. */
function ScopePublisher({ environmentId }: { environmentId: string }) {
  const scope = useEnvironmentScope()
  const published = useRef<EnvironmentScope | null>(null)
  // In a layout effect, so a page reading it re-renders before anything is painted.
  useLayoutEffect(() => {
    published.current = scope
    environmentScopes.set(environmentId, scope)
  }, [environmentId, scope])
  useLayoutEffect(
    () => () => {
      if (published.current) environmentScopes.delete(environmentId, published.current)
    },
    [environmentId],
  )
  return null
}

const ONE_ENVIRONMENT: EnvironmentAvailability | null = null

/**
 * With several environments, what the providers of one say about it beyond
 * what its client knows: its name for failures, and why a send or an answer
 * is held while it is down (the shared rule, `sendBlockedReason`). With one,
 * nothing, and everything reads as it always did. Re-renders only when that
 * changes, not with every report of every connection.
 */
function useAvailability(environmentId: string): EnvironmentAvailability | null {
  const { controller } = usePhoneConnectionValue()
  const read = useCallback(() => {
    const state = controller.getState()
    const label = state.environments.find((item) => item.environmentId === environmentId)?.label
    if (state.environments.length < 2 || !label) return ''
    const blocked = sendBlockedReason(phoneConnectionView(state, environmentId).ui, label)
    return JSON.stringify([label, blocked])
  }, [controller, environmentId])
  const key = useSyncExternalStore(controller.subscribe, read, read)
  return useMemo(() => {
    if (!key) return ONE_ENVIRONMENT
    const [name, blocked] = JSON.parse(key) as [string, string | null]
    return { name, sendBlockedReason: blocked }
  }, [key])
}

/**
 * One connected environment's providers, beside the navigator rather than
 * around it: its pages are rendered by the navigator, and take what these
 * serve through `EnvironmentPage`. Kept while its client is (through a hold,
 * a network gap and a change of route), so what its pages show stays.
 */
const EnvironmentHost = memo(function EnvironmentHost({
  environmentId,
  client,
  onLanding,
  landingDraftId,
}: {
  environmentId: string
  client: EnvironmentClient
  onLanding: boolean
  landingDraftId: string | null
}) {
  const navigation = navigationFor(environmentId)
  const availability = useAvailability(environmentId)
  // The same elements while the environment is, so a landing change or a new
  // availability re-renders the providers, not what they hold.
  const inside = useMemo(
    () => (
      <>
        <ScopePublisher environmentId={environmentId} />
        <DraftDiscardHost environmentId={environmentId} />
      </>
    ),
    [environmentId],
  )
  return (
    <EnvironmentAvailabilityContext.Provider value={availability}>
      <EnvironmentClientProvider client={client}>
        <EnvironmentApplicationProviders
          environmentId={environmentId}
          storage={phoneStorage.device}
          subscribePageExit={subscribePhonePageExit}
          navigateSession={navigation.navigateSession}
          navigateDraft={navigation.navigateDraft}
          onLanding={onLanding}
          landingDraftId={landingDraftId}
        >
          {inside}
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>
    </EnvironmentAvailabilityContext.Provider>
  )
})

/**
 * The root of the phone's environment wiring. It owns the connection
 * controller and, for every environment whose client the environment has
 * accepted, a set of app-core's `EnvironmentApplicationProviders` with the
 * phone's device storage and its app-exit hook.
 *
 * The providers sit beside the navigator, not around it: a page of any
 * environment can be on the stack at once (a session of one under a
 * notification's session of another), each page takes its own environment's
 * scope (`EnvironmentPage`), and an environment coming or going never
 * remounts the navigator. Screens render with or without one: with none
 * (nothing paired, connecting for the first time, a refused token) they read
 * `usePhoneConnection()`; inside an `EnvironmentPage` they can use every
 * app-core contract of that environment.
 *
 * One discard window serves every environment's draft cards
 * (`DraftDiscardsContext`), so the undo on the home is one, whichever
 * environment the draft is on.
 */
export function PhoneEnvironmentProvider({ children }: { children: ReactNode }) {
  const value = phoneConnectionValue()
  const state = useSyncExternalStore(value.controller.subscribe, value.controller.getState)
  // The page in front, as each environment's shared session state reads it:
  // a new-session page of that environment holds a draft ready on arrival,
  // as web's `/` and `/drafts/<id>` do.
  const pathname = usePathname()
  const landing = landingOf(pathname)
  useLayoutEffect(() => {
    pathInFront = pathname
    for (const navigation of navigations.values()) navigation.arrived(pathname)
    sessionWatch.arrived(pathname)
  }, [pathname])

  useEffect(() => {
    if (value.missingFills.length > 0) {
      console.error(
        `The phone's runtime is missing ${value.missingFills.join(', ')}; not connecting.`,
      )
      return
    }
    void value.controller.start()
  }, [value])

  const latestClient = useCallback(
    (environmentId: string) =>
      linkOf(value.controller.getState(), environmentId)?.client ?? undefined,
    [value],
  )
  const discards = useDraftDiscards(latestClient)

  return (
    <PhoneConnectionContext.Provider value={value}>
      <DraftDiscardsContext.Provider value={discards}>
        {state.environments.map(({ environmentId }) => {
          const client = state.links[environmentId]?.client
          const own = landingFor(landing, environmentId)
          return client ? (
            <EnvironmentHost
              key={environmentId}
              environmentId={environmentId}
              client={client}
              onLanding={own.onLanding}
              landingDraftId={own.draftId}
            />
          ) : null
        })}
        {children}
      </DraftDiscardsContext.Provider>
    </PhoneConnectionContext.Provider>
  )
}

let stableValue: PhoneConnectionValue | null = null

/** The context value never changes identity, so consumers of it never re-render for it. */
function phoneConnectionValue(): PhoneConnectionValue {
  if (!stableValue) stableValue = { controller: phoneController(), missingFills }
  return stableValue
}

/** One environment's scope, while its providers are up; null otherwise. */
export function useEnvironmentScopeOf(
  environmentId: string | null | undefined,
): EnvironmentScope | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      environmentId ? environmentScopes.subscribe(environmentId, listener) : () => undefined,
    [environmentId],
  )
  const read = useCallback(
    () => (environmentId ? environmentScopes.get(environmentId) : null),
    [environmentId],
  )
  return useSyncExternalStore(subscribe, read, read)
}

/** The environment of the page this renders in; null outside an `EnvironmentPage`. */
const PageEnvironmentContext = createContext<string | null>(null)

/** The environment of the page this renders in, as its address names it. */
export function usePageEnvironmentId(): string | null {
  return useContext(PageEnvironmentContext)
}

/**
 * A page of one environment: everything under it reads that environment's
 * client and providers, whatever other environment's page is under or over
 * it on the stack. `fallback` shows while the environment has no client the
 * phone can use (connecting for the first time, refused, not saved).
 */
export function EnvironmentPage({
  environmentId,
  fallback,
  children,
}: {
  environmentId: string
  fallback: ReactNode
  children: ReactNode
}) {
  const scope = useEnvironmentScopeOf(environmentId)
  const availability = useAvailability(environmentId)
  return (
    <PageEnvironmentContext.Provider value={environmentId}>
      {scope ? (
        <EnvironmentAvailabilityContext.Provider value={availability}>
          <EnvironmentScopeProvider scope={scope}>{children}</EnvironmentScopeProvider>
        </EnvironmentAvailabilityContext.Provider>
      ) : (
        fallback
      )}
    </PageEnvironmentContext.Provider>
  )
}
