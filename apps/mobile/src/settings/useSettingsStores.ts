import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'

import { createDeviceAdmin, type DeviceAdmin, type DeviceAdminState } from './device-admin'
import { createTitleSetting, type TitleSetting, type TitleSettingState } from './title-generation'

type Store<S> = {
  getState(): S
  subscribe(listener: () => void): () => void
  start(): () => void
}

const noSubscribe = () => () => undefined
const noState = () => null

/**
 * One store per client for as long as the screen shows it: a new client (a
 * different environment, or a new token) starts a fresh one, so nothing of
 * the last environment's devices or settings shows while this one's load.
 * Creating a store does nothing; it listens and reads while mounted. With no
 * client (not this phone's environment in use, or not connected yet) there
 * is no store and no state.
 */
function useStarted<S, T extends Store<S>>(store: T | null): [T | null, S | null] {
  useEffect(() => (store ? store.start() : undefined), [store])
  const state = useSyncExternalStore<S | null>(
    store ? store.subscribe : noSubscribe,
    store ? store.getState : noState,
  )
  return [store, state]
}

export function useDeviceAdmin(
  client: EnvironmentClient | null,
  environmentId: string,
): [DeviceAdmin | null, DeviceAdminState | null] {
  const store = useMemo(
    () => (client ? createDeviceAdmin(client, environmentId) : null),
    [client, environmentId],
  )
  return useStarted<DeviceAdminState, DeviceAdmin>(store)
}

export function useTitleSetting(
  client: EnvironmentClient | null,
): [TitleSetting | null, TitleSettingState | null] {
  const store = useMemo(() => (client ? createTitleSetting(client) : null), [client])
  return useStarted<TitleSettingState, TitleSetting>(store)
}
