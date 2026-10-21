/**
 * The phone's storage, wired to the device: AsyncStorage for the registry
 * and device storage, SecureStore for credentials, `AppState` for "the app
 * is going away". Everything else in this folder is plain TypeScript and
 * runs under Node in the tests.
 *
 * At boot, before anything reads the registry:
 *
 *     await phoneStorage.hydrate()
 *
 * then hand `phoneStorage.registry` to the shared registry functions and
 * `phoneStorage.device` / `subscribePhonePageExit` to
 * `EnvironmentApplicationProviders`. See README.md in this folder.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { AppState } from 'react-native'
import { createAppStatePageExit } from './app-state'
import { createPhoneStorage } from './phone-storage'

/**
 * Readable once the phone has been unlocked after a restart, so a reconnect
 * in the background can read it; never copied to another device by an iCloud
 * Keychain or a backup restore. Every call passes the same options, since on
 * iOS they are part of what identifies the entry.
 */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
}

/** The one storage object for the life of the app: its identity never changes. */
export const phoneStorage = createPhoneStorage({
  asyncStore: AsyncStorage,
  secureStore: {
    getItemAsync: (key) => SecureStore.getItemAsync(key, SECURE_OPTIONS),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, SECURE_OPTIONS),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, SECURE_OPTIONS),
  },
  // Keys and causes only. A SecureStore key names an environment, never a credential.
  onError: ({ store, operation, key, cause }) => {
    console.warn(`Phone storage: ${store} ${operation} failed for ${key}`, cause)
  },
})

/** `SubscribePageExit` for `EnvironmentApplicationProviders`: leaving the foreground. */
export const subscribePhonePageExit = createAppStatePageExit(AppState)

export {
  confirmCredentialRejected,
  credentialRefusalOf,
  environmentNeedsPairing,
  forgetRejectedCredential,
} from './credential-rejection'
export { PhoneStorageNotReadyError, type PhoneStorage } from './phone-storage'
