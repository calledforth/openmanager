/** Which conversation the composer is currently editing for.
 *
 * The composer has always had two modes — a live session, or a project's
 * unsent draft — decided ad hoc at each of a dozen call sites. Quick launch
 * adds a third input (a project chosen while a session is on screen) without
 * adding a third mode: it resolves to the same "draft for a project" the
 * new-session page produces, which is why aiming at a project through either
 * route lands on the same remembered model and the same half-typed text.
 */
export interface ComposerTarget {
  /** The session the composer writes to, or null when it is composing a draft. */
  sessionId: string | null
  /** The project whose draft state and preferences apply. */
  workspacePath: string | null
  /** Whether the composer is editing an unsent draft rather than a session. */
  draftOpen: boolean
  /** Storage key for the typed text. */
  draftKey: string
  /** True while aimed at a project other than the one on screen. */
  quickLaunch: boolean
}

export function resolveComposerTarget({
  activeSessionId,
  activeWorkspacePath,
  isSessionDraftOpen,
  quickLaunchWorkspacePath,
}: {
  activeSessionId: string | null
  activeWorkspacePath: string | null
  isSessionDraftOpen: boolean
  quickLaunchWorkspacePath: string | null
}): ComposerTarget {
  const quickLaunch = quickLaunchWorkspacePath !== null
  const workspacePath = quickLaunchWorkspacePath ?? activeWorkspacePath
  // Quick launch detaches the composer from the session on screen entirely.
  // Leaving the session id set here is what would make a settings change or a
  // send land on the conversation the user is only *reading*.
  const sessionId = quickLaunch ? null : activeSessionId
  const draftOpen = quickLaunch || isSessionDraftOpen
  return {
    sessionId,
    workspacePath,
    draftOpen,
    quickLaunch,
    draftKey: sessionId
      ? `session:${sessionId}`
      : workspacePath
        ? `draft:${workspacePath}`
        : 'no-workspace',
  }
}
