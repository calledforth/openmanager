import { useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  selectDraftContent,
  selectDraftSyncStatus,
  selectDraftTarget,
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
import {
  DraftPageContext,
  DraftPicksContext,
  type DraftPageInternals,
  type DraftPageTarget,
} from './draft-pages'
import { useEnvironmentClient, useEnvironmentState } from './environment-client'

const SESSION_KEY = 'session:'
const NEW_SESSION_KEY = 'new:'
/** What this browser kept a project's landing text under before drafts had ids. */
const LEGACY_PROJECT_KEY = 'draft:'

const mintId = () => crypto.randomUUID()

const NO_IMAGES: readonly string[] = []

/** The draft with these images; a draft without any has no `artifactIds` at all. */
function withImages(content: DraftContent | undefined, artifactIds: readonly string[]) {
  const rest: DraftContent = { ...(content ?? { text: '' }) }
  delete rest.artifactIds
  return artifactIds.length > 0 ? { ...rest, artifactIds: [...artifactIds] } : rest
}

/** The composer's key for a new-session draft. */
export const newSessionDraftKey = (draftId: string) => `${NEW_SESSION_KEY}${draftId}`

/** A new-session draft set aside by a send: the session it becomes, and where. */
export interface SendingDraft {
  draftId: string
  sessionId: string
  /** The project it is sent from; null when it has none to start in. */
  workspaceId: string | null
}

// Per sync, by draft id, in the order the sends began.
const sendingDrafts = new WeakMap<DraftSync, Map<string, SendingDraft>>()

/** The draft a send in flight set aside, by its id. */
export function sendingNewSessionDraft(sync: DraftSync, draftId: string): SendingDraft | undefined {
  return sendingDrafts.get(sync)?.get(draftId)
}

/**
 * The draft the latest send in flight set aside. There is one composer, so
 * that is the send being launched, even if the page changed while its images
 * uploaded.
 */
export function latestSendingDraft(sync: DraftSync): SendingDraft | undefined {
  const sending = sendingDrafts.get(sync)
  return sending ? [...sending.values()].at(-1) : undefined
}

/** A new-session draft's place: the project it is for, and the session it will become. */
export const newSessionTarget = (workspaceId: string): DraftTarget => ({
  type: 'new_session',
  workspaceId,
  sessionId: mintId(),
})

/**
 * What the composer's draft store needs from the page: where a draft goes
 * before the environment has it, the picks made on it so far, and the moment
 * it is first written in.
 */
export interface ComposerDraftPages {
  target(draftId: string): DraftPageTarget | undefined
  picks(draftId: string): Pick<DraftContent, 'providerId' | 'preference'> | undefined
  claim(draftId: string): void
}

/**
 * The composer's draft store over the environment: `session:<id>` is that
 * session's draft, `new:<id>` a new-session draft. A new-session draft is
 * saved from its first text: until then it is only the page's, and so are
 * the picks made on it. Other keys are held for this page only.
 */
export function createEnvironmentComposerDraftStore(
  client: EnvironmentClient,
  sync: DraftSync,
  pages?: ComposerDraftPages,
): ComposerDraftStore {
  let loose: Record<string, string> = {}
  const looseListeners = new Set<() => void>()
  // What is typed while a draft is being sent goes to a draft of its own,
  // in the same project, so the send takes only what it was sent with.
  const successors = new Map<string, { draftId: string; target: DraftTarget }>()

  const sending = () => {
    let bySync = sendingDrafts.get(sync)
    if (!bySync) sendingDrafts.set(sync, (bySync = new Map()))
    return bySync
  }

  const targetOf = (state: EnvironmentState, draftId: string) =>
    selectDraftTarget(state, draftId) ?? pages?.target(draftId)

  /** The draft a `new:` key writes to now: its own, or its successor while it is sent. */
  const writing = (draftId: string) => {
    const sent = sendingDrafts.get(sync)?.get(draftId)
    if (!sent) return { draftId, fresh: false }
    let next = successors.get(draftId)
    if (!next) {
      next = {
        draftId: mintId(),
        target: { type: 'new_session', workspaceId: sent.workspaceId, sessionId: mintId() },
      }
      successors.set(draftId, next)
    }
    return { draftId: next.draftId, target: next.target, fresh: true }
  }

  const draftIdOf = (key: string) => {
    if (key.startsWith(SESSION_KEY)) return key.slice(SESSION_KEY.length)
    if (!key.startsWith(NEW_SESSION_KEY)) return null
    const draftId = key.slice(NEW_SESSION_KEY.length)
    return successors.get(draftId)?.draftId ?? draftId
  }

  /**
   * Write a change to the draft behind a `session:` or `new:` key. False for
   * any other key, and for a new-session draft with nowhere to go yet.
   */
  const change = (key: string, next: (content: DraftContent | undefined) => DraftContent) => {
    const state = client.getState()
    if (key.startsWith(SESSION_KEY)) {
      const sessionId = key.slice(SESSION_KEY.length)
      const content = selectDraftContent(state, sessionId)
      sync.edit(sessionId, { type: 'session', sessionId }, next(content))
      return true
    }
    if (!key.startsWith(NEW_SESSION_KEY)) return false
    const own = key.slice(NEW_SESSION_KEY.length)
    const { draftId, target: successorTarget, fresh } = writing(own)
    const target = successorTarget ?? targetOf(state, draftId)
    if (!target) return false
    const content = selectDraftContent(state, draftId)
    const changed = next(content)
    const written = changed.text.length > 0 || (changed.artifactIds?.length ?? 0) > 0
    // Picks alone are no draft: nothing is saved before the first text or image.
    if (!content && !written) return true
    // A draft's first save carries the picks made on the page before it.
    const picks = content || fresh ? undefined : pages?.picks(draftId)
    sync.edit(draftId, target, { ...picks, ...changed })
    if (written && !fresh) pages?.claim(own)
    return true
  }

  return {
    getText(key) {
      const draftId = draftIdOf(key)
      if (draftId === null) return loose[key] ?? ''
      return selectDraftContent(client.getState(), draftId)?.text ?? ''
    },
    setText(key, text) {
      if (change(key, (content) => ({ ...content, text }))) return
      if ((loose[key] ?? '') === text) return
      loose = { ...loose, [key]: text }
      for (const listener of [...looseListeners]) listener()
    },
    // A draft's images are uploaded when attached and named in the draft, so
    // they reach every device and outlive a reload (where the environment
    // keeps drafts: a session's draft or a new-session one).
    keepsImages: (key) => key.startsWith(SESSION_KEY) || key.startsWith(NEW_SESSION_KEY),
    getImages(key) {
      const draftId = draftIdOf(key)
      if (draftId === null) return NO_IMAGES
      return selectDraftContent(client.getState(), draftId)?.artifactIds ?? NO_IMAGES
    },
    setImages(key, artifactIds) {
      return change(key, (content) => withImages(content, artifactIds))
    },
    imageTarget(key) {
      const draftId = draftIdOf(key)
      if (draftId === null) return undefined
      const state = client.getState()
      return {
        key,
        draftId,
        deletedAt: state.draftTombstones[draftId] ?? 0,
        existed: selectDraftContent(state, draftId) !== undefined,
      }
    },
    imageTargetLive(target) {
      // The key writes to another draft now: this one is being sent.
      if (draftIdOf(target.key) !== target.draftId) return false
      const state = client.getState()
      if (state.draftEdits[target.draftId]?.launching) return false
      // Sent or deleted since, here or on another device.
      if ((state.draftTombstones[target.draftId] ?? 0) > target.deletedAt) return false
      return !target.existed || selectDraftContent(state, target.draftId) !== undefined
    },
    imageSource(key, artifactId) {
      if (key.startsWith(SESSION_KEY)) {
        return { sessionId: key.slice(SESSION_KEY.length), artifactId }
      }
      const draftId = draftIdOf(key)
      return draftId === null ? undefined : { draftId, artifactId }
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
    claim(key) {
      if (key.startsWith(NEW_SESSION_KEY)) pages?.claim(key.slice(NEW_SESSION_KEY.length))
    },
    getSyncStatus(key) {
      const draftId = draftIdOf(key)
      // Held for this page only, with nothing to sync it to.
      if (draftId === null) return 'synced'
      return selectDraftSyncStatus(client.getState(), draftId)
    },
    beginSend(key, sentText, sentImages) {
      if (!key.startsWith(NEW_SESSION_KEY)) return undefined
      const draftId = key.slice(NEW_SESSION_KEY.length)
      const state = client.getState()
      const target = targetOf(state, draftId)
      if (target?.type !== 'new_session') return undefined
      // Held from here, not from `session.create`: images upload first, and
      // what is typed meanwhile must go to the next draft, not this one. A
      // draft with nothing saved yet (images alone) is held too, so the send
      // still takes the session id minted with it.
      const slot: SendingDraft = {
        draftId,
        sessionId: target.sessionId,
        workspaceId: target.workspaceId,
      }
      const bySync = sending()
      bySync.delete(draftId)
      bySync.set(draftId, slot)
      // The composer emptied the draft before this; what was sent is what it
      // held then: the text and images given, with everything else it still holds.
      const held = selectDraftContent(state, draftId)
      sync.beginLaunch(
        draftId,
        sentText !== undefined
          ? withImages({ ...held, text: sentText }, sentImages ?? held?.artifactIds ?? NO_IMAGES)
          : undefined,
      )
      return () => {
        if (bySync.get(draftId) === slot) bySync.delete(draftId)
        successors.delete(draftId)
        // A launch that ran has already settled the draft; this only puts
        // back one whose send stopped before it (a failed upload).
        sync.endLaunch(draftId, 'aborted')
      }
    },
  }
}

/**
 * Brings this browser's old localStorage drafts into the environment once
 * their session or project is known here, then forgets them. A project's old
 * landing text becomes a draft of its own, kept like any other. A key for a
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
    } else if (key.startsWith(LEGACY_PROJECT_KEY)) {
      const workspaceId = key.slice(LEGACY_PROJECT_KEY.length)
      if (!state.workspaces[workspaceId]) continue
      sync.edit(mintId(), newSessionTarget(workspaceId), { text })
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
  const page = useContext(DraftPageContext)
  const picks = useContext(DraftPicksContext)
  // The store outlives renders; it reads the page's latest through these.
  const pageRef = useRef<DraftPageInternals | null>(page)
  pageRef.current = page
  const picksRef = useRef(picks)
  picksRef.current = picks
  const store = useMemo(
    () =>
      sync
        ? createEnvironmentComposerDraftStore(client, sync, {
            target: (draftId) => pageRef.current?.pageTarget(draftId),
            picks: (draftId) => picksRef.current?.(draftId),
            claim: (draftId) => pageRef.current?.claim(draftId),
          })
        : null,
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
