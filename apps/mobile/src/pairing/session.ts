import type { PairingFailure } from './failures'
import {
  checkNewRoute,
  exchangeLink,
  joinRoute,
  mayRedeem,
  planPairing,
  redeemLink,
  type PairingController,
  type PairingIntent,
  type PairingResult,
  type PairingSuccess,
} from './flow'
import { readPairingLink, type PairingLinkRead } from './link'

/**
 * Where one pairing stands.
 *
 * - `idle`: waiting for a code to be scanned or a link pasted.
 * - `connecting`: the link was read and is being used (`step` says how).
 * - `consent`: the phone already knows the environment and the link's
 *   address is new to it; nothing joins until the person agrees.
 * - `paired`: done. The sheet reads the controller for the route it landed on.
 * - `declined`: the person kept the new address out. Nothing changed and the
 *   link was not used.
 * - `failed`: with the reason, in words, and the next step.
 */
export type PairingPhase =
  | { kind: 'idle' }
  | {
      kind: 'connecting'
      step: 'exchanging' | 'checking' | 'redeeming'
      /** The saved environment's label, when the phone already knows it. */
      label?: string
    }
  | {
      kind: 'consent'
      label: string
      route: string
      /** What agreeing leads to, and whether it sends the saved token there. */
      then: 'exchange' | 'redeem'
      sendsSavedCredential: boolean
    }
  | { kind: 'paired'; paired: PairingSuccess }
  | { kind: 'declined'; label: string }
  | { kind: 'failed'; failure: PairingFailure }

export type PairingSource = 'scan' | 'paste'

export type PairingSnapshot = {
  phase: PairingPhase
  /** How the current link came in, while there is one. */
  source: PairingSource | null
  /** The route the current link names, for the sheet to show; never the token. */
  route: string | null
}

export type PairingSessionHost = {
  controller: PairingController
  fetch: typeof fetch
  /** Told when a pairing ends, for a haptic. */
  onPaired?: () => void
  onFailed?: () => void
}

const IDLE: PairingSnapshot = { phase: { kind: 'idle' }, source: null, route: null }

/**
 * One pairing at a time, outside React. The phone's environment provider
 * mounts app-core's providers around the whole app once a client is
 * accepted, which remounts every screen: the moment a pairing connects, the
 * pairing screen starts over. So the state lives here, and the screen only
 * reads it (`usePairing`): a remounted screen shows the same sheet, and a
 * result that lands while no screen is mounted is still shown when one is.
 *
 * The read link, token included, is held here for the length of one pairing
 * (a retry uses it again) and dropped on `reset`, on success, and on
 * declining; it is never rendered, logged or saved. A pairing in flight
 * still finishes when the screen closes, and an exchange that succeeds is
 * still saved: the token is used up by then, and the phone's new token is
 * the only copy of it.
 */
export function createPairingSession() {
  let snapshot: PairingSnapshot = IDLE
  let link: { read: PairingLinkRead; label: string | undefined; intent: PairingIntent } | null =
    null
  let busy = false
  let host: PairingSessionHost | null = null
  let screens = 0
  const listeners = new Set<() => void>()

  const set = (patch: Partial<PairingSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const land = (result: PairingResult) => {
    busy = false
    if (result.ok) {
      link = null
      set({ phase: { kind: 'paired', paired: result.paired } })
      host?.onPaired?.()
    } else {
      set({ phase: { kind: 'failed', failure: result.failure } })
      host?.onFailed?.()
    }
  }

  const run = () => {
    const current = link
    if (!current || !host) return
    const { controller, fetch: fetchImpl } = host
    busy = true
    const plan = planPairing(current.read, controller, current.intent)
    if (plan.kind === 'exchange') {
      set({ phase: { kind: 'connecting', step: 'exchanging' } })
      void exchangeLink(current.read, { label: current.label }, controller, fetchImpl).then(land)
      return
    }
    if (plan.kind === 'redeem') {
      set({ phase: { kind: 'connecting', step: 'redeeming', label: plan.label } })
      void redeemLink(current.read, controller).then(land)
      return
    }
    set({ phase: { kind: 'connecting', step: 'checking', label: plan.label } })
    void checkNewRoute(current.read, controller).then((checked) => {
      if (!checked.ok) {
        land({ ok: false, failure: checked.failure })
        return
      }
      busy = false
      set({
        phase: {
          kind: 'consent',
          label: plan.label,
          route: plan.route,
          then: plan.then,
          sendsSavedCredential: plan.sendsSavedCredential,
        },
      })
    })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** The controller and fetch a pairing uses; the mounted screen keeps this current. */
    attach(next: PairingSessionHost) {
      host = next
    },
    /** Whether a pairing is under way or has a result nobody has dismissed. */
    active: () => snapshot.phase.kind !== 'idle',
    /** A pairing screen is mounted; call the returned function when it goes. */
    mountScreen() {
      screens += 1
      return () => {
        screens -= 1
      }
    },
    /** Whether any pairing screen is mounted to show the pairing. */
    shown: () => screens > 0,
    /**
     * Read a scanned or pasted link and use it. Ignored unless idle. `intent`
     * says why the screen was opened (`repair`: the connection's Pair again).
     */
    submit(
      text: string,
      source: PairingSource,
      label: string | undefined,
      intent: PairingIntent = { kind: 'pair' },
    ) {
      if (busy || snapshot.phase.kind !== 'idle' || !host) return
      const read = readPairingLink(text)
      if (!read.ok) {
        link = null
        set({ source, route: null })
        land({ ok: false, failure: read.failure })
        return
      }
      link = { read: read.link, label, intent }
      set({ source, route: read.link.payload.route })
      run()
    },
    /**
     * The person agreed. With no token held the link is exchanged at its
     * address, which joins the record with the answer. With one, the address
     * joins, and the link is redeemed over the phone's own connection, on
     * whichever of its routes the controller reaches.
     */
    accept() {
      const current = link
      const phase = snapshot.phase
      if (!current || !host || phase.kind !== 'consent' || busy) return
      busy = true
      // Asked again now: the token may have been refused while the question
      // was open, and a refused token is never sent to redeem.
      const then =
        phase.then === 'redeem' &&
        !mayRedeem(host.controller, current.read.payload.environmentId, current.intent)
          ? 'exchange'
          : phase.then
      if (then === 'exchange') {
        set({ phase: { kind: 'connecting', step: 'exchanging', label: phase.label } })
        void exchangeLink(current.read, { label: current.label }, host.controller, host.fetch).then(
          land,
        )
        return
      }
      joinRoute(current.read, host.controller)
      set({ phase: { kind: 'connecting', step: 'redeeming', label: phase.label } })
      void redeemLink(current.read, host.controller).then(land)
    },
    /** Keep the new address out. */
    decline() {
      const phase = snapshot.phase
      if (phase.kind !== 'consent') return
      link = null
      set({ phase: { kind: 'declined', label: phase.label } })
    },
    /** Use the same link again (it was not used up). */
    retry() {
      if (busy) return
      if (!link) {
        set(IDLE)
        return
      }
      run()
    },
    /** Forget the link and go back to idle. */
    reset() {
      if (busy) return
      link = null
      set(IDLE)
    },
  }
}

export type PairingSession = ReturnType<typeof createPairingSession>

/** The app's one pairing. */
export const pairingSession = createPairingSession()
