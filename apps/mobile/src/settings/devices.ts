import type {
  AuthorizedClient,
  AuthorizedClientList,
  PairingLink,
} from '@openmanager/environment-client'
import {
  isLoopbackEnvironmentEndpoint,
  type EnvironmentRoute,
} from '@openmanager/environment-client/connection'
import { formatRelativeTime } from '@openmanager/app-core/lib/relative-time'
import { ACCESS_CAPABILITIES, type AccessCapability } from '@openmanager/protocol'

/**
 * The words and the gating of the environment's device list, pairing links
 * and the confirmations in front of them, as web's Devices settings has them
 * (`apps/web/src/components/devices-settings.tsx`, `pair-device-dialog.tsx`).
 * Pure: everything here reads what the environment last reported and never
 * edits it. The phone sends the commands; the list comes back from the
 * environment.
 */

const CAPABILITY_LABELS: Record<AccessCapability, string> = {
  read: 'View',
  operate: 'Edit',
  agent: 'Run agents',
  terminal: 'Terminals',
  admin: 'Manage access',
}

/** What a device may do, in words: "Full access", or the capabilities it holds. */
export function accessWords(capabilities: readonly AccessCapability[]): string {
  if (ACCESS_CAPABILITIES.every((capability) => capabilities.includes(capability))) {
    return 'Full access'
  }
  return ACCESS_CAPABILITIES.filter((capability) => capabilities.includes(capability))
    .map((capability) => CAPABILITY_LABELS[capability])
    .join(', ')
}

/** "Online now", "Last seen 3h ago", "Last seen just now", or "Never connected". */
export function presenceWords(client: AuthorizedClient, now: number): string {
  if (client.connected) return 'Online now'
  if (!client.lastSeenAt) return 'Never connected'
  const age = formatRelativeTime(client.lastSeenAt, now)
  if (age === 'now') return 'Last seen just now'
  return /^\d/.test(age) ? `Last seen ${age} ago` : `Last seen ${age}`
}

/** One device as the phone lists it, and what may be done to it from here. */
export type DeviceRowView = {
  clientId: string
  label: string
  kind: AuthorizedClient['kind']
  /** This phone. */
  isCurrent: boolean
  connected: boolean
  /** "Online now · Full access", "Last seen 2h ago · View, Edit". */
  sub: string
  /** Only the owner names the owner. */
  canRename: boolean
  /** Neither the owner nor this phone: the owner is rotated instead, and a device is revoked from another one. */
  canRevoke: boolean
  /** The owner's row, when this phone is the owner and can keep a new credential. */
  canRotate: boolean
}

/**
 * The list in the environment's order (owner first, then most recently
 * seen), with this phone marked and each row's actions decided the way the
 * environment decides them, so nothing is offered that it would refuse.
 */
export function deviceRows(
  list: AuthorizedClientList,
  now: number,
  options: { canKeepCredential: boolean },
): DeviceRowView[] {
  const current = list.clients.find((item) => item.clientId === list.currentClientId)
  const ownerHere = current?.kind === 'owner'
  return list.clients.map((item) => {
    const isCurrent = item.clientId === list.currentClientId
    return {
      clientId: item.clientId,
      label: item.label,
      kind: item.kind,
      isCurrent,
      connected: item.connected,
      sub: `${presenceWords(item, now)} · ${accessWords(item.capabilities)}`,
      canRename: item.kind !== 'owner' || ownerHere,
      canRevoke: !isCurrent && item.kind !== 'owner',
      canRotate: item.kind === 'owner' && ownerHere && options.canKeepCredential,
    }
  })
}

/** This phone's own row, when the list includes it. */
export function currentDevice(list: AuthorizedClientList): AuthorizedClient | undefined {
  return list.clients.find((item) => item.clientId === list.currentClientId)
}

/**
 * How many devices "Revoke all other devices" reaches: everyone listed but
 * this phone and the owner, plus those the list leaves out. The owner always
 * leads the list, so only this phone can be among the omitted ones.
 */
export function revocableOthers(list: AuthorizedClientList): number {
  const others = list.clients.filter(
    (item) => item.clientId !== list.currentClientId && item.kind !== 'owner',
  )
  return others.length + list.omitted - (currentDevice(list) ? 0 : 1)
}

/** What the list leaves out, and whether revoking the others reaches it. */
export function omittedNote(omitted: number, includesThisDevice: boolean): string {
  const shown = `${omitted === 1 ? '1 more device' : `${omitted} more devices`}, the least recently seen, ${omitted === 1 ? 'is' : 'are'} not shown`
  if (!includesThisDevice) {
    return `${shown}. Revoking all other devices reaches ${omitted === 1 ? 'it' : 'them'} too.`
  }
  if (omitted === 1) return `${shown}: this one.`
  return `${shown}, this one among them. Revoking all other devices reaches the rest.`
}

/** What a device without `admin` is told instead of the list. */
export const NO_ADMIN_NOTE =
  "This phone can't manage access. Open this page on a device that can, such as the environment's own machine."

export type DeviceConfirm =
  | { kind: 'revoke'; clientId: string; label: string }
  | { kind: 'revoke_others'; count: number }
  | { kind: 'rotate' }

