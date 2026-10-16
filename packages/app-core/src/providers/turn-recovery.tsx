import { createContext, useContext } from 'react'

/**
 * What a failed turn's row can do about it. Served on its own, apart from the
 * thread state, so a failure row does not render again for every streamed
 * token: the value changes only when a turn starts or ends.
 *
 * Each action is absent when the host has no way to perform it; the row then
 * shows its guidance text and no button.
 */
export interface TurnRecoveryValue {
  /** Send the failed turn's prompt again, images included, as a new turn. */
  retry?: (turnId: string) => Promise<void>
  /** Ask the provider to compact the conversation (`/compact`). */
  compact?: () => Promise<void>
  /** The provider the session runs on, for guidance such as signing in. */
  providerName?: string
  /** A turn is running or being sent; actions wait for it. */
  busy: boolean
}

export const TurnRecoveryContext = createContext<TurnRecoveryValue | null>(null)

export function useTurnRecovery(): TurnRecoveryValue | null {
  return useContext(TurnRecoveryContext)
}
