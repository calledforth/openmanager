import { createContext, useContext } from 'react'
import type { ProviderId } from '@agentpack/contract'
import type { OptimisticImage } from '../lib/attachments'

/** A draft's first message while its session is being created. */
export interface LaunchingMessage {
  text: string
  images: OptimisticImage[]
}

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
  /** A new-session draft is on screen instead of a persisted session. Its
   * project can be gone (`activeWorkspacePath` is then null): the draft stays
   * open so another project can be picked for it. */
  isSessionDraftOpen: boolean
  /**
   * The id of the new-session draft on screen, where the environment keeps
   * drafts: the composer's draft key and, once it has text or an image, its
   * address (`/drafts/<id>`). Null when no draft is on screen. Hosts that
   * keep one draft per project leave it out.
   */
  newSessionDraftId?: string | null
  /** The open draft was written in a project that has since been removed;
   * it waits for another to be picked. */
  isDraftProjectRemoved?: boolean
  /** The address names a draft this client does not know yet: it waits for
   * the environment's listing before showing a blank page in its place. */
  isDraftLoading?: boolean
  /**
   * Move the open new-session draft to another project, keeping what was
   * typed, attached and picked. Hosts without draft pages leave it out and
   * open the project's own draft (`createSession`) instead.
   */
  setDraftWorkspace?: (workspacePath: string) => void
  /** The draft's first prompt was submitted and its session is being created. */
  pendingDraftSessionStart: boolean
  /** What that first prompt said, for the transcript to show until the new
   * session's own copy is on screen. Hosts that do not track it leave it out. */
  launchingMessage?: LaunchingMessage | null
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
  /** Open a blank new-session draft for `workspacePath`. */
  createSession: (workspacePath: string) => Promise<void>
  renameSession?: (workspacePath: string, externalId: string, title: string | null) => Promise<void>
  /** Name the session again with the environment's title model. Hosts
   * whose environment cannot generate titles leave it out. */
  regenerateSessionTitle?: (externalId: string) => Promise<void>
  deleteSession: (
    workspacePath: string,
    externalId: string,
    providerId?: ProviderId,
  ) => Promise<void>
  /** Turn lifecycle, driven by the provider that submits prompts. */
  /** A draft's first prompt was submitted. `message` is what it said, given
   * once by the composer before any image uploads. */
  beginDraftTurn: (message?: LaunchingMessage) => void
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
