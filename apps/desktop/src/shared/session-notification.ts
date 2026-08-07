import type { ProviderId } from '@agentpack/contract'

/** Which session a desktop notification was raised for.
 *
 * Shared by main (which builds it off the agent event), preload (which relays
 * it) and the renderer (which navigates to the session on click), so the three
 * cannot drift on the shape of a notification's target. */
export type SessionNotificationTarget = {
  providerId: ProviderId
  sessionId: string
  /** Absolute workspace path. Absent for events raised before a session has
   * been attached to a workspace — the renderer cannot navigate to those. */
  workspacePath?: string
}
