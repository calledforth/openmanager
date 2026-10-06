/**
 * Whether this browser has refused to let the page reach this device's own
 * loopback address. A page on a public origin (the hosted client) needs the
 * person's permission before Chrome 142+, Edge 143+ or Firefox will let it
 * fetch `http://127.0.0.1`; a refusal arrives as the same network error as
 * nothing listening, so the permission is the only way to tell them apart.
 * See docs/web-deploy.md for what each browser does.
 *
 * Current Chrome, Edge (154 tested) and Firefox (155 tested) name the
 * permission `loopback-network`; the first Chrome versions with the check
 * called it `local-network-access`. A browser that knows
 * neither name (Safari, older Chrome) answers false: it either allows the
 * request or blocks it some other way that it does not report.
 */
const LOOPBACK_PERMISSION_NAMES = ['loopback-network', 'local-network-access'] as const

type PermissionsLike = {
  query: (descriptor: { name: string }) => Promise<{ state: string }>
}

export async function loopbackAccessDenied(
  permissions: PermissionsLike | undefined = globalThis.navigator?.permissions as
    PermissionsLike | undefined,
): Promise<boolean> {
  if (!permissions) return false
  for (const name of LOOPBACK_PERMISSION_NAMES) {
    try {
      const status = await permissions.query({ name })
      return status.state === 'denied'
    } catch {
      // Not a permission this browser knows; try the older name.
    }
  }
  return false
}
