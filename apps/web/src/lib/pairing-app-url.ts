/**
 * Where this web app is served from: the address a pairing link opens. A
 * phone can only open it when it is not this computer's loopback address.
 */
export function pairingAppUrl(location: Pick<Location, 'origin'> = window.location): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href
}
