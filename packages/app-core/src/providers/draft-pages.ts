import { createContext } from 'react'
import type { WorkspaceComposerPreference } from '@openmanager/shared/contracts/composer-profile'
import { browserStorage } from '../lib/browser-device'
import type { DeviceStorage } from './device-host'

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

/**
 * Internal to the environment providers: moving between draft pages, for the
 * sidebar's draft cards. Served only where the environment keeps drafts and
 * the host gives each one an address; elsewhere the cards do not show.
 */
export interface DraftPageNavigation {
  /** Go to a draft's own page, as it was left. */
  openDraftPage: (draftId: string) => void
  /** The draft is going: if it is on screen, a blank page takes its place. */
  closeDraftPage: (draftId: string) => void
}

export const DraftPageNavigationContext = createContext<DraftPageNavigation | null>(null)

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

/**
 * A sent draft's entry, by its environment as well: a server restored from a
 * copy of another's database holds the same draft ids. Entries from before
 * environments were part of it are under the draft id alone.
 */
function sentKey(environmentId: string | null | undefined, draftId: string): string {
  return JSON.stringify([environmentId ?? null, draftId])
}

/** The draft id of an entry kept by environment; undefined for one from before. */
function sentDraftIdOf(key: string): string | undefined {
  if (!key.startsWith('[')) return undefined
  try {
    const parsed: unknown = JSON.parse(key)
    return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : undefined
  } catch {
    return undefined
  }
}

function readSent(storage: DeviceStorage | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(SENT_DRAFTS_KEY) ?? '{}')
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

function writeSent(sent: Record<string, string>, storage: DeviceStorage | null) {
  const keys = Object.keys(sent)
  for (const id of keys.slice(0, Math.max(0, keys.length - SENT_DRAFTS_LIMIT))) delete sent[id]
  try {
    storage?.setItem(SENT_DRAFTS_KEY, JSON.stringify(sent))
  } catch {
    // Private mode or a full quota: the address falls back to a blank page.
  }
}

/**
 * Remember that a draft sent from this browser became `sessionId`, so its old
 * address leads to the session. The environment forgets a sent draft, and
 * nothing it lists ties the two together.
 */
export function rememberSentDraft(
  environmentId: string | null | undefined,
  draftId: string,
  sessionId: string,
  storage: DeviceStorage | null = browserStorage(),
) {
  const key = sentKey(environmentId, draftId)
  sentHere.set(key, sessionId)
  const sent = readSent(storage)
  delete sent[key]
  // An entry from before environments counted, for this same send, is this one.
  if (sent[draftId] === sessionId) delete sent[draftId]
  sent[key] = sessionId
  writeSent(sent, storage)
}

/**
 * The session a draft sent from this browser became, if it remembers one:
 * sent in this environment, or before environments counted, or failing those
 * in another environment, whose session's address then leads there.
 */
export function sentDraftSession(
  environmentId: string | null | undefined,
  draftId: string,
  storage: DeviceStorage | null = browserStorage(),
): string | undefined {
  const sent = { ...readSent(storage), ...Object.fromEntries(sentHere) }
  const here = sent[sentKey(environmentId, draftId)] ?? sent[draftId]
  if (here !== undefined) return here
  // The latest send of that draft id anywhere else.
  return Object.entries(sent)
    .reverse()
    .find(([key]) => sentDraftIdOf(key) === draftId)?.[1]
}

/**
 * An address followed by an entry from before environments counted: keep it
 * by this environment from now on. Does nothing for any other entry.
 */
export function keepSentDraftHere(
  environmentId: string | null | undefined,
  draftId: string,
  storage: DeviceStorage | null = browserStorage(),
) {
  const key = sentKey(environmentId, draftId)
  const sent = readSent(storage)
  const sessionId = sent[draftId]
  if (sessionId === undefined || key in sent || sentHere.has(key)) return
  delete sent[draftId]
  sent[key] = sessionId
  writeSent(sent, storage)
}

const LANDING_PROJECTS_KEY = 'openmanager.landing-projects'

function readLandingProjects(storage: DeviceStorage | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(LANDING_PROJECTS_KEY) ?? '{}')
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
 * Remember the project the user last picked on a new-session page in an
 * environment, so the next blank page there opens in it. Kept on this device
 * only: project ids mean nothing on another environment.
 */
export function rememberLandingProject(
  environmentId: string,
  workspaceId: string,
  storage: DeviceStorage | null = browserStorage(),
) {
  const picked = readLandingProjects(storage)
  if (picked[environmentId] === workspaceId) return
  picked[environmentId] = workspaceId
  try {
    storage?.setItem(LANDING_PROJECTS_KEY, JSON.stringify(picked))
  } catch {
    // Private mode or a full quota: the page opens on the most recent project.
  }
}

/** The project last picked on a new-session page in that environment, if any. */
export function rememberedLandingProject(
  environmentId: string | null | undefined,
  storage: DeviceStorage | null = browserStorage(),
): string | null {
  return environmentId ? (readLandingProjects(storage)[environmentId] ?? null) : null
}

/** The draft is back (its session was rolled back): its address is its own again. */
export function forgetSentDraft(
  environmentId: string | null | undefined,
  draftId: string,
  sessionId: string,
  storage: DeviceStorage | null = browserStorage(),
) {
  const key = sentKey(environmentId, draftId)
  sentHere.delete(key)
  const sent = readSent(storage)
  // An entry from before environments counted goes only if it is this same send.
  const legacy = sent[draftId] === sessionId
  if (!(key in sent) && !legacy) return
  delete sent[key]
  if (legacy) delete sent[draftId]
  try {
    storage?.setItem(SENT_DRAFTS_KEY, JSON.stringify(sent))
  } catch {
    // Private mode or a full quota: this tab has forgotten it all the same.
  }
}
