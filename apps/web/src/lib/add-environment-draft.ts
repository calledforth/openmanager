import { useSyncExternalStore } from 'react'

/**
 * Settings' "Add environment" form, kept outside the page. Connecting to a
 * new address drops the current client first, and the shell remounts the
 * page when its client goes, so a form holding its own state would close and
 * lose what was typed just when the address turns out to be wrong.
 *
 * Memory only: the token typed here is never written to storage, and it is
 * forgotten as soon as the form closes.
 */
export type AddEnvironmentDraft = {
  open: boolean
  endpoint: string
  credential: string
  /**
   * The address sent, and whether the connection has since left `ready`. The
   * form closes once that connection is ready, so a typo or an unreachable
   * address can be fixed in place.
   */
  sent: { endpoint: string; leftReady: boolean } | null
}

const CLOSED: AddEnvironmentDraft = { open: false, endpoint: '', credential: '', sent: null }

let draft = CLOSED
const listeners = new Set<() => void>()

function set(next: AddEnvironmentDraft) {
  draft = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const read = () => draft

export function useAddEnvironmentDraft(): AddEnvironmentDraft {
  return useSyncExternalStore(subscribe, read, read)
}

export function openAddEnvironment() {
  if (!draft.open) set({ ...CLOSED, open: true })
}

export function closeAddEnvironment() {
  set(CLOSED)
}

export function editAddEnvironment(fields: { endpoint: string; credential: string }) {
  set({ ...draft, ...fields })
}

export function sendAddEnvironment(endpoint: string) {
  set({ ...draft, sent: { endpoint, leftReady: false } })
}

/** Follows the connection a sent address started; closes the form once it is ready. */
export function trackAddEnvironment(ready: boolean, inUseEndpoint: string | null) {
  const sent = draft.sent
  if (!sent) return
  if (!ready) {
    if (!sent.leftReady) set({ ...draft, sent: { ...sent, leftReady: true } })
    return
  }
  // A remount can skip the moment the connection left `ready`; the address
  // in use being the one sent says the same thing.
  if (sent.leftReady || inUseEndpoint === sent.endpoint) set(CLOSED)
}
