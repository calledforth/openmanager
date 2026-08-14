import { describe, expect, it } from 'vitest'
import { resolveComposerTarget } from './composerTarget'

const onSessionInAlpha = {
  activeSessionId: 'sess-1',
  activeWorkspacePath: '/repos/alpha',
  isSessionDraftOpen: false,
  quickLaunchWorkspacePath: null,
}

describe('resolveComposerTarget', () => {
  it('writes to the live session when nothing is retargeting it', () => {
    const target = resolveComposerTarget(onSessionInAlpha)

    expect(target).toMatchObject({
      sessionId: 'sess-1',
      workspacePath: '/repos/alpha',
      draftOpen: false,
      quickLaunch: false,
      draftKey: 'session:sess-1',
    })
  })

  it('detaches from the session on screen while quick launch is open', () => {
    const target = resolveComposerTarget({
      ...onSessionInAlpha,
      quickLaunchWorkspacePath: '/repos/beta',
    })

    // The null session id is the whole safety property: every settings write
    // and the send itself key off it, so a live session cannot be touched by a
    // composer the user has aimed somewhere else.
    expect(target.sessionId).toBeNull()
    expect(target.workspacePath).toBe('/repos/beta')
    expect(target.draftOpen).toBe(true)
    expect(target.quickLaunch).toBe(true)
  })

  it('shares one draft per project between quick launch and the new-session page', () => {
    const viaQuickLaunch = resolveComposerTarget({
      ...onSessionInAlpha,
      quickLaunchWorkspacePath: '/repos/beta',
    })
    const viaNewSessionPage = resolveComposerTarget({
      activeSessionId: null,
      activeWorkspacePath: '/repos/beta',
      isSessionDraftOpen: true,
      quickLaunchWorkspacePath: null,
    })

    expect(viaQuickLaunch.draftKey).toBe('draft:/repos/beta')
    expect(viaQuickLaunch.draftKey).toBe(viaNewSessionPage.draftKey)
  })

  it('keeps each project on its own draft', () => {
    const beta = resolveComposerTarget({
      ...onSessionInAlpha,
      quickLaunchWorkspacePath: '/repos/beta',
    })
    const gamma = resolveComposerTarget({
      ...onSessionInAlpha,
      quickLaunchWorkspacePath: '/repos/gamma',
    })

    expect(beta.draftKey).not.toBe(gamma.draftKey)
  })

  it('can aim at the project it is already in without adopting its session', () => {
    const target = resolveComposerTarget({
      ...onSessionInAlpha,
      quickLaunchWorkspacePath: '/repos/alpha',
    })

    expect(target.sessionId).toBeNull()
    expect(target.draftKey).toBe('draft:/repos/alpha')
  })

  it('falls back to a stable key when no workspace is selected at all', () => {
    const target = resolveComposerTarget({
      activeSessionId: null,
      activeWorkspacePath: null,
      isSessionDraftOpen: true,
      quickLaunchWorkspacePath: null,
    })

    expect(target.draftKey).toBe('no-workspace')
  })
})
