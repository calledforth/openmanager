/**
 * SecureStore keys may only use `[A-Za-z0-9._-]`; an environment ID may hold
 * any non-space character. Every other character, `_` included, becomes `_`
 * and four hex digits of its UTF-16 code unit, so two IDs never share a key.
 */
export const CREDENTIAL_KEY_PREFIX = 'openmanager.credential.'

export function credentialStoreKey(environmentId: string): string {
  let encoded = ''
  for (let index = 0; index < environmentId.length; index += 1) {
    const char = environmentId[index]!
    encoded += /[A-Za-z0-9.-]/.test(char)
      ? char
      : `_${environmentId.charCodeAt(index).toString(16).padStart(4, '0')}`
  }
  return CREDENTIAL_KEY_PREFIX + encoded
}
