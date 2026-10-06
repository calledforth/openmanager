import { createContext, useContext, useRef } from 'react'
import type { DraftSyncStatus } from '@openmanager/environment-client'
import type { ArtifactSource } from '../../lib/attachments'
import {
  pruneComposerDrafts,
  readComposerDrafts,
  writeComposerDrafts,
  type PersistedDraft,
} from './composerDrafts'

/**
 * Where the composer keeps unsent text, by draft key (`session:<id>`,
 * `new:<draftId>` where drafts have ids, `draft:<workspaceId>` where a
 * project has one, or anything a story picks). Reads are synchronous so
 * a restored draft is on screen at first paint. A store that keeps images
 * (`keepsImages`) holds a draft's uploaded images by artifact id, so they
 * outlive the composer; elsewhere they stay with the composer that holds
 * their `File`s and upload when sent.
 */
export interface ComposerDraftStore {
  getText(key: string): string
  setText(key: string, text: string): void
  /**
   * Whether the draft behind `key` keeps its images: they are uploaded when
   * attached and named here, with `getImages`/`setImages`/`imageSource`.
   */
  keepsImages?(key: string): boolean
  /** The draft's uploaded images, in order; the same array until they change. */
  getImages?(key: string): readonly string[]
  setImages?(key: string, artifactIds: readonly string[]): void
  /** Where the bytes of one of the draft's images are read from. */
  imageSource?(key: string, artifactId: string): ArtifactSource | undefined
  /** Fires when any draft may have changed, here or (for a synced store) elsewhere. */
  subscribe(listener: () => void): () => void
  /** Write anything waiting now: the composer is going away or the page is hidden. */
  flush(): void
  /**
   * Something other than text (an image) was added to the draft behind
   * `key`: for stores whose drafts start blank and unsaved, it is a draft
   * now. Typing says so through `setText`.
   */
  claim?(key: string): void
  /**
   * Set the draft behind `key` aside for a send that is starting, after the
   * composer has been cleared for it. `sentText` and `sentImages` are what is
   * being sent, as the draft held them before the clear, so what shows the
   * draft meanwhile (its sidebar card) shows what went. Anything typed until
   * the returned release is called goes to a new draft. Call the release when
   * the send settles, before putting back the text of a failed one.
   */
  beginSend?(
    key: string,
    sentText?: string,
    sentImages?: readonly string[],
  ): (() => void) | undefined
  /**
   * Whether the draft behind `key` has reached where drafts are kept, for
   * stores that sync them; read again whenever `subscribe` fires. A store
   * without it keeps every draft where it is written.
   */
  getSyncStatus?(key: string): DraftSyncStatus
}

/** Supplied by hosts that keep drafts somewhere better than this browser. */
export const ComposerDraftStoreContext = createContext<ComposerDraftStore | null>(null)

/** The host's store, or one over this browser's localStorage for the composer's lifetime. */
export function useComposerDraftStore(): ComposerDraftStore {
  const provided = useContext(ComposerDraftStoreContext)
  const local = useRef<ComposerDraftStore | null>(null)
  if (provided) return provided
  return (local.current ??= createLocalComposerDraftStore())
}

/** Long enough that typing doesn't hit storage on every keystroke, short enough
 * that a crash costs at most a word. Exit handlers cover the rest. */
const DRAFT_PERSIST_DEBOUNCE_MS = 400

/**
 * Drafts in this browser's localStorage, text only, for hosts with no
 * environment that keeps them. Every instance reads storage when created.
 */
export function createLocalComposerDraftStore(): ComposerDraftStore {
  let texts: Record<string, string> = {}
  // Last snapshot written to storage, so an unchanged draft keeps its original
  // `updatedAt` and the eviction order stays a real recency order.
  let persisted: Record<string, PersistedDraft> = readComposerDrafts()
  for (const [key, draft] of Object.entries(persisted)) texts[key] = draft.text
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const persist = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const now = Date.now()
    const next: Record<string, PersistedDraft> = {}
    for (const [key, text] of Object.entries(texts)) {
      if (!text.trim()) continue
      const previous = persisted[key]
      next[key] = { text, updatedAt: previous?.text === text ? previous.updatedAt : now }
    }
    persisted = pruneComposerDrafts(next)
    writeComposerDrafts(persisted)
  }

  return {
    getText: (key) => texts[key] ?? '',
    setText(key, text) {
      if ((texts[key] ?? '') === text) return
      texts = { ...texts, [key]: text }
      for (const listener of [...listeners]) listener()
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(persist, DRAFT_PERSIST_DEBOUNCE_MS)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    flush: persist,
  }
}