/** The question before each action that cannot be undone, in web's words. */
export function confirmCopy(confirm: DeviceConfirm): {
  title: string
  body: string
  action: string
} {
  switch (confirm.kind) {
    case 'revoke':
      return {
        title: `Revoke ${confirm.label}?`,
        body: `${confirm.label} loses access now, and any connection it has open is closed. To use it again, pair it with a new link.`,
        action: 'Revoke',
      }
    case 'revoke_others':
      return {
        title: 'Revoke all other devices?',
        body: `${confirm.count === 1 ? '1 device loses' : `${confirm.count} devices lose`} access now, and their open connections are closed. This phone and the owner keep theirs.`,
        action: 'Revoke all',
      }
    case 'rotate':
      return {
        title: 'Rotate the owner credential?',
        body: 'This phone switches to a new credential and reconnects. Anything else using the old one is disconnected; it can read the new one from the environment’s data directory.',
        action: 'Rotate',
      }
  }
}

// ---- pairing links ---------------------------------------------------------

/** "4:05" until a time, or null once it has passed. */
export function formatRemaining(until: string, now: number): string | null {
  const seconds = Math.ceil((Date.parse(until) - now) / 1000)
  if (!(seconds > 0)) return null
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const isWaiting = (link: PairingLink, now: number) =>
  link.status === 'waiting' && Date.parse(link.expiresAt) > now

/** One link still waiting for a device. */
export type PairingLinkRowView = {
  linkId: string
  title: string
  /** "Full access · expires in 4:12 · Made on Laptop". */
  sub: string
  /** This phone made it this run and still holds the link: it can be shown and copied again. */
  shownHere: boolean
}

/**
 * The links still waiting, newest first. Links this phone made (and still
 * holds in memory) can be shown again; one made elsewhere can only be
 * withdrawn, since its token never reached this phone.
 */
export function waitingLinkRows(
  links: readonly PairingLink[],
  now: number,
  context: {
    currentClientId: string
    deviceLabel: (clientId: string) => string | undefined
    madeHere: (linkId: string) => boolean
  },
): PairingLinkRowView[] {
  return links
    .filter((item) => isWaiting(item, now))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((item) => {
      const shownHere = context.madeHere(item.linkId)
      const origin =
        item.createdByClientId === context.currentClientId
          ? 'Made on this phone'
          : `Made on ${context.deviceLabel(item.createdByClientId) ?? 'another device'}`
      return {
        linkId: item.linkId,
        title: item.label ?? 'New device',
        sub: [
          accessWords(item.capabilities),
          `expires in ${formatRemaining(item.expiresAt, now) ?? '0:00'}`,
          ...(shownHere ? [] : [origin]),
        ].join(' · '),
        shownHere,
      }
    })
}

/** What a link this phone shows says once it is no longer waiting. */
export function linkOutcome(
  status: PairingLink['status'],
  usedBy: string | undefined,
): { title: string; body: string } {
  switch (status) {
    case 'used':
      return {
        title: 'Device paired',
        body: `${usedBy ?? 'A device'} can now reach this environment. It is in the device list, where you can rename or revoke it.`,
      }
    case 'expired':
      return {
        title: 'The link expired',
        body: 'Nobody used it within five minutes. Make another when the device is ready.',
      }
    case 'revoked':
      return { title: 'Link withdrawn', body: 'Nobody can use it now.' }
    case 'void':
      return {
        title: 'The link no longer works',
        body: 'The device that made it lost access, so the link stopped working.',
      }
    case 'waiting':
      return { title: 'Scan or open on the new device', body: '' }
  }
}

/** The grants a new link can offer, as web's two presets. Manage access is always its own choice. */
export const PAIRING_PRESETS = [
  { id: 'view', label: 'View only', grant: ['read'] },
  { id: 'full', label: 'Full access', grant: ['read', 'operate', 'agent', 'terminal'] },
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  grant: readonly AccessCapability[]
}>

export type PairingPresetId = (typeof PAIRING_PRESETS)[number]['id']

/**
 * What a new link offers: the preset's grant plus Manage access when asked,
 * cut to what this phone holds (a link can offer no more), `read` first.
 */
export function pairingGrant(
  preset: PairingPresetId,
  manageAccess: boolean,
  held: readonly AccessCapability[],
): AccessCapability[] {
  const base: readonly AccessCapability[] = PAIRING_PRESETS.find((item) => item.id === preset)
    ?.grant ?? ['read']
  const wanted = new Set<AccessCapability>([...base, ...(manageAccess ? ['admin' as const] : [])])
  return ACCESS_CAPABILITIES.filter(
    (capability) => wanted.has(capability) && held.includes(capability),
  )
}

/** The presets this phone can offer whole. */
export function offeredPresets(held: readonly AccessCapability[]) {
  return PAIRING_PRESETS.filter((preset) => preset.grant.every((item) => held.includes(item)))
}

/** The cautions web shows under the access choice. */
export function grantWarnings(grant: readonly AccessCapability[]): string[] {
  const warnings: string[] = []
  if (grant.includes('agent') || grant.includes('terminal')) {
    warnings.push('Runs code on that machine: agents and terminals run as you do there.')
  }
  if (grant.includes('admin')) {
    warnings.push('Manages access: the device can pair new devices and revoke any but the owner.')
  }
  return warnings
}

/**
 * The route a link should carry: the one in use when another device could
 * reach it too, else the first saved route that is not the computer's own
 * loopback address, else the one in use (web's `defaultPairingRoute`).
 */
export function defaultPairingRoute(
  routes: readonly EnvironmentRoute[],
  inUse: string | null,
): string | null {
  if (inUse && !isLoopbackEnvironmentEndpoint(inUse)) return inUse
  return (
    routes.find((route) => !isLoopbackEnvironmentEndpoint(route.endpoint))?.endpoint ??
    inUse ??
    routes[0]?.endpoint ??
    null
  )
}
