/**
 * Whether this browser has refused to let the page reach this device's own
 * loopback address. A page on a public origin (the hosted client) needs the
 * person's permission before Chrome 142+, Edge 143+ or Firefox will let it
 * fetch `http://127.0.0.1`; a refusal arrives as the same network error as
 * nothing listening, so the permission is the only way to tell them apart.
 * See docs/web-deploy.md for what each browser does.
 *
 * Current Chrome, Edge (154 tested) and Firefox (155 tested) call the
 * permission `loopback-network`. The first Chrome versions with the check
 * only knew the combined `local-network-access`, which is deliberately not
 * asked: querying it crashes the renderer in older Chrome, and `try` cannot
 * catch that. A browser that does not know `loopback-network` (those versions,
 * Safari, older browsers) answers false, and the failure reads as before.
 */
type PermissionsLike = {
  query: (descriptor: { name: string }) => Promise<{ state: string }>
}

export async function loopbackAccessDenied(
  permissions: PermissionsLike | undefined = globalThis.navigator?.permissions as
    PermissionsLike | undefined,
): Promise<boolean> {
  if (!permissions) return false
  try {
    const status = await permissions.query({ name: 'loopback-network' })
    return status.state === 'denied'
  } catch {
    // Not a permission this browser knows.
    return false
  }
}
