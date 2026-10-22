import { useEffect, useSyncExternalStore } from 'react'

import {
  pairingSession,
  type PairingPhase,
  type PairingSessionHost,
  type PairingSnapshot,
  type PairingSource,
} from './session'
import type { PairingIntent } from './flow'

export type { PairingPhase, PairingSource }

export type Pairing = PairingSnapshot & {
  submit: (
    text: string,
    source: PairingSource,
    label: string | undefined,
    intent?: PairingIntent,
  ) => void
  accept: () => void
  decline: () => void
  retry: () => void
  reset: () => void
}

/**
 * The pairing screen's view of the app's one pairing (`session.ts`), which
 * outlives the screen: the screen remounts when a pairing connects, and must
 * find the same pairing where it left it.
 */
export function usePairing(host: PairingSessionHost): Pairing {
  useEffect(() => {
    pairingSession.attach(host)
  })
  const snapshot = useSyncExternalStore(pairingSession.subscribe, pairingSession.getSnapshot)
  return {
    ...snapshot,
    submit: (text, source, label, intent) => {
      pairingSession.attach(host)
      pairingSession.submit(text, source, label, intent)
    },
    accept: pairingSession.accept,
    decline: pairingSession.decline,
    retry: pairingSession.retry,
    reset: pairingSession.reset,
  }
}
