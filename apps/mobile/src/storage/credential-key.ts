/**
 * SecureStore keys may only use `[A-Za-z0-9._-]`; an environment ID may hold
 * any non-space character. Every character but `[A-Za-z0-9-]` (so `.` and `_`
 * too) becomes `_` and four hex digits of its UTF-16 code unit, so two IDs
 * never share a key and the encoded ID never contains a `.`.
 *
 * Each credential is written to its own slot, `<prefix><encoded id>.<slot>`,
 * with a slot ID made for that write. The credential manifest in AsyncStorage
 * names the slot in use (see `phone-storage.ts`), so an entry written by an
 * earlier install, or by a write that never finished, is never read.
 */
export const CREDENTIAL_KEY_PREFIX = 'openmanager.credential.'

/** Every slot key for this environment starts with this followed by `.`. */
export function credentialStoreKey(environmentId: string): string {
  let encoded = ''
  for (let index = 0; index < environmentId.length; index += 1) {
    const char = environmentId[index]!
    encoded += /[A-Za-z0-9-]/.test(char)
      ? char
      : `_${environmentId.charCodeAt(index).toString(16).padStart(4, '0')}`
  }
  return CREDENTIAL_KEY_PREFIX + encoded
}

/** Not a secret: it only has to differ from every slot written before. */
function slotId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** A fresh SecureStore key for one write of this environment's credential. */
export function credentialSlotKey(environmentId: string, slot: string = slotId()): string {
  return `${credentialStoreKey(environmentId)}.${slot}`
}

const SLOT_KEY = /^openmanager\.credential\.[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/

/** Whether `key` is a slot key this module makes, as read back from storage. */
export function isCredentialSlotKey(key: unknown): key is string {
  return typeof key === 'string' && SLOT_KEY.test(key)
}
