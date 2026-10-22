import {
  encodePairingLink,
  isEnvironmentClientError,
  type AuthorizedClientList,
  type EnvironmentClient,
  type PairingLink,
} from '@openmanager/environment-client'
import { ClientLabelSchema, type AccessCapability } from '@openmanager/protocol'

/**
 * Who can reach the connected environment, and its pairing links, as the
 * environment reports them, with the commands that change them.
 *
 * The rule this follows: the list on screen is only ever what the
 * environment last said. A command is sent; once it is answered the list is
 * read again (and the environment's own `client.list.changed` push usually
 * lands first). Nothing is edited here in advance of, or instead of, that
 * answer.
 *
 * Reading the list needs `admin`. A phone without it is refused with
 * `capability_missing`, which reads as `access: 'denied'`, and nothing else
 * is asked. Every (re)connect lists afresh, since listing is also what asks
 * the environment for the pushes, and a reconnect has to ask again.
 *
 * Outside React, so it can be driven by the shared mock in tests and by a
 * live script; `useDeviceAdmin` binds it to a screen. Creating one does
 * nothing; `start()` listens and reads.
 */

export type DeviceAdminAccess = 'unknown' | 'admin' | 'denied' | 'unsupported'

export type DeviceAdminAction =
  | { kind: 'rename'; clientId: string }
  | { kind: 'revoke'; clientId: string }
  | { kind: 'revoke_others' }
  | { kind: 'rotate' }
  | { kind: 'create_link' }
  | { kind: 'revoke_link'; linkId: string }

export type DeviceAdminState = {
  /** The list as the environment last reported it; null before it first answered. */
  list: AuthorizedClientList | null
  access: DeviceAdminAccess
  /** Why the list could not be read, when it was not a refusal for lack of `admin`. */
  loadError: string | null
  /** The pairing links as last reported; null before they were first read. */
  links: readonly PairingLink[] | null
  linksError: string | null
  /** The command in flight. One at a time, as on web. */
  busy: DeviceAdminAction | null
  /** What the last command's refusal said. */
  actionError: string | null
  /** Which command that was. */
  failed: DeviceAdminAction | null
  /**
   * The socket is up, so what the environment says can be asked again. While
   * it is not, a link past its time on this phone's clock cannot be confirmed
   * either way and stays as last reported.
   */
  connected: boolean
}

/** A link this phone made, and the address that opens it. Memory only. */
export type ShownPairingLink = { link: PairingLink; url: string }

export type CreateLinkInput = {
  capabilities: AccessCapability[]
  /** Where the new device reaches the environment. */
  route: string
  /** The web app the link opens (the environment's app origin). */
  appUrl: string
}

export interface DeviceAdmin {
  getState(): DeviceAdminState
  subscribe(listener: () => void): () => void
  /** Read the list again (and the links, once the list could be read). */
  load(): void
  refreshLinks(): void
  rename(clientId: string, label: string): Promise<boolean>
  revoke(clientId: string): Promise<boolean>
  revokeOthers(): Promise<boolean>
  /** The new owner credential, for the caller to keep at once; null when refused. Never stored here. */
  rotate(): Promise<string | null>
  createLink(input: CreateLinkInput): Promise<ShownPairingLink | null>
  revokeLink(linkId: string): Promise<boolean>
  /** The address of a link this phone made this run and still holds. */
  madeLink(linkId: string): string | undefined
  clearActionError(): void
  /**
   * Listen to the environment and read the list now (when connected) and on
   * every reconnect. Returns the stop; starting again after a stop is fine.
   */
  start(): () => void
  dispose(): void
}

/**
 * Links this phone made, by environment: the environment keeps only a hash
 * of the token, so the link can be shown again only from here. Kept in
 * memory for the app's run and never written anywhere; one that stopped
 * waiting is dropped as soon as the environment says so.
 */
const madeLinks = new Map<string, Map<string, string>>()

