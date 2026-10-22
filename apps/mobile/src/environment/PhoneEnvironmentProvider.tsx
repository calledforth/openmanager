import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import {
  EnvironmentApplicationProviders,
  EnvironmentClientProvider,
} from '@openmanager/app-core/logic'
import type { NativeWebSocketConstructor } from './app-origin'
import {
  createPhoneConnectionController,
  type PhoneConnectionController,
  type PhoneConnectionState,
} from './controller'
import { phoneStorage, subscribePhonePageExit } from '../storage'
import { appActivity, deviceNetwork } from './lifecycle'
import { missingRuntimeFills, type RuntimeScope } from './runtime-fills'

/**
 * One controller for the app's lifetime, created on first use. It is never
 * disposed: the app process ending is its end.
 */
let controller: PhoneConnectionController | null = null

function phoneController(): PhoneConnectionController {
  if (!controller) {
    controller = createPhoneConnectionController({
      storage: phoneStorage,
      activity: appActivity,
      network: deviceNetwork,
      // React Native's own socket and fetch. Passed explicitly so nothing
      // depends on which globals a later polyfill replaces.
      transport: {
        WebSocket: globalThis.WebSocket as unknown as NativeWebSocketConstructor,
        fetch: globalThis.fetch,
        // The fill `polyfills.ts` installed where the runtime had none.
        requestId: () => globalThis.crypto.randomUUID(),
      },
    })
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

/** Where the phone's connection stands. Re-renders on every change to it. */
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

const missingFills = missingRuntimeFills(
  globalThis as unknown as RuntimeScope & { URL?: typeof URL },
)

/**
 * The root of the phone's environment wiring. It owns the connection
 * controller, hands the controller's client to app-core's
 * `EnvironmentClientProvider`, and, once the environment has accepted that
 * client, mounts `EnvironmentApplicationProviders` with the phone's device
 * storage and its app-exit hook.
 *
 * Screens render in both states: with no client (nothing paired, connecting
 * for the first time, a refused token) they sit outside the application
 * providers and read `usePhoneConnection()`; with one they can use every
 * app-core contract. The application providers are keyed by environment, so a
 * different environment starts them fresh, while a background hold, a network
 * gap or a change of route keeps them, and what they show, in place.
 */
export function PhoneEnvironmentProvider({ children }: { children: ReactNode }) {
  const value = phoneConnectionValue()
  const state = useSyncExternalStore(value.controller.subscribe, value.controller.getState)

  useEffect(() => {
    if (value.missingFills.length > 0) {
      console.error(
        `The phone's runtime is missing ${value.missingFills.join(', ')}; not connecting.`,
      )
      return
    }
    void value.controller.start()
  }, [value])

  return (
    <PhoneConnectionContext.Provider value={value}>
      <EnvironmentClientProvider client={state.client}>
        {state.client ? (
          <EnvironmentApplicationProviders
            key={state.selectedId ?? undefined}
            storage={phoneStorage.device}
            subscribePageExit={subscribePhonePageExit}
          >
            {children}
          </EnvironmentApplicationProviders>
        ) : (
          children
        )}
      </EnvironmentClientProvider>
    </PhoneConnectionContext.Provider>
  )
}

let stableValue: PhoneConnectionValue | null = null

/** The context value never changes identity, so consumers of it never re-render for it. */
function phoneConnectionValue(): PhoneConnectionValue {
  if (!stableValue) stableValue = { controller: phoneController(), missingFills }
  return stableValue
}
