import { useEffect, useMemo, type ReactNode } from 'react'
import {
  selectDraftContent,
  selectDraftTarget,
  selectNewSessionDraftId,
  type DraftSync,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'
import type { DraftContent, DraftTarget } from '@openmanager/protocol'
import {
  ComposerDraftStoreContext,
  type ComposerDraftStore,
} from '../components/chat/composerDraftStore'
import {
  COMPOSER_DRAFTS_STORAGE_KEY,
  readComposerDrafts,
  writeComposerDrafts,
} from '../components/chat/composerDrafts'
import { useEnvironmentClient, useEnvironmentState } from './environment-client'

const SESSION_KEY = 'session:'
const NEW_SESSION_KEY = 'draft:'

const mintId = () => crypto.randomUUID()

/** A new-session draft set aside by a send, and the session it becomes. */
export interface SendingDraft {
  draftId: string
  sessionId: string
}

/** What a send in flight set aside: its draft, or none when it had none (images only). */
export interface SendingSlot {
  draft: SendingDraft | null
}

// Per sync, by project: what each composer's send in flight set aside.
const sendingDrafts = new WeakMap<DraftSync, Map<string, SendingSlot>>()

/** What a send in this project set aside, if one is in flight. */
export function sendingNewSessionDraft(
  sync: DraftSync,
  workspaceId: string,
): SendingSlot | undefined {
  return sendingDrafts.get(sync)?.get(workspaceId)
}

/** A new-session draft's place: the project it is for, and the session it will become. */
export const newSessionTarget = (workspaceId: string): DraftTarget => ({
  type: 'new_session',
  workspaceId,
  sessionId: mintId(),
})

/** The project's current new-session draft, or a fresh id and target for its first edit. */
export function newSessionDraftFor(
  state: EnvironmentState,
  workspaceId: string,
): { draftId: string; target: DraftTarget; content: DraftContent | undefined } {
  const draftId = selectNewSessionDraftId(state, workspaceId)
  const target = draftId ? selectDraftTarget(state, draftId) : undefined
  if (draftId && target) {
    return { draftId, target, content: selectDraftContent(state, draftId) }
  }
  return { draftId: mintId(), target: newSessionTarget(workspaceId), content: undefined }
}

/**
 * The composer's draft store over the environment: `session:<id>` is that
 * session's draft, `draft:<workspaceId>` the project's current new-session
 * draft. Other keys (no project picked yet) are held for this page only.
 */
export function createEnvironmentComposerDraftStore(
  client: EnvironmentClient,
  sync: DraftSync,
): ComposerDraftStore {
  let loose: Record<string, string> = {}
  const looseListeners = new Set<() => void>()

  const resolve = (state: EnvironmentState, key: string) => {
    if (key.startsWith(SESSION_KEY)) {
      const sessionId = key.slice(SESSION_KEY.length)
      const target: DraftTarget = { type: 'session', sessionId }
      return { draftId: sessionId, target, content: selectDraftContent(state, sessionId) }
    }
    if (key.startsWith(NEW_SESSION_KEY)) {
      return newSessionDraftFor(state, key.slice(NEW_SESSION_KEY.length))
    }
    return null
  }

  return {
    getText(key) {
      const state = client.getState()
      if (key.startsWith(SESSION_KEY)) {
        return selectDraftContent(state, key.slice(SESSION_KEY.length))?.text ?? ''
      }
      if (key.startsWith(NEW_SESSION_KEY)) {
        const draftId = selectNewSessionDraftId(state, key.slice(NEW_SESSION_KEY.length))
        return (draftId && selectDraftContent(state, draftId)?.text) || ''
      }
      return loose[key] ?? ''
    },
    setText(key, text) {
      const resolved = resolve(client.getState(), key)
      if (!resolved) {
        if ((loose[key] ?? '') === text) return
        loose = { ...loose, [key]: text }
        for (const listener of [...looseListeners]) listener()
        return
      }
      const { draftId, target, content } = resolved
      sync.edit(draftId, target, { ...content, text })
    },
    subscribe(listener) {
      looseListeners.add(listener)
      const unsubscribe = client.subscribe(listener)
      return () => {
        looseListeners.delete(listener)
        unsubscribe()
      }
    },
    flush: () => sync.flush(),
    beginSend(key) {
      if (!key.startsWith(NEW_SESSION_KEY)) return undefined
      const workspaceId = key.slice(NEW_SESSION_KEY.length)
      const state = client.getState()
      const draftId = selectNewSessionDraftId(state, workspaceId)
      const target = draftId ? selectDraftTarget(state, draftId) : undefined
      // Held from here, not from `session.create`: images upload first, and
      // what is typed meanwhile must go to the next draft, not this one. A
      // send with no draft holds that too, so it never takes one that turns
      // up (from another device) while its images upload.
      const slot: SendingSlot = {
        draft:
          draftId && target?.type === 'new_session'
            ? { draftId, sessionId: target.sessionId }
            : null,
      }
      let byProject = sendingDrafts.get(sync)
      if (!byProject) sendingDrafts.set(sync, (byProject = new Map()))
      byProject.set(workspaceId, slot)
      if (slot.draft) sync.beginLaunch(slot.draft.draftId)
      return () => {
        if (byProject.get(workspaceId) === slot) byProject.delete(workspaceId)
        // A launch that ran has already settled the draft; this only puts
        // back one whose send stopped before it (a failed upload).
        if (slot.draft) sync.endLaunch(slot.draft.draftId, 'aborted')
      }
    },
  }
}

/**
 * Brings this browser's old localStorage drafts into the environment once
 * their session or project is known here, then forgets them. A key for a
 * session this client has not listed yet waits for the listing; one for
 * another environment is left alone.
 */
function importLocalDrafts(state: EnvironmentState, sync: DraftSync) {
  const stored = readComposerDrafts()
  const keys = Object.keys(stored)
  if (keys.length === 0) return
  const left = { ...stored }
  for (const key of keys) {
    const text = stored[key]!.text
    if (key.startsWith(SESSION_KEY)) {
      const sessionId = key.slice(SESSION_KEY.length)
      if (!state.sessions[sessionId]) continue
      if (!selectDraftContent(state, sessionId)?.text) {
        sync.edit(sessionId, { type: 'session', sessionId }, { text })
      }
      delete left[key]
    } else if (key.startsWith(NEW_SESSION_KEY)) {
      const workspaceId = key.slice(NEW_SESSION_KEY.length)
      if (!state.workspaces[workspaceId]) continue
      if (!selectNewSessionDraftId(state, workspaceId)) {
        sync.edit(mintId(), newSessionTarget(workspaceId), { text })
      }
      delete left[key]
    }
  }
  if (Object.keys(left).length === keys.length) return
  if (Object.keys(left).length === 0 && typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(COMPOSER_DRAFTS_STORAGE_KEY)
    } catch {
      // Private mode or a full quota: the next import finds them gone or kept.
    }
    return
  }
  writeComposerDrafts(left)
}

/**
 * Gives the composer the environment's drafts when the client keeps them;
 * otherwise the composer falls back to this browser's storage.
 */
export function EnvironmentComposerDraftProvider({ children }: { children: ReactNode }) {
  const client = useEnvironmentClient()
  const sync = client.drafts
  const store = useMemo(
    () => (sync ? createEnvironmentComposerDraftStore(client, sync) : null),
    [client, sync],
  )
  const listed = useEnvironmentState((state) => state.draftsListed)
  const sessionCount = useEnvironmentState((state) => state.sessionOrder.length)
  const workspaceCount = useEnvironmentState((state) => state.workspaceOrder.length)
  useEffect(() => {
    // After the listing, so an import never overwrites a draft made elsewhere.
    if (!sync || !listed) return
    importLocalDrafts(client.getState(), sync)
  }, [client, listed, sessionCount, sync, workspaceCount])
  return (
    <ComposerDraftStoreContext.Provider value={store}>
      {children}
    </ComposerDraftStoreContext.Provider>
  )
}
