import { createMemoryPhoneStorage, type PhoneStorage } from './phone-storage'

/**
 * The phone's storage, one instance for the app's lifetime. A stable
 * identity matters: app-core memoises its device host on `storage`, so a new
 * object per render would re-render every consumer and re-run their effects.
 *
 * In memory for now: the AsyncStorage registry and device stores and the
 * SecureStore credential store replace this one line.
 */
export const phoneStorage: PhoneStorage = createMemoryPhoneStorage()