/** Forget every link this phone made: for tests. */
export function forgetMadeLinks() {
  madeLinks.clear()
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const INITIAL: DeviceAdminState = {
  list: null,
  access: 'unknown',
  loadError: null,
  links: null,
  linksError: null,
  busy: null,
  actionError: null,
  failed: null,
  connected: false,
}

/** Timers and clock, replaced in tests. */
export type DeviceAdminClock = {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const REAL_CLOCK: DeviceAdminClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Past a link's expiry on this phone's clock: how soon it is asked about, how often again, and at most how many times. */
export const EXPIRY_CHECK_DELAY_MS = 500
export const EXPIRY_RECHECK_MS = 5000
export const EXPIRY_RECHECKS = 6

export function createDeviceAdmin(
  client: EnvironmentClient,
  environmentId: string,
  clock: DeviceAdminClock = REAL_CLOCK,
): DeviceAdmin {
  let state: DeviceAdminState = INITIAL
  let disposed = false
  const listeners = new Set<() => void>()
  const set = (patch: Partial<DeviceAdminState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  // Only the newest read may land: an older answer must not replace a newer push.
  let listGeneration = 0
  let linkGeneration = 0
  const made = () => {
    let entry = madeLinks.get(environmentId)
    if (!entry) {
      entry = new Map()
      madeLinks.set(environmentId, entry)
    }
    return entry
  }

  const supported = () =>
    client.supports('listAuthorizedClients') ||
    // Before the handshake nothing is known; the first read decides.
    client.getState().connection.capabilities.length === 0

  /*
   * Expiry is the environment's to say, and nothing pushes it: the phone's
   * countdown is only words. When a waiting link reaches its time on this
   * phone's clock the links are read again, and what the environment answers
   * is what shows. A link it still lists as waiting (the clocks disagree) is
   * asked about a few more times, then left as it is.
   */
  let expiryTimer: unknown = null
  const rechecks = new Map<string, number>()
  const scheduleExpiryCheck = () => {
    if (expiryTimer !== null) clock.clearTimeout(expiryTimer)
    expiryTimer = null
    if (disposed || !state.connected) return
    const now = clock.now()
    let delay = Infinity
    for (const link of state.links ?? []) {
      if (link.status !== 'waiting') continue
      const at = Date.parse(link.expiresAt)
      if (at > now) delay = Math.min(delay, at - now + EXPIRY_CHECK_DELAY_MS)
      else if ((rechecks.get(link.linkId) ?? 0) < EXPIRY_RECHECKS) {
        delay = Math.min(delay, EXPIRY_RECHECK_MS)
      }
    }
    if (delay === Infinity) return
    expiryTimer = clock.setTimeout(() => {
      expiryTimer = null
      const at = clock.now()
      for (const link of state.links ?? []) {
        if (link.status === 'waiting' && Date.parse(link.expiresAt) <= at) {
          rechecks.set(link.linkId, (rechecks.get(link.linkId) ?? 0) + 1)
        }
      }
      refreshLinks()
    }, delay)
  }

  const refreshLinks = () => {
    if (disposed || state.access !== 'admin' || !client.supports('listPairingLinks')) return
    const current = ++linkGeneration
    client.commands.listPairingLinks().then(
      (links) => {
        if (current !== linkGeneration) return
        // A link that stopped waiting cannot be shown again.
        for (const link of links) if (link.status !== 'waiting') made().delete(link.linkId)
        set({ links, linksError: null })
        scheduleExpiryCheck()
      },
      (error: unknown) => {
        if (current === linkGeneration) set({ linksError: message(error) })
      },
    )
  }

  const load = () => {
    if (disposed) return
    if (!supported()) {
      set({ access: 'unsupported' })
      return
    }
    const current = ++listGeneration
    set({ loadError: null })
    client.commands.listAuthorizedClients().then(
      (list) => {
        if (current !== listGeneration) return
        set({ list, access: 'admin', loadError: null })
        refreshLinks()
      },
      (error: unknown) => {
        if (current !== listGeneration) return
        if (isEnvironmentClientError(error) && error.code === 'capability_missing') {
          set({ access: 'denied', list: null, links: null, loadError: null })
        } else {
          set({ loadError: message(error) })
        }
      },
    )
  }

  let stopPush: (() => void) | undefined
  let stopState: (() => void) | undefined
  let connected = false
  const stop = () => {
    stopPush?.()
    stopState?.()
    stopPush = undefined
    stopState = undefined
    if (expiryTimer !== null) clock.clearTimeout(expiryTimer)
    expiryTimer = null
    // Answers to reads asked before this stop are not for the next start.
    listGeneration += 1
    linkGeneration += 1
  }

  const run = async <T>(action: DeviceAdminAction, work: () => Promise<T>): Promise<T | null> => {
    if (state.busy) return null
    set({ busy: action, actionError: null, failed: null })
    try {
      const result = await work()
      set({ busy: null })
      return result
    } catch (error) {
      set({ busy: null, actionError: message(error), failed: action })
      return null
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    refreshLinks,
    async rename(clientId, label) {
      const parsed = ClientLabelSchema.safeParse(label)
      if (!parsed.success) {
        set({
          actionError: parsed.error.issues[0]?.message ?? 'That name cannot be used.',
          failed: { kind: 'rename', clientId },
        })
        return false
      }
      const done = await run({ kind: 'rename', clientId }, async () => {
        await client.commands.renameAuthorizedClient(clientId, parsed.data)
        return true
      })
      if (done) load()
      return done === true
    },
    async revoke(clientId) {
      const done = await run({ kind: 'revoke', clientId }, async () => {
        await client.commands.revokeAuthorizedClient(clientId)
        return true
      })
      if (done) load()
      return done === true
    },
    async revokeOthers() {
      const done = await run({ kind: 'revoke_others' }, async () => {
        await client.commands.revokeOtherAuthorizedClients()
        return true
      })
      if (done) load()
      return done === true
    },
    async rotate() {
      // The socket closes once the new credential is sent; the caller saves
      // it and the connection redials with it, which lists afresh.
      const rotated = await run({ kind: 'rotate' }, () => client.commands.rotateOwnerCredential())
      return rotated?.credential ?? null
    },
    async createLink(input) {
      const shown = await run({ kind: 'create_link' }, async () => {
        const answer = await client.commands.createPairingLink({
          capabilities: input.capabilities,
        })
        const url = encodePairingLink(input.appUrl, {
          route: input.route,
          environmentId,
          token: answer.token,
        })
        made().set(answer.link.linkId, url)
        return { link: answer.link, url } satisfies ShownPairingLink
      })
      if (shown) refreshLinks()
      return shown
    },
    async revokeLink(linkId) {
      const done = await run({ kind: 'revoke_link', linkId }, async () => {
        await client.commands.revokePairingLink(linkId)
        return true
      })
      if (done) made().delete(linkId)
      // Whatever the answer, the list says where the link stands now.
      refreshLinks()
      return done === true
    },
    madeLink: (linkId) => made().get(linkId),
    clearActionError: () => set({ actionError: null, failed: null }),
    start() {
      if (disposed) return () => undefined
      stop()
      // The environment's own word on the list, whenever it changes.
      stopPush = client.onAuthorizedClientsChanged?.((list) => {
        listGeneration += 1
        set({ list, access: 'admin', loadError: null })
        // A device pairing (a link used) or one revoked (its links void) moves the links too.
        refreshLinks()
      })
      // Every (re)connect lists afresh.
      connected = client.getState().connection.phase === 'connected'
      set({ connected })
      stopState = client.subscribe(() => {
        const now = client.getState().connection.phase === 'connected'
        if (now !== connected) set({ connected: now })
        // Offline, nothing can be confirmed: the checks wait for the reconnect's read.
        if (!now) scheduleExpiryCheck()
        if (now && !connected) load()
        connected = now
      })
      if (connected) load()
      return stop
    },
    dispose() {
      stop()
      disposed = true
      listeners.clear()
    },
  }
}
