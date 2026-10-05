import { createContext } from 'react'
import type { WorkspaceComposerPreference } from '@openmanager/shared/contracts/composer-profile'

/** Where a new-session draft goes: its project (none once that was removed)
 * and the id its session will get. */
export interface DraftPageTarget {
  type: 'new_session'
  workspaceId: string | null
  sessionId: string
}

/**
 * Internal to the environment providers: the new-session draft a page shows.
 * Session state owns it; the composer's draft store and the composer read it.
 */
export interface DraftPageInternals {
  /** The draft on screen, whether or not the environment has it yet. */
  pageDraftId: string | null
  /**
   * Where a draft this page started belongs, for one the environment does
   * not have yet: a blank page's, or one given an address by an image alone.
   */
  pageTarget: (draftId: string) => DraftPageTarget | undefined
  /**
   * The draft got its first text or image: it is a draft now, with its own
   * address. Does nothing for a draft that already has one, or is not on screen.
   */
  claim: (draftId: string) => void
}

export const DraftPageContext = createContext<DraftPageInternals | null>(null)

/** The picks a draft holds before it is saved; the composer keeps them. */
export type DraftPagePicks = (
  draftId: string,
) => { providerId?: string; preference?: WorkspaceComposerPreference } | undefined

/** Internal to the environment providers: the composer's picks, for a draft's first save. */
export const DraftPicksContext = createContext<DraftPagePicks | null>(null)

const SENT_DRAFTS_KEY = 'openmanager.sent-drafts'
/** Enough for any address still in a tab's history or a recent bookmark. */
const SENT_DRAFTS_LIMIT = 100
// This tab's own sends, for a browser whose storage is unavailable.
const sentHere = new Map<string, string>()

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readSent(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(SENT_DRAFTS_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string'
      }),
    )
  } catch {
    return {}
  }
}

/**
 * Remember that a draft sent from this browser became `sessionId`, so its old
 * address leads to the session. The environment forgets a sent draft, and
 * nothing it lists ties the two together.
 */
export function rememberSentDraft(draftId: string, sessionId: string) {
  sentHere.set(draftId, sessionId)
  const sent = readSent()
  delete sent[draftId]
  sent[draftId] = sessionId
  const ids = Object.keys(sent)
  for (const id of ids.slice(0, Math.max(0, ids.length - SENT_DRAFTS_LIMIT))) delete sent[id]
  try {
    storage()?.setItem(SENT_DRAFTS_KEY, JSON.stringify(sent))
  } catch {
    // Private mode or a full quota: the address falls back to a blank page.
  }
}

/** The session a draft sent from this browser became, if it remembers one. */
export function sentDraftSession(draftId: string): string | undefined {
  return sentHere.get(draftId) ?? readSent()[draftId]
}
