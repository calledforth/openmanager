import { createContext, useContext } from 'react'
import type { ProviderId } from '@agentpack/contract'

/** Where the composer sits in a turn: waiting for a draft's session to be
 * created, or watching a prompt run. `null` between turns. */
export type LocalSessionStatus = 'starting' | 'running'

/** Published when a new-session draft is opened so the composer can seed its
 * model/mode selection for that workspace. `revision` increments per request
 * so reopening the same workspace re-seeds. */
export interface DraftRequest {
  workspacePath: string
  /** The session that was on screen when the draft opened, if any, so the
   * draft can inherit its provider and selection. */
  previousSessionId: string | null
  revision: number
}

/**
 * Session navigation and turn lifecycle: which workspace and session are
 * active, whether a draft is open, and the local view of the turn in flight.
 * Composer selection and message data live in their own providers.
 */
export interface SessionStateValue {
  activeWorkspacePath: string | null
  activeSessionId: string | null
  /** A new-session draft is on screen instead of a persisted session. */
  isSessionDraftOpen: boolean
  /** The draft's first prompt was submitted and its session is being created. */
  pendingDraftSessionStart: boolean
  localSessionStatus: LocalSessionStatus | null
  /** The session created from this client's draft; stays set until the user
   * navigates so optimistic messages survive the handoff. */
  adoptedDraftSessionId: string | null
  /** Provider used for new drafts; follows the last provider the user picked. */
  defaultProviderId: ProviderId
  /** The most recent draft request, for providers that seed draft state. */
  draftRequest: DraftRequest | null
  /** Last failure from a session operation. */
  error: string | null
  /** Provider a known session runs on, or `fallback`/the default provider. */
  providerIdForSession: (sessionExternalId: string, fallback?: ProviderId) => ProviderId
  /** Remember `providerId` as the provider for new drafts. */
  setDefaultProviderId: (providerId: ProviderId) => void
  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  selectSession: (workspacePath: string, externalId: string, providerId?: ProviderId) => void
  openChildSession: (childExternalId: string, parentExternalId: string) => Promise<void>
  closeChildSession: (parentExternalId: string) => void
  /** Open a new-session draft for `workspacePath`. */
  createSession: (workspacePath: string) => Promise<void>
  deleteSession: (
    workspacePath: string,
    externalId: string,
    providerId?: ProviderId,
  ) => Promise<void>
  /** Turn lifecycle, driven by the provider that submits prompts. */
  beginDraftTurn: () => void
  beginSessionTurn: () => void
  /** Track the job running the current turn so its terminal status can
   * unlock the composer. */
  attachTurnJob: (jobId: string) => void
  /** The turn did not start (submission failed or the provider was down). */
  failTurn: (message?: string) => void
}

export const SessionStateContext = createContext<SessionStateValue | null>(null)

export function useSessionState(): SessionStateValue {
  const ctx = useContext(SessionStateContext)
  if (!ctx) throw new Error('useSessionState must be used within SessionStateProvider')
  return ctx
}
